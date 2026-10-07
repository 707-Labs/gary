// Opt-in paid validation. No service config, real repositories, or external adapters.
// Run --self-test first. --run-approved requires explicit operator authorization.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { GLMClient } from "../src/adapters/glm.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createDeadline } from "../src/deadline.ts";
import type { Executor } from "../src/executors/index.ts";
import { createProvider, createProviderChain } from "../src/providers.ts";

const ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const MODEL = "deepseek-v4-pro";
const CAP_USD = 0.25;
const INPUT_RESERVATION = 16_666; // At most 99,996 across six calls.
const OUTPUT_LIMIT = 2_048;
const INPUT_USD_PER_MILLION = 1.32;
const OUTPUT_USD_PER_MILLION = 3.96;
const cost = (input: number, output: number) =>
  (input * INPUT_USD_PER_MILLION + output * OUTPUT_USD_PER_MILLION) / 1_000_000;
const REQUEST_RESERVATION_USD = cost(INPUT_RESERVATION, OUTPUT_LIMIT);
const ALLOWED = new Set(["read_file", "write_file", "run_bash", "finish", "report_blocked"]);
const INITIAL = "export const value = 0;\n";
const EXPECTED = "export const value = 42;\n";
const SYSTEM = `Work only on the synthetic task with the provided tools. Verify changes before calling finish. If a required dependency is unavailable or checks cannot pass, call report_blocked with the evidence. Never claim success for blocked work. You may request sequential tool calls in one response. Do not commit, install dependencies, or use unlisted tools.`;

type Fixture = "success" | "blocked";
type CallRecord = {
  fixture: Fixture;
  call: number;
  requestBytes: number;
  reservedUsd: number;
  startedAt: string;
  elapsedMs?: number;
  httpStatus?: number;
  usage?: Record<string, unknown>;
  estimatedPeakUsd?: number;
  tools?: { name: string; input: unknown }[];
  stopReason?: string | null;
  error?: string;
};

function validateRequest(url: string, body: Record<string, unknown>, bodyText: string): void {
  assert.equal(url, ENDPOINT, "unexpected API destination");
  assert.equal(body.model, MODEL, "unexpected model");
  assert.equal(body.max_tokens, OUTPUT_LIMIT, "unexpected output limit");
  assert.notEqual(body.stream, true, "streaming is forbidden");
  // UTF-8 byte count is deliberately pessimistic; reserve another 4096 for framing.
  assert.ok(Buffer.byteLength(bodyText) + 4096 <= INPUT_RESERVATION, "input reservation exceeded");
  const toolNames = (body.tools as { name: string }[]).map((tool) => tool.name);
  assert.equal(toolNames.length, ALLOWED.size);
  assert.ok(toolNames.every((name) => ALLOWED.has(name)), "unexpected advertised tool");
}

function apiKey(): string {
  let key = process.env.DEEPSEEK_API_KEY;
  // Read only this key; do not load unrelated production credentials into the process.
  for (const path of ["/Users/tanner/Developer/gary/.env", "/Users/tanner/Developer/gary/.env.local"]) {
    if (!existsSync(path)) continue;
    const line = readFileSync(path, "utf8").split(/\r?\n/)
      .find((value) => /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=/.test(value));
    if (!line) continue;
    const raw = line.slice(line.indexOf("=") + 1).trim();
    key = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, raw.lastIndexOf(raw[0]!)) : raw.split(/\s+#/)[0];
  }
  assert.ok(key && key.length > 0 && !key.includes("$"), "DeepSeek credential unavailable or needs expansion");
  return key;
}

