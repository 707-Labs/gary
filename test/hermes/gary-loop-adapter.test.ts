import { afterEach, expect, test } from "bun:test";
import {
  createGaryLoopAdapter, SINGLE_PHASE_LIMITATIONS,
  type GaryRuntimeLauncher, type GaryRuntimeManifest, type NativeRuntimeOutcome,
  type RuntimeRequestHandler,
} from "../../src/hermes/gary-loop-adapter.ts";
import type { SessionOptions } from "../../src/hermes/session-host.ts";
import type { AgentLoopArgs } from "../../src/agent/loop.ts";
import type { Executor } from "../../src/executors/index.ts";
import { SpendLedger } from "../../src/spend.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const TOKEN = "fixture-local-capability-0000000000000000";
const BASE = "http://127.0.0.1:13123/";
const result = (manifest: Readonly<GaryRuntimeManifest>, status: NativeRuntimeOutcome["status"] = "finished"): NativeRuntimeOutcome => ({
  taskId: manifest.taskId, requestId: manifest.requestId, status, publicationApproved: false,
  // These untrusted values must never become the host's usage/iteration evidence.
  iterations: 12345, modelAttempts: 12345, text: "Untrusted success claim",
});
function request(path: string, body: unknown, token = TOKEN): Request {
  return new Request(new URL(path, BASE), { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
}
function modelRequest(manifest: Readonly<GaryRuntimeManifest>, overrides: Record<string, unknown> = {}): Request {
  return request("/v1/chat/completions", { model: manifest.model,
    messages: [{ role: "system", content: manifest.systemPrompt }, { role: "user", content: manifest.prompt }],
    tools: manifest.tools, max_tokens: manifest.maxTokens, temperature: manifest.temperature,
    stream: false, ...overrides });
}
function tool(handle: RuntimeRequestHandler, manifest: Readonly<GaryRuntimeManifest>, name: string,
    args: Record<string, unknown>, callId = name): Promise<Response> {
  return handle(request("/tools/execute", { taskId: manifest.taskId, ownerEpoch: manifest.ownerEpoch,
    token: manifest.capability, callId, name, arguments: args }));
}
function fixture() {
  // This is the actual vendored Gary ledger/toolset, with isolated memory state.
  const ledger = new SpendLedger(":memory:"); cleanup.push(() => ledger.close());
  ledger.createCampaign("offline-fixture", 10);
  ledger.enrollTicket("offline-fixture", "TICKET-1", 5, { draftPr: true });
  let epoch = "owner-1", admitted = true, legacyModelAccesses = 0;
  const upstream: Request[] = [], commands: string[] = [];
  const files = new Map<string, string>([["README.md", "fixture contents"]]);
  let checkExit = 0;
  const executor: Executor = {
    workspaceRoot: "/offline-fixture",
    readFile: async path => { if (!files.has(path)) throw new Error("not found"); return files.get(path)!; },
    writeFile: async (path, content) => { files.set(path, content); },
    listFiles: async () => [...files.keys()], grep: async () => [],
    run: async command => { commands.push(command); return { stdout: "fixture check", stderr: "",
      exitCode: checkExit, timedOut: false }; },
  };
  const host: SessionOptions = {
    admission: { taskId: "task-1", requestId: "request-1", ticketId: "TICKET-1", actionId: "action-1",
      fingerprint: "fingerprint-1", ownerEpoch: epoch, deadlineMs: Date.now() + 5000 },
    capabilityToken: TOKEN, ledger, provider: "deepseek", model: "deepseek-v4-pro",
    providerApiKey: "offline-upstream-key", currentOwnerEpoch: () => epoch,
    assertAdmission: current => {
      if (!admitted || current.actionId !== "action-1" || current.fingerprint !== "fingerprint-1") throw new Error("revoked");
    },
    fetch: async req => {
      upstream.push(req);
      return Response.json({ id: "offline-receipt", type: "message", role: "assistant", model: "deepseek-v4-pro",
        content: [{ type: "text", text: "Model prose says it is finished." }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    },
    executor, allowedTools: ["read_file", "write_file", "run_bash", "finish", "report_blocked"],
    finishGateCommand: "bun run check",
  };
  const args: AgentLoopArgs = {
    glm: new Proxy({}, { get() { legacyModelAccesses++; throw new Error("legacy model must not run"); } }) as AgentLoopArgs["glm"],
    executor, systemPrompt: "You are Gary. Preserve the approved task scope.", task: "Verify the admitted fixture task.",
    maxIterations: 4, maxTokensPerTurn: 128, temperature: 0.3, timeoutMs: 3000,
    disableSubagent: true, finishGateCommand: "bun run check",
  };
  return { ledger, host, args, upstream, commands, files,
    adapter: (launch: GaryRuntimeLauncher, baseUrl = BASE) => createGaryLoopAdapter({ hostOptions: host, baseUrl, launch }),
    changeOwner: () => { epoch = "owner-2"; }, revoke: () => { admitted = false; },
    failCheck: () => { checkExit = 1; }, legacyModelAccesses: () => legacyModelAccesses };
}

test("single-phase seam uses the guarded route, real ledger and Gary check/finish tools", async () => {
  const f = fixture(); let captured: Readonly<GaryRuntimeManifest> | undefined;
  const run = f.adapter(async (manifest, handle, signal) => {
    captured = manifest; expect(signal.aborted).toBe(false);
    const response = await handle(modelRequest(manifest));
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("Model prose says it is finished.");
    expect((await tool(handle, manifest, "run_bash", { command: "bun run check" })).status).toBe(200);
    expect((await tool(handle, manifest, "finish", { summary: "Fixture check passed" })).status).toBe(200);
    return result(manifest);
  });
  expect(f.upstream).toHaveLength(0); // Construction has no listener, launch or model side effect.
  const outcome = await run(f.args);
  expect(outcome.status).toBe("finished"); expect(outcome.summary).toBe("Fixture check passed");
  expect(outcome.iterations).toBe(1); expect(outcome.phase).toBe("single");
  expect(outcome.runLog.map(entry => entry.cmd)).toEqual(["bun run check"]);
  expect(outcome.publicationApproved).toBe(false);
  expect(outcome.usageSource).toBe("unavailable-use-spend-ledger");
  expect(outcome.inputTokens).toBe(0); expect(outcome.outputTokens).toBe(0);
  expect(outcome.parityLimitations).toEqual(SINGLE_PHASE_LIMITATIONS);
  expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(1);
  expect(f.ledger.status("TICKET-1")!.unknownAttempts).toBe(0);
  expect(f.ledger.status("TICKET-1")!.chargedMicros).toBeGreaterThan(0);
  expect(f.upstream).toHaveLength(1);
  expect(f.upstream[0]!.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
  expect(f.upstream[0]!.headers.get("authorization")).toBe("Bearer offline-upstream-key");
  expect((await f.upstream[0]!.json()).max_tokens).toBe(128);
  expect(captured!.prompt).toBe(f.args.task); expect(captured!.systemPrompt).toBe(f.args.systemPrompt);
  expect(captured!.tools.map(def => def.function.name)).toEqual([...f.host.allowedTools]);
  expect(JSON.stringify(captured)).not.toContain("offline-upstream-key");
  expect(Object.isFrozen(captured)).toBe(true); expect(f.legacyModelAccesses()).toBe(0);
});

test("native success and model prose cannot bypass trusted finish state", async () => {
  for (const mode of ["no_tools", "early_finish", "check_only", "failed_check"] as const) {
    const f = fixture(); if (mode === "failed_check") f.failCheck();
    const outcome = await f.adapter(async (manifest, handle) => {
      expect((await handle(modelRequest(manifest))).status).toBe(200);
      if (mode === "early_finish") expect((await tool(handle, manifest, "finish", { summary: "fake success" })).status).toBe(400);
      if (mode === "check_only" || mode === "failed_check") await tool(handle, manifest, "run_bash", { command: "bun run check" });
      if (mode === "failed_check") expect((await tool(handle, manifest, "finish", { summary: "fake success" })).status).toBe(400);
      return result(manifest);
    })(f.args);
    expect(outcome.status).toBe("no_finish"); expect(outcome.summary).toBeNull(); expect(outcome.publicationApproved).toBe(false);
  }
});

test("a forged native success without any model request is never accepted", async () => {
  const f = fixture();
  const outcome = await f.adapter(async (manifest, handle) => {
    await tool(handle, manifest, "run_bash", { command: "bun run check" });
    await tool(handle, manifest, "finish", { summary: "tool-only claim" }); return result(manifest);
  })(f.args);
  expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("finished_without_model_request");
  expect(outcome.summary).toBeNull(); expect(f.upstream).toHaveLength(0);
});

test("native no-finish and iteration-cap outcomes stay negative after trusted finish tools", async () => {
  for (const status of ["no_finish", "iteration_cap"] as const) {
    const f = fixture();
    const outcome = await f.adapter(async (manifest, handle) => {
      await handle(modelRequest(manifest));
      await tool(handle, manifest, "run_bash", { command: "bun run check" });
      await tool(handle, manifest, "finish", { summary: "tools passed but runtime did not complete" });
      return result(manifest, status);
    })(f.args);
    expect(outcome.status).toBe(status); expect(outcome.summary).toBeNull();
    expect(outcome.publicationApproved).toBe(false); expect(outcome.runLog).toHaveLength(1);
  }
});

test("blocking requires Gary report_blocked and does not imply a passing check", async () => {
  const f = fixture();
  const outcome = await f.adapter(async (manifest, handle) => {
    await handle(modelRequest(manifest));
    await tool(handle, manifest, "report_blocked", { reason: "Required dependency is unavailable" });
    return result(manifest, "finished");
  })(f.args);
  expect(outcome.status).toBe("blocked"); expect(outcome.summary).toBe("Required dependency is unavailable");
  expect(outcome.runLog).toEqual([]); expect(outcome.publicationApproved).toBe(false);
  const g = fixture(); const claimed = await g.adapter(async manifest => result(manifest, "blocked"))(g.args);
  expect(claimed.status).toBe("no_finish"); expect(claimed.summary).toBeNull();
});

test("all currently unsupported production arguments reject before launch or spend", async () => {
  const invalid: Array<[Partial<AgentLoopArgs>, string]> = [
    [{ phases: [] }, "phases"], [{ cloudflare: {} as NonNullable<AgentLoopArgs["cloudflare"]> }, "cloudflare"],
    [{ linear: {} as NonNullable<AgentLoopArgs["linear"]> }, "linear"],
    [{ currentIssue: { id: "x", identifier: "X", teamId: "team" } }, "currentIssue"],
    [{ github: {} as NonNullable<AgentLoopArgs["github"]> }, "github"], [{ defaultRepo: "owner/repo" }, "defaultRepo"],
    [{ disableSubagent: false }, "subagents_must_be_disabled"], [{ readOnly: true }, "readOnly"],
  ];
  for (const [overrides, name] of invalid) {
    const f = fixture(); let launched = false;
    const outcome = await f.adapter(async manifest => { launched = true; return result(manifest); })({ ...f.args, ...overrides });
    expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("unsupported_loop_option:" + name);
    expect(launched).toBe(false); expect(f.upstream).toHaveLength(0); expect(f.commands).toHaveLength(0);
    expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(0);
  }
  const f = fixture(); const { disableSubagent: _, ...withoutOptOut } = f.args;
  expect((await f.adapter(async manifest => result(manifest))(withoutOptOut)).errorMessage)
    .toBe("unsupported_loop_option:subagents_must_be_disabled");
});

test("wrong executor, check command and missing control grants cannot change admission", async () => {
  const cases = ["executor", "finish_gate", "control_tools"] as const;
  for (const kind of cases) {
    const f = fixture(); let launched = false;
    if (kind === "executor") f.args.executor = { ...f.args.executor };
    if (kind === "finish_gate") f.args.finishGateCommand = "echo pretend";
    if (kind === "control_tools") f.host.allowedTools = ["read_file", "finish", "report_blocked"];
    const outcome = await f.adapter(async manifest => { launched = true; return result(manifest); })(f.args);
    expect(outcome.status).toBe("error"); expect(launched).toBe(false); expect(f.upstream).toHaveLength(0);
  }
});

test("invalid task, run limits and endpoint reject without any model or executor work", async () => {
  const cases: Partial<AgentLoopArgs>[] = [{ task: " " }, { systemPrompt: "" }, { maxIterations: 0 },
    { maxIterations: 51 }, { maxIterations: 1.5 }, { maxTokensPerTurn: 8193 }, { maxTokensPerTurn: 0 },
    { temperature: 1.1 }, { temperature: NaN }, { timeoutMs: -1 }, { deadlineMs: Infinity }];
  for (const overrides of cases) {
    const f = fixture(); let launched = false;
    const outcome = await f.adapter(async manifest => { launched = true; return result(manifest); })({ ...f.args, ...overrides });
    expect(outcome.status).toBe("error"); expect(launched).toBe(false); expect(f.upstream).toHaveLength(0);
  }
  const f = fixture(); let launched = false;
  expect((await f.adapter(async manifest => { launched = true; return result(manifest); }, "https://external.invalid/")(f.args)).status).toBe("error");
  expect(launched).toBe(false); expect(f.commands).toHaveLength(0);
});

test("adapter admission is one-use, including concurrent invocations and failed validation", async () => {
  const f = fixture(); let release!: () => void, began!: () => void;
  const launched = new Promise<void>(resolve => { began = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let launches = 0;
  const run = f.adapter(async manifest => { launches++; began(); await gate; return result(manifest, "no_finish"); });
  const first = run(f.args); await launched;
  expect((await run(f.args)).errorMessage).toBe("admitted_adapter_already_used");
  release(); expect((await first).status).toBe("no_finish"); expect(launches).toBe(1);
  const g = fixture(); const invalidRun = g.adapter(async manifest => result(manifest));
  expect((await invalidRun({ ...g.args, disableSubagent: false })).status).toBe("error");
  expect((await invalidRun(g.args)).errorMessage).toBe("admitted_adapter_already_used");
});

test("native outcome is bound to task and request and can never approve publication", async () => {
  for (const override of [{ taskId: "task-elsewhere" }, { requestId: "request-elsewhere" },
    { publicationApproved: true }, { status: "published" }]) {
    const f = fixture();
    const outcome = await f.adapter(async (manifest, handle) => {
      await handle(modelRequest(manifest)); await tool(handle, manifest, "run_bash", { command: "bun run check" });
      await tool(handle, manifest, "finish", { summary: "otherwise finished" });
      return { ...result(manifest), ...override } as NativeRuntimeOutcome;
    })(f.args);
    expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("native_outcome_binding_rejected");
    expect(outcome.summary).toBeNull(); expect(outcome.publicationApproved).toBe(false);
  }
});

test("authentication and task ownership are enforced before model spend and tool use", async () => {
  const f = fixture();
  const outcome = await f.adapter(async (manifest, handle) => {
    const wrongModel = modelRequest(manifest); wrongModel.headers.set("authorization", "Bearer invalid");
    expect((await handle(wrongModel)).status).toBe(401);
    expect((await handle(request("/tools/execute", { taskId: "other-task", ownerEpoch: manifest.ownerEpoch,
      token: manifest.capability, callId: "wrong-task", name: "run_bash", arguments: { command: "bun run check" } }))).status).toBe(403);
    return result(manifest, "no_finish");
  })(f.args);
  expect(outcome.iterations).toBe(0); expect(f.upstream).toHaveLength(0); expect(f.commands).toHaveLength(0);
});

test("revocation and owner changes fence further calls and revoke an earlier finish", async () => {
  for (const revoke of ["revoke", "changeOwner"] as const) {
    const f = fixture();
    const outcome = await f.adapter(async (manifest, handle) => {
      await handle(modelRequest(manifest)); await tool(handle, manifest, "run_bash", { command: "bun run check" });
      await tool(handle, manifest, "finish", { summary: "no longer owned" }); f[revoke]();
      expect((await handle(modelRequest(manifest))).status).toBe(409);
      expect((await tool(handle, manifest, "read_file", { path: "README.md" })).status).toBe(409);
      return result(manifest);
    })(f.args);
    expect(outcome.status).toBe("error"); expect(outcome.summary).toBeNull(); expect(f.upstream).toHaveLength(1);
    expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(1);
  }
});

test("closed allocation prevents launch and is never reopened or re-enrolled", async () => {
  const f = fixture(); f.ledger.markTerminal("TICKET-1", "already_exhausted"); let launched = false;
  const outcome = await f.adapter(async manifest => { launched = true; return result(manifest); })(f.args);
  expect(outcome.status).toBe("error"); expect(launched).toBe(false);
  expect(f.ledger.status("TICKET-1")!.state).not.toBe("active");
  expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(0);
});

test("shared absolute admission and caller deadlines can only shorten the runtime", async () => {
  for (const source of ["admission", "caller", "relative"] as const) {
    const f = fixture(); const short = Date.now() + 800;
    if (source === "admission") f.host.admission.deadlineMs = short;
    if (source === "caller") f.args.deadlineMs = short;
    if (source === "relative") f.args.timeoutMs = 800;
    const start = Date.now();
    const outcome = await f.adapter(async manifest => {
      expect(manifest.deadlineMs).toBeLessThanOrEqual(source === "relative" ? Date.now() + 800 : short);
      expect(manifest.deadlineMs).toBeGreaterThanOrEqual(start);
      return result(manifest, "no_finish");
    })(f.args);
    expect(outcome.status).toBe("no_finish");
  }
});

test("pre-expired and pre-cancelled work cannot launch", async () => {
  for (const mode of ["deadline", "caller_abort", "host_abort"] as const) {
    const f = fixture(); let launched = false;
    if (mode === "deadline") f.host.admission.deadlineMs = Date.now() - 1;
    else { const abort = new AbortController(); abort.abort();
      if (mode === "caller_abort") f.args.signal = abort.signal; else f.host.signal = abort.signal; }
    const outcome = await f.adapter(async manifest => { launched = true; return result(manifest); })(f.args);
    expect(outcome.status).toBe(mode === "deadline" ? "timeout" : "error");
    expect(launched).toBe(false); expect(f.upstream).toHaveLength(0);
  }
});

test("cancellation waits for launcher's cleanup and leaves its ledger allocation intact", async () => {
  const f = fixture(), cancel = new AbortController(); f.args.signal = cancel.signal;
  let began!: () => void, cleaned!: () => void, cleanupComplete = false, settled = false;
  const started = new Promise<void>(resolve => { began = resolve; });
  const cleanupGate = new Promise<void>(resolve => { cleaned = resolve; });
  let retainedHandle: RuntimeRequestHandler | undefined, manifestCopy: Readonly<GaryRuntimeManifest> | undefined;
  const run = f.adapter(async (manifest, handle, signal) => {
    retainedHandle = handle; manifestCopy = manifest;
    const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    began(); await aborted; await cleanupGate; cleanupComplete = true; return result(manifest);
  });
  const pending = run(f.args).then(value => { settled = true; return value; });
  await started; cancel.abort(); await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); cleaned(); const outcome = await pending;
  expect(cleanupComplete).toBe(true); expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("aborted");
  expect((await retainedHandle!(modelRequest(manifestCopy!))).status).toBe(409);
  expect(f.ledger.status("TICKET-1")!.state).toBe("active"); expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(0);
});

test("authenticated model requests cannot increase run output/temperature limits", async () => {
  for (const override of [{ max_tokens: 129 }, { max_tokens: 0 }, { temperature: 0.4 }, { temperature: undefined }]) {
    const f = fixture();
    const outcome = await f.adapter(async (manifest, handle, signal) => {
      expect((await handle(modelRequest(manifest, override))).status).toBe(400);
      expect(signal.aborted).toBe(true); return result(manifest);
    })(f.args);
    expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("model_run_limits_rejected");
    expect(f.upstream).toHaveLength(0); expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(0);
  }
});

test("iteration cap counts host-router attempts, ignores native counters, and blocks an extra call", async () => {
  const f = fixture(); f.args.maxIterations = 1;
  const outcome = await f.adapter(async (manifest, handle, signal) => {
    expect((await handle(modelRequest(manifest))).status).toBe(200);
    expect((await handle(modelRequest(manifest))).status).toBe(400); expect(signal.aborted).toBe(true);
    return result(manifest, "iteration_cap");
  })(f.args);
  expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("model_iteration_limit");
  expect(outcome.iterations).toBe(1); expect(f.upstream).toHaveLength(1);
  expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(1);
});

test("parallel model bodies cannot race the iteration cap or start duplicate spend", async () => {
  const f = fixture(); f.args.maxIterations = 1; let cancelled = false;
  const outcome = await f.adapter(async (manifest, handle) => {
    const stalled = new Request(new URL("/v1/chat/completions", BASE), { method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) });
    const first = handle(stalled);
    const second = await handle(modelRequest(manifest)); expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe("concurrent_model_requests_rejected");
    expect((await first).status).toBe(400); return result(manifest);
  })(f.args);
  expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("concurrent_model_requests_rejected");
  expect(cancelled).toBe(true);
  expect(f.upstream).toHaveLength(0); expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(0);
});

test("stalled and oversized model bodies stop before any spend reservation", async () => {
  for (const mode of ["stalled", "oversized"] as const) {
    const f = fixture(); f.args.timeoutMs = mode === "stalled" ? 35 : 3000; let cancelled = false;
    const outcome = await f.adapter(async (manifest, handle) => {
      const body = mode === "stalled"
        ? new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })
        : new Uint8Array(1_048_577);
      const response = await handle(new Request(new URL("/v1/chat/completions", BASE), { method: "POST",
        headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body }));
      expect(response.status).toBe(400); return result(manifest);
    })(f.args);
    expect(outcome.status).toBe(mode === "stalled" ? "timeout" : "error");
    if (mode === "stalled") expect(cancelled).toBe(true);
    expect(f.upstream).toHaveLength(0); expect(f.ledger.status("TICKET-1")!.attemptCount).toBe(0);
  }
});

test("launcher errors are redacted and retained handlers cannot act after settlement", async () => {
  const f = fixture(); let captured: RuntimeRequestHandler | undefined;
  const outcome = await f.adapter(async (_manifest, handle) => { captured = handle; throw new Error("sensitive-host-detail"); })(f.args);
  expect(outcome.status).toBe("error"); expect(outcome.errorMessage).toBe("runtime_launch_or_admission_failed");
  expect(JSON.stringify(outcome)).not.toContain("sensitive-host-detail");
  expect((await captured!(request("/tools/state", { taskId: "task-1", ownerEpoch: "owner-1" }))).status).toBe(409);
  expect(f.ledger.status("TICKET-1")!.state).toBe("active");
});

test("integration arguments must be the exact admitted clients, ticket and repository", async () => {
  const client = {} as NonNullable<AgentLoopArgs["linear"]>;
  const github = {} as NonNullable<AgentLoopArgs["github"]>;
  const cloudflare = {} as NonNullable<AgentLoopArgs["cloudflare"]>;
  const issue = { id: "issue-1", identifier: "TICKET-1", teamId: "team-1" };
  for (const mismatch of ["none", "linear", "github", "cloudflare", "currentIssue", "defaultRepo", "extra", "ungranted"]) {
    const f = fixture();
    f.host.integrations = { linear: { client, readIdentifiers: ["TICKET-1"], currentIssue: issue }, github: { client: github, defaultRepo: "owner/repo" },
      cloudflare: { client: cloudflare, allowedServices: ["worker"], allowedDatabases: ["db"] } };
    f.host.allowedTools = [...f.host.allowedTools, "get_linear_issue", "get_pr", "query_cloudflare_logs", "list_cloudflare_invocations", "d1_query", "unassign_self", "set_ticket_state", "update_ticket_description"];
    Object.assign(f.args, { linear: client, github, cloudflare, currentIssue: { ...issue }, defaultRepo: "owner/repo" });
    if (["linear", "github", "cloudflare"].includes(mismatch)) (f.args as any)[mismatch] = {};
    if (mismatch === "currentIssue") f.args.currentIssue = { ...issue, id: "different" };
    if (mismatch === "defaultRepo") f.args.defaultRepo = "owner/different";
    if (mismatch === "ungranted") f.host.allowedTools = f.host.allowedTools.filter(name => name !== "get_pr");
    if (mismatch === "extra") delete f.args.linear;
    let launches = 0;
    const value = await f.adapter(async m => { launches++; return result(m, "no_finish"); })(f.args);
    expect(launches).toBe(mismatch === "none" ? 1 : 0);
    expect(value.status).toBe(mismatch === "none" ? "no_finish" : "error");
    if (mismatch !== "none") expect(value.errorMessage).toStartWith(mismatch === "ungranted" ? "integration_tools_not_granted:" : "integration_binding_mismatch:");
    expect(f.upstream).toHaveLength(0);
  }
});

test("subagent recursion policy and readonly isolation cannot be changed by loop arguments", async () => {
  const f = fixture(); f.host.integrations = { subagentRunner: async () => ({ summary: "bounded", iterations: 1, status: "no_finish" }) };
  f.host.allowedTools = [...f.host.allowedTools, "dispatch_subagent"];
  const disabled = await f.adapter(async m => result(m))(f.args);
  expect(disabled.status).toBe("error"); expect(disabled.errorMessage).toBe("subagent_binding_mismatch");
  const admitted = fixture(); admitted.host.integrations = f.host.integrations!; admitted.host.allowedTools = [...admitted.host.allowedTools, "dispatch_subagent"];
  delete admitted.args.disableSubagent;
  expect((await admitted.adapter(async m => result(m, "no_finish"))(admitted.args)).status).toBe("no_finish");
  for (const mutation of ["finish", "write_file", "edit_file", "commit", "dispatch_subagent", "unassign_self", "set_ticket_state", "update_ticket_description"]) {
    const child = fixture(); child.host.readOnly = true; child.host.finishGateCommand = "";
    child.host.allowedTools = ["read_file", "report_blocked", mutation]; child.args.readOnly = true; delete child.args.finishGateCommand;
    const value = await child.adapter(async () => { throw new Error("must not launch"); })(child.args);
    expect(value.status).toBe("error"); expect(value.errorMessage).toBe(mutation === "dispatch_subagent" ? "subagent_binding_mismatch" : "readonly_mutation_granted");
  }
});

test("Cloudflare tool requirements follow explicit service and database scopes", async () => {
  for (const mode of ["none", "services", "databases"] as const) {
    const f = fixture(); const client = {} as NonNullable<AgentLoopArgs["cloudflare"]>;
    f.args.cloudflare = client; f.host.integrations = { cloudflare: { client,
      allowedServices: mode === "services" ? ["worker"] : [], allowedDatabases: mode === "databases" ? ["db"] : [] } };
    f.host.allowedTools = [...f.host.allowedTools, ...(mode === "services" ? ["query_cloudflare_logs", "list_cloudflare_invocations"] : mode === "databases" ? ["d1_query"] : [])];
    expect((await f.adapter(async m => result(m, "no_finish"))(f.args)).status).toBe("no_finish");
    if (mode !== "none") {
      f.host.allowedTools = f.host.allowedTools.filter(name => !["query_cloudflare_logs", "d1_query"].includes(name));
      expect((await f.adapter(async () => { throw new Error("must not launch"); })(f.args)).errorMessage).toBe("integration_tools_not_granted:cloudflare");
    }
  }
});
