import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditErrorCode, AuditTraceError, createAuditTrace, fingerprintBytes, fingerprintJson, unknownAuditModelState, type AuditOperationStart, type AuditTerminal, type AuditTrace, type AuditTraceEvent, type AuditTraceOptions } from "../../src/hermes/audit-trace.ts";
const roots: string[] = [];
const traces: AuditTrace[] = [];
afterEach(() => {
  for (const trace of traces.splice(0)) { try { trace.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const binding = { taskId: "task-1", requestId: "request-1", actionId: "action-1", ownerEpoch: "epoch-1", ticketId: "ticket-1" };
const metadata = { iteration: 1, phase: "implementation" as const, modelState: { provider: "deepseek" as const, model: "deepseek-v4-pro" as const, thinking: "unknown" as const, effort: "unknown" as const } };
const start = (operationId = "model-1"): AuditOperationStart => ({ kind: "model", stage: "start", operationId, ...metadata });
const terminal = (status: AuditTerminal["status"] = "finished"): AuditTerminal => ({ kind: "terminal", status, ...metadata });
function fixture(options: Partial<AuditTraceOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gary-audit-trace-"))); roots.push(root); chmodSync(root, 0o700);
  const path = join(root, "run.jsonl");
  const trace = createAuditTrace({ path, binding: { ...binding }, ...options }); traces.push(trace);
  const events = () => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { root, path, trace, events };
}

describe("durable sanitized local execution trace", () => {
  test("exclusive 0600 file preserves ordered nested execution evidence with identity and unknown reasoning", () => {
    const f = fixture();
    f.trace.append(start());
    f.trace.append({ kind: "model", stage: "result", operationId: "model-1", httpStatus: 200, output: fingerprintBytes("model response") });
    f.trace.append({ ...start("tool-1"), kind: "tool", toolName: "run_bash", arguments: fingerprintJson({ command: "PRIVATE_COMMAND" }) });
    f.trace.append({ ...start("tool-1.exec1"), kind: "tool", toolName: "run_bash", parentOperationId: "tool-1", command: fingerprintBytes("PRIVATE_COMMAND") });
    f.trace.append({ kind: "tool", stage: "result", operationId: "tool-1.exec1", stdout: fingerprintBytes("PRIVATE_STDOUT"), stderr: fingerprintBytes("PRIVATE_STDERR"), exitCode: 0, timedOut: false });
    f.trace.append({ kind: "tool", stage: "result", operationId: "tool-1", trustedChangedFileCount: 2 });
    f.trace.append(terminal()); f.trace.close(); f.trace.close();
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const events = f.events(); expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.every(event => JSON.stringify(event.binding) === JSON.stringify(binding))).toBe(true);
    expect(events[0].kind).toBe("run_start");
    expect(events[5]).toMatchObject({ kind: "tool", stage: "result", parentOperationId: "tool-1", phase: "implementation", iteration: 1, exitCode: 0, timedOut: false });
    expect(events[5].durationMs).toBeGreaterThanOrEqual(0);
    expect(events[5].modelState).toEqual(metadata.modelState);
    expect(events[7]).toMatchObject({ kind: "terminal", status: "finished", pendingOperationIds: [] });
    expect(readFileSync(f.path, "utf8")).not.toContain("PRIVATE_");
    expect(f.trace.failed).toBe(false);
  });

  test("never replaces an existing trace or follows a target symlink", () => {
    const f = fixture(), saved = readFileSync(f.path, "utf8");
    expect(() => createAuditTrace({ path: f.path, binding })).toThrow(AuditTraceError);
    expect(readFileSync(f.path, "utf8")).toBe(saved);
    symlinkSync(f.path, join(f.root, "alias.jsonl"));
    expect(() => createAuditTrace({ path: join(f.root, "alias.jsonl"), binding })).toThrow(AuditTraceError);
  });

  test("requires an existing private parent; never creates or chmods an unsafe directory", () => {
    const f = fixture(), publicDir = join(f.root, "public"); mkdirSync(publicDir, { mode: 0o755 });
    expect(() => createAuditTrace({ path: join(publicDir, "trace.jsonl"), binding })).toThrow(AuditTraceError);
    expect(statSync(publicDir).mode & 0o777).toBe(0o755); expect(existsSync(join(publicDir, "trace.jsonl"))).toBe(false);
    expect(() => createAuditTrace({ path: join(f.root, "missing", "trace.jsonl"), binding })).toThrow(AuditTraceError);
  });

  test("immutable binding snapshot cannot change admission identity", () => {
    const mutable = { ...binding };
    const f = fixture({ binding: mutable }); mutable.taskId = "other";
    expect(f.trace.binding.taskId).toBe("task-1"); expect(Object.isFrozen(f.trace.binding)).toBe(true);
    expect(() => { (f.trace.binding as typeof binding).taskId = "forged"; }).toThrow();
    f.trace.append(terminal()); f.trace.close(); expect(f.events()[1].binding.taskId).toBe("task-1");
  });

  test("error, cancellation and unresolved operations survive terminal budget stop", () => {
    const f = fixture();
    f.trace.append(start("request-a"));
    f.trace.append({ kind: "model", stage: "error", operationId: "request-a", errorCode: "spend_guard_rejected" });
    f.trace.append({ ...start("tool-a"), kind: "tool", toolName: "read_file" });
    f.trace.append({ kind: "tool", stage: "cancel", operationId: "tool-a", errorCode: "deadline_exceeded", timedOut: true, exitCode: null });
    f.trace.append(start("unresolved"));
    f.trace.append({ ...terminal("budget_exhausted"), errorCode: "reservation_exhausted" }); f.trace.close();
    expect(f.events()[2]).toMatchObject({ stage: "error", errorCode: "spend_guard_rejected" });
    expect(f.events()[4]).toMatchObject({ stage: "cancel", errorCode: "deadline_exceeded", exitCode: null, timedOut: true });
    expect(f.events().at(-1).pendingOperationIds).toEqual(["unresolved"]);
  });

  test("explicit selected thinking/effort are retained without inferring provider defaults", () => {
    const f = fixture();
    f.trace.append({ ...start(), modelState: { provider: "deepseek", model: "deepseek-v4-pro", thinking: "enabled", effort: "high", thinkingBudgetTokens: 1024 } });
    f.trace.append({ kind: "model", stage: "result", operationId: "model-1" }); f.trace.append(terminal()); f.trace.close();
    expect(f.events()[2].modelState).toEqual({ provider: "deepseek", model: "deepseek-v4-pro", thinking: "enabled", effort: "high", thinkingBudgetTokens: 1024 });
    expect(unknownAuditModelState()).toEqual({ provider: "unknown", model: "unknown", thinking: "unknown", effort: "unknown" });
  });

  test.each([
    { prompt: "PRIVATE_PROMPT" }, { command: "PRIVATE_COMMAND" }, { arguments: { secret: "PRIVATE_ARGUMENT" } },
    { providerApiKey: "PRIVATE_KEY" }, { modelState: { ...metadata.modelState, effort: "PRIVATE_REASONING" } },
    { modelState: { ...metadata.modelState, provider: "deepseek", model: "glm-5.3" } },
    { modelState: { ...metadata.modelState, thinkingBudgetTokens: 1024 } },
    { ownerEpoch: "forged" }, { binding: { ...binding } }, { iteration: Infinity },
    { input: { bytes: 1, sha256: "not-a-hash" } }, { input: { ...fingerprintBytes("secret"), raw: "secret" } },
  ])("rejects raw, arbitrary or incoherent fields without writing them %#", extra => {
    const f = fixture(), before = readFileSync(f.path, "utf8");
    expect(() => f.trace.append({ ...start(), ...extra } as AuditTraceEvent)).toThrow(AuditTraceError);
    expect(f.trace.failed).toBe(true); expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(() => f.trace.append(terminal("error"))).toThrow("trace_persistence_failed");
  });

  test.each(["replacement", "unlink", "append", "permissions"])("detects lost or modified persistence and fails closed: %s", mutation => {
    const f = fixture();
    if (mutation === "replacement") { renameSync(f.path, f.path + ".old"); writeFileSync(f.path, "replacement", { mode: 0o600 }); }
    else if (mutation === "unlink") rmSync(f.path);
    else if (mutation === "append") appendFileSync(f.path, "extra\n");
    else chmodSync(f.path, 0o644);
    expect(() => f.trace.append(start())).toThrow("trace_persistence_failed");
    expect(f.trace.failed).toBe(true); expect(() => f.trace.close()).toThrow("trace_persistence_failed");
  });

  test("bounded trace stops before another side effect and preserves the durable prefix", () => {
    const f = fixture({ maxEvents: 2 }); f.trace.append(start());
    const prefix = readFileSync(f.path, "utf8");
    expect(() => f.trace.append({ kind: "model", stage: "result", operationId: "model-1" })).toThrow("trace_persistence_failed");
    expect(f.trace.failed).toBe(true); expect(readFileSync(f.path, "utf8")).toBe(prefix);
  });

  test.each(["no-start", "duplicate-start", "wrong-kind", "missing-error-code", "unresolved-finish", "unknown-parent"])("rejects incoherent event order: %s", violation => {
    const f = fixture();
    if (violation !== "no-start") f.trace.append(start());
    const event = violation === "duplicate-start" ? start() : violation === "wrong-kind" ? { kind: "tool", stage: "result", operationId: "model-1" }
      : violation === "missing-error-code" ? { kind: "model", stage: "error", operationId: "model-1" }
      : violation === "unresolved-finish" ? terminal() : violation === "unknown-parent" ? { ...start("child"), parentOperationId: "missing" }
      : { kind: "model", stage: "result", operationId: "model-1" };
    expect(() => f.trace.append(event as AuditTraceEvent)).toThrow("invalid_trace_event"); expect(f.trace.failed).toBe(true);
  });

  test("close requires a terminal record and notices disappearance after the terminal append", () => {
    const f = fixture(); expect(() => f.trace.close()).toThrow("terminal_event_required"); expect(f.trace.failed).toBe(true);
    const g = fixture(); g.trace.append(terminal()); rmSync(g.path);
    expect(() => g.trace.close()).toThrow("trace_persistence_failed"); expect(g.trace.failed).toBe(true);
  });

  test("fingerprints provide stable byte identity without retaining sensitive text", () => {
    expect(fingerprintBytes("abc")).toEqual({ bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(fingerprintBytes("é").bytes).toBe(2);
    expect(fingerprintJson({ z: 1, a: { b: "secret" } })).toEqual(fingerprintJson({ a: { b: "secret" }, z: 1 }));
    expect(JSON.stringify(fingerprintJson({ token: "PRIVATE_TOKEN" }))).not.toContain("PRIVATE_TOKEN");
    expect(auditErrorCode("reservation_exhausted")).toBe("reservation_exhausted");
    expect(auditErrorCode("Exception containing PRIVATE_KEY")).toBe("unknown");
  });

  test("fingerprints reject silent JSON coercions, accessors and cycles", () => {
    let invoked = false; const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { invoked = true; return "secret"; } });
    const arrayAccessor = Object.defineProperty(["x"], "0", { enumerable: true, get() { invoked = true; return "secret"; } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [undefined, NaN, Infinity, new Date(), { value: undefined }, [undefined], Array(2), accessor, arrayAccessor, cycle]) {
      expect(() => fingerprintJson(value)).toThrow(AuditTraceError);
    }
    expect(invoked).toBe(false);
  });
});


describe("sanitized provider compatibility diagnostics", () => {
  const diagnostic = () => ({ category: "unsupported_block_type" as const, blockTypes: ["thinking", "tool_use"] as ("thinking" | "tool_use")[], blockCount: 2, stopReason: "tool_use" as const, modelMatches: true });
  test("retains exact local code and bounded structure without response content", () => {
    const f = fixture(); f.trace.append(start());
    f.trace.append({ kind: "model", stage: "error", operationId: "model-1", httpStatus: 502, errorCode: "unsupported_provider_response", responseRejection: diagnostic() });
    f.trace.append({ ...terminal("error"), errorCode: "native_runtime_error" }); f.trace.close();
    expect(f.events()[2]).toMatchObject({ errorCode: "unsupported_provider_response", responseRejection: diagnostic() });
    expect(f.events().at(-1).pendingOperationIds).toEqual([]);
  });
  for (const invalid of [
    { category: "PRIVATE_PROVIDER_DETAIL" }, { blockTypes: ["PRIVATE_CONTENT"] }, { blockTypes: ["text", "text"] },
    { blockTypes: Array(11).fill("text") }, { blockTypes: Array(2) }, { blockCount: 1_000_001 }, { blockCount: -1 },
    { stopReason: "PRIVATE_REASON" }, { modelMatches: "yes" }, { rawBody: "PRIVATE_BODY" },
  ]) test("rejects unsafe or unbounded diagnostic " + Object.keys(invalid)[0], () => {
    const f = fixture(); f.trace.append(start());
    expect(() => f.trace.append({ kind: "model", stage: "error", operationId: "model-1", errorCode: "unsupported_provider_response", responseRejection: { ...diagnostic(), ...invalid } } as any)).toThrow(AuditTraceError);
    expect(f.trace.failed).toBe(true); expect(readFileSync(f.path, "utf8")).not.toContain("PRIVATE_");
  });
  test("diagnostic array accessors are rejected without evaluation", () => {
    const f = fixture(); f.trace.append(start()); let read = false;
    const values = Object.defineProperty(["text"], "0", { enumerable: true, get() { read = true; return "PRIVATE_CONTENT"; } });
    expect(() => f.trace.append({ kind: "model", stage: "error", operationId: "model-1", errorCode: "unsupported_provider_response", responseRejection: { ...diagnostic(), blockTypes: values } } as any)).toThrow(AuditTraceError);
    expect(read).toBe(false);
  });
  test("diagnostics cannot be attached to successful operations or unrelated errors", () => {
    for (const event of [{ stage: "result", errorCode: undefined }, { stage: "error", errorCode: "provider_transport_failed" }]) {
      const f = fixture(); f.trace.append(start());
      expect(() => f.trace.append({ kind: "model", operationId: "model-1", ...event, responseRejection: diagnostic() } as any)).toThrow(AuditTraceError);
    }
    const f = fixture(); f.trace.append({ ...start(), kind: "tool", toolName: "read_file" });
    expect(() => f.trace.append({ kind: "tool", stage: "error", operationId: "model-1", errorCode: "unsupported_provider_response", responseRejection: diagnostic() } as any)).toThrow(AuditTraceError);
  });
});

test('terminal independently validates exact diagnostic metadata, retaining operation evidence',()=>{
  const diagnostic={origin:'worker',code:'invalid_model_history_response',stage:'model_response',category:'none'} as const;
  const f=fixture();f.trace.append(start());f.trace.append({kind:'model',stage:'result',operationId:'model-1',httpStatus:200});
  f.trace.append({...terminal('error'),errorCode:'native_runtime_error',diagnostic});f.trace.close();
  expect(f.events().at(-1)).toMatchObject({diagnostic,status:'error',iteration:1,pendingOperationIds:[]});
  let invoked=0;
  for(const bad of [{...diagnostic,code:'SECRET'}, {...diagnostic,raw:'SECRET'}, {...diagnostic,[Symbol('secret')]:'SECRET'},
    Object.defineProperty({...diagnostic},'code',{get(){invoked++;return diagnostic.code;}})]) {
    const rejected=fixture();expect(()=>rejected.trace.append({...terminal('error'),diagnostic:bad as any})).toThrow(AuditTraceError);
    expect(rejected.trace.failed).toBe(true);expect(readFileSync(rejected.path,'utf8')).not.toContain('SECRET');
  }
  expect(invoked).toBe(0);
});