async function main(): Promise<void> {
  delete process.env.DEBUG; // The SDK's debug mode can print authentication headers.
  const selfTest = process.argv.includes("--self-test");
  assert.ok(selfTest || process.argv.includes("--run-approved"), "explicit mode required");
  const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
  assert.ok(outputArg, "explicit output path required");
  const outputPath = resolve(outputArg.slice("--output=".length));
  assert.ok(!existsSync(outputPath), "refusing to overwrite evidence or rerun into the same ledger");
  const resumeArg = process.argv.find((arg) => arg.startsWith("--resume-ledger="));
  const resumePath = resumeArg ? resolve(resumeArg.slice("--resume-ledger=".length)) : undefined;
  const prior = resumePath ? JSON.parse(readFileSync(resumePath, "utf8")) as Record<string, any> : undefined;
  if (prior) {
    // Support only the explicitly authorized retry of the single DNS-failed attempt.
    assert.equal(prior.mode, "approved-paid-validation");
    assert.equal(prior.endpoint, ENDPOINT);
    assert.equal(prior.model, MODEL);
    assert.equal(prior.capUsd, CAP_USD);
    assert.equal(prior.maximumCalls, 6);
    assert.equal(prior.maximumCallsPerFixture, 3);
    assert.equal(prior.maximumOutputTokensPerCall, OUTPUT_LIMIT);
    assert.equal(prior.inputPeakUsdPerMillion, INPUT_USD_PER_MILLION);
    assert.equal(prior.outputPeakUsdPerMillion, OUTPUT_USD_PER_MILLION);
    assert.equal(prior.resumedFrom, undefined, "resume-of-resume forbidden");
    assert.notEqual(prior.passed, true);
    assert.equal(prior.calls.length, 1);
    assert.equal(prior.calls[0].call, 1);
    assert.equal(prior.calls[0].fixture, "success");
    assert.equal(prior.calls[0].httpStatus, undefined);
    assert.equal(prior.calls[0].usage, undefined);
    assert.equal(prior.calls[0].reservedUsd, REQUEST_RESERVATION_USD);
    assert.equal(prior.reservedUsd, REQUEST_RESERVATION_USD);
    assert.equal(prior.fixtures.length, 1);
    assert.equal(prior.fixtures[0].result.status, "error");
    assert.deepEqual(prior.fixtures[0].commands, []);
    assert.deepEqual(prior.fixtures[0].result.runLog, []);
    assert.ok(Number.isSafeInteger(prior.fixtures[0].elapsedMs) && prior.fixtures[0].elapsedMs >= 0);
  }
  const calls: CallRecord[] = [];
  if (prior) calls.push(...prior.calls);
  const fixtures: Record<string, unknown>[] = [];
  let fixture: Fixture = "success";
  let fixtureCalls = 0;
  let reservedUsd = calls.reduce((sum, call) => sum + call.reservedUsd, 0);
  let invocationFixtureCalls = 0;
  let fatal = false;
  const report: Record<string, unknown> = {
    passed: false,
    mode: selfTest ? "offline-self-test" : "approved-paid-validation",
    startedAt: new Date().toISOString(), endpoint: ENDPOINT, model: MODEL,
    capUsd: CAP_USD, maximumCalls: 6, maximumCallsPerFixture: 3,
    maximumOutputTokensPerCall: OUTPUT_LIMIT, fixtureTimeoutMs: 90_000,
    pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/",
    pricingChecked: "2026-10-07", inputPeakUsdPerMillion: INPUT_USD_PER_MILLION,
    outputPeakUsdPerMillion: OUTPUT_USD_PER_MILLION,
    ...(prior ? { resumedFrom: resumePath, previousFixtures: prior.fixtures,
      retryReason: "Explicitly authorized retry through approved network escalation after sandbox DNS failure" } : {}),
    calls, fixtures,
  };
  const save = () => writeFileSync(outputPath, JSON.stringify({
    ...report, reservedUsd,
    accountedPeakEstimateUsd: calls.reduce((sum, call) => sum + (call.estimatedPeakUsd ?? 0), 0),
    unaccountedCalls: calls.filter((call) => !call.usage).length,
  }, null, 2) + "\n", { mode: 0o600 });
  if (resumePath && !selfTest) {
    writeFileSync(`${resumePath}.resume-claim`, outputPath + "\n", { mode: 0o600, flag: "wx" });
  }
  save();
  const fail = (message: string): never => { fatal = true; throw new Error(message); };
  const nativeFetch = globalThis.fetch;
  const transport = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (fatal) fail("prior validation failure");
    assert.equal(typeof init?.body, "string", "unexpected request serialization");
    const bodyText = init!.body as string;
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const url = input instanceof Request ? input.url : String(input);
    validateRequest(url, body, bodyText);
    assert.equal(init?.method, "post", "unexpected HTTP method");
    const retryCount = new Headers(init?.headers).get("x-stainless-retry-count");
    assert.ok(retryCount === null || retryCount === "0", "SDK retry forbidden");
    if (calls.length >= 6 || fixtureCalls >= 3) fail("call limit reached");
    if (reservedUsd + REQUEST_RESERVATION_USD > CAP_USD) fail("spend reservation exhausted");
    reservedUsd += REQUEST_RESERVATION_USD; // Never refund reservations, even on error.
    fixtureCalls++;
    invocationFixtureCalls++;
    const record: CallRecord = { fixture, call: calls.length + 1,
      requestBytes: Buffer.byteLength(bodyText), reservedUsd: REQUEST_RESERVATION_USD,
      startedAt: new Date().toISOString() };
    calls.push(record);
    save(); // Durable ledger before a potentially billable request.
    const started = Date.now();
    try {
      let response: Response;
      if (selfTest) {
        const write = { name: "write_file", input: { path: "value.ts", content: EXPECTED } };
        const check = { name: "run_bash", input: { command: "fixture-check" } };
        const finish = { name: "finish", input: { summary: "Changed value to 42 and verified." } };
        const blocked = { name: "report_blocked", input: { reason: "fixture-dependency unavailable; fixture-check exited 1." } };
        const tools = fixture === "success"
          ? (prior ? [[write, check], [finish]] : [[write], [check], [finish]])[invocationFixtureCalls - 1]!
          : [[check], [blocked]][invocationFixtureCalls - 1]!;
        response = new Response(JSON.stringify({
          id: `synthetic-${calls.length}`, type: "message", role: "assistant", model: MODEL,
          content: tools.map((tool, index) => ({ type: "tool_use", id: `tool-${calls.length}-${index}`, ...tool })),
          stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      } else {
        response = await nativeFetch(input, { ...init, redirect: "error" });
      }
      record.httpStatus = response.status;
      if (!response.ok) fail(`provider HTTP ${response.status}; no retry permitted`);
      const message = await response.clone().json() as Anthropic.Message;
      const usage = message.usage as unknown as Record<string, unknown>;
      const numeric = (name: string, required = false): number => {
        const value = usage?.[name];
        if (!required && (value === undefined || value === null)) return 0;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("missing or invalid usage accounting");
        return value as number;
      };
      const inputTokens = numeric("input_tokens", true) + numeric("cache_creation_input_tokens") + numeric("cache_read_input_tokens");
      const outputTokens = numeric("output_tokens", true);
      record.usage = usage;
      record.estimatedPeakUsd = cost(inputTokens, outputTokens);
      if (inputTokens > INPUT_RESERVATION || outputTokens > OUTPUT_LIMIT) fail("provider exceeded reserved token bounds");
      record.stopReason = message.stop_reason;
      record.tools = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map(({ name, input }) => ({ name, input }));
      if (record.tools.some((tool) => !ALLOWED.has(tool.name))) fail("unexpected tool behavior");
      return response;
    } catch (error) {
      fatal = true;
      // Do not copy provider error bodies or request headers into logs.
      record.error = error instanceof Error ? error.name : "transport error";
      const code = (error as { code?: unknown })?.code;
      if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) record.error += ` (${code})`;
      throw new Error("validation transport failed; no retry permitted");
    } finally {
      record.elapsedMs = Date.now() - started;
      save();
    }
  }) as typeof fetch;

  const provider = createProvider({ name: "deepseek", apiKey: selfTest ? "offline" : apiKey(),
    baseUrl: "https://api.deepseek.com/anthropic", model: MODEL, defaultBackoffMs: 60_000 }, { fetch: transport });
  // Both constructor default and per-request options disable hidden retries.
  provider.client.maxRetries = 0;
  const glm = new GLMClient(createProviderChain([provider]));
  try {
    for (const name of ["success", "blocked"] as const) {
      fixture = name;
      fixtureCalls = calls.filter((call) => call.fixture === name).length;
      invocationFixtureCalls = 0;
      const remainingCalls = Math.min(3 - fixtureCalls, 6 - calls.length);
      const remainingTimeMs = 90_000 - (prior && name === "success" ? prior.fixtures[0].elapsedMs : 0);
      assert.ok(remainingCalls > 0 && remainingTimeMs > 0, "previous attempts consumed fixture budget");
      const files = new Map([["value.ts", INITIAL]]);
      const commands: { command: string; exit: number }[] = [];
      const executor: Executor = {
        workspaceRoot: "/synthetic-in-memory",
        async readFile(path) { if (path !== "value.ts") fail("unexpected read"); return files.get(path)!; },
        async writeFile(path, content) {
          if (name !== "success" || path !== "value.ts" || content.trim() !== EXPECTED.trim()) fail("unexpected write");
          files.set(path, content);
        },
        async listFiles() { return fail("unexpected list operation"); },
        async grep() { return fail("unexpected grep operation"); },
        async run(command) {
          if (command !== "fixture-check") fail("unexpected command");
          const exit = name === "blocked" || files.get("value.ts")?.trim() !== EXPECTED.trim() ? 1 : 0;
          commands.push({ command, exit });
          return { stdout: exit === 0 ? "PASS: value is 42" : "", stderr: name === "blocked"
            ? "fixture-dependency unavailable; cannot install in this fixture" : exit ? "FAIL: expected value 42" : "",
          exitCode: exit, timedOut: false };
        },
      };
      const budget = createDeadline({ timeoutMs: remainingTimeMs });
      const started = Date.now();
      try {
        const result = await runAgentLoop({ glm, executor,
          systemPrompt: `${SYSTEM} You have at most ${remainingCalls} model turns. When changing the file, request write_file and run_bash together in that order, then finish in the next turn after seeing the check result.`,
          task: name === "success"
            ? `Synthetic file value.ts currently contains: ${INITIAL}Change only its exported value to 42. Write the file, run the exact command fixture-check, then call finish only after the check passes.`
            : "Run the exact command fixture-check to test the required fixture-dependency. If unavailable, report the blocker and evidence using report_blocked; do not claim completion or attempt installation.",
          maxIterations: remainingCalls, maxTokensPerTurn: OUTPUT_LIMIT, temperature: 0.1,
          timeoutMs: remainingTimeMs, deadlineMs: budget.deadlineMs, signal: budget.signal,
          disableSubagent: true, finishGateCommand: "fixture-check",
          phases: [{ name: "synthetic", maxIter: remainingCalls, allowedTools: ALLOWED }],
        });
        const passed = !fatal && (name === "success"
          ? result.status === "finished" && files.get("value.ts")?.trim() === EXPECTED.trim() && commands.some((cmd) => cmd.exit === 0)
          : result.status === "blocked" && commands.some((cmd) => cmd.exit === 1) && files.get("value.ts") === INITIAL);
        fixtures.push({ name, passed, elapsedMs: Date.now() - started, result, commands,
          newCalls: invocationFixtureCalls, cumulativeCalls: fixtureCalls });
        save();
        console.log(JSON.stringify({ fixture: name, passed, status: result.status, calls: fixtureCalls }));
        if (!passed) fail("fixture failed; do not rerun automatically");
      } finally { budget.dispose(); }
    }
    report.passed = true;
  } finally {
    report.completedAt = new Date().toISOString();
    save();
  }
}

await main();
