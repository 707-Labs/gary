import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditTrace } from "../../src/hermes/audit-trace.ts";
import { createGaryLoopAdapter } from "../../src/hermes/gary-loop-adapter.ts";
import type { SessionOptions } from "../../src/hermes/session-host.ts";
import type { AgentLoopArgs } from "../../src/agent/loop.ts";
import { SpendLedger } from "../../src/spend.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch {} } });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gary-trace-lifecycle-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "run.jsonl");
  const trace = createAuditTrace({ path, binding: { taskId: "task", requestId: "request", actionId: "action", ownerEpoch: "owner", ticketId: "ticket" } });
  cleanup.push(() => trace.close());
  const ledger = new SpendLedger(":memory:"); cleanup.push(() => ledger.close());
  ledger.createCampaign("offline", 10); ledger.enrollTicket("offline", "ticket", 5);
  let launched = 0, paid = 0;
  const executor = { workspaceRoot: "/offline", readFile: async () => "", writeFile: async () => {}, listFiles: async () => [], grep: async () => [],
    run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }) };
  const host: SessionOptions = { admission: { taskId: "task", requestId: "request", actionId: "action", ownerEpoch: "owner", ticketId: "ticket", fingerprint: "fingerprint", deadlineMs: Date.now() + 5000 },
    capabilityToken: "offline-capability-00000000000000000000", ledger, provider: "deepseek", model: "deepseek-v4-pro", providerApiKey: "fake",
    fetch: async () => { paid++; throw new Error("paid route must not run"); }, executor, allowedTools: ["run_bash", "finish", "report_blocked"], finishGateCommand: "check",
    currentOwnerEpoch: () => "owner", assertAdmission: () => {}, trace };
  const args: AgentLoopArgs = { glm: {} as AgentLoopArgs["glm"], executor, systemPrompt: "offline", task: "offline", maxIterations: 2, timeoutMs: 1000, disableSubagent: true, finishGateCommand: "check" };
  const run = () => createGaryLoopAdapter({ hostOptions: host, baseUrl: "http://127.0.0.1:1234/", launch: async manifest => {
    launched++; return { taskId: manifest.taskId, requestId: manifest.requestId, status: "no_finish", publicationApproved: false };
  } });
  return { host, args, trace, path, ledger, run, counts: () => ({ launched, paid }),
    events: () => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

test.each(["unsupported", "preaborted", "constructor-early", "constructor-late", "binding-mismatch"])("pre-host exit terminally closes its externally created trace: %s", async mode => {
  const f = fixture();
  if (mode === "unsupported") f.args.disableSubagent = false;
  else if (mode === "preaborted") f.args.signal = AbortSignal.abort();
  else if (mode === "constructor-early") f.host.capabilityToken = "too-short";
  else if (mode === "constructor-late") f.host.providerApiKey = "";
  else f.host.admission.actionId = "different-action";
  const outcome = await f.run()(f.args);
  expect(outcome.status).toBe("error"); expect(f.counts()).toEqual({ launched: 0, paid: 0 });
  expect(f.events()).toHaveLength(2);
  expect(f.events()[1]).toMatchObject({ kind: "terminal", status: "error", iteration: 0, phase: "single", pendingOperationIds: [] });
  expect(f.trace.failed).toBe(false); expect(() => f.trace.close()).not.toThrow();
  expect(f.ledger.status("ticket")!.attemptCount).toBe(0);
});

test("failed trace during early rejection yields a typed failure with no launch or model attempt", async () => {
  const f = fixture(); f.args.disableSubagent = false; rmSync(f.path);
  const outcome = await f.run()(f.args);
  expect(outcome).toMatchObject({ status: "error", terminationReason: "trace_failed", errorMessage: "trace_persistence_failed", summary: null });
  expect(f.trace.failed).toBe(true); expect(f.counts()).toEqual({ launched: 0, paid: 0 });
});

test("host terminal persistence failure is a typed result instead of a second finalization attempt", async () => {
  const f = fixture();
  const run = createGaryLoopAdapter({ hostOptions: f.host, baseUrl: "http://127.0.0.1:1234/", launch: async manifest => {
    rmSync(f.path);
    return { taskId: manifest.taskId, requestId: manifest.requestId, status: "no_finish", publicationApproved: false };
  } });
  const outcome = await run(f.args);
  expect(outcome).toMatchObject({ status: "error", terminationReason: "trace_failed", errorMessage: "trace_persistence_failed", summary: null });
  expect(f.trace.failed).toBe(true); expect(f.ledger.status("ticket")!.attemptCount).toBe(0);
});

test("reusing a consumed adapter does not write to or damage its finalized trace", async () => {
  const f = fixture(); f.args.disableSubagent = false;
  const run = f.run(); await run(f.args); const first = readFileSync(f.path, "utf8");
  const outcome = await run(f.args);
  expect(outcome.errorMessage).toBe("admitted_adapter_already_used");
  expect(readFileSync(f.path, "utf8")).toBe(first); expect(f.trace.failed).toBe(false);
});
