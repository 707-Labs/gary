import { afterEach, describe, expect, test } from "bun:test";
import { createExecutorBridge, type ExecutorBridge, type ExecutorBridgeOptions, type ToolInvocation } from "../../src/hermes/executor-bridge.ts";
import type { Executor, ExecResult, RunOpts } from "../../src/executors/index.ts";
import type { DeadlineOptions } from "../../src/deadline.ts";

const token = "offline-fixture-capability-token-000000000000";
const allTools = ["read_file", "write_file", "edit_file", "grep", "list_files", "run_bash", "commit", "todo_write", "finish", "report_blocked"];
const bridges: ExecutorBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });

function fakeExecutor() {
  const reads: string[] = [], writes: string[] = [], commands: string[] = [];
  const files = new Map<string, string>([["src/file.ts", "original"], ["space name.md", "safe"]]);
  let onRead: (() => Promise<void>) | undefined;
  let onRun: ((options?: RunOpts) => Promise<void>) | undefined;
  let result: ExecResult = { stdout: "check passed", stderr: "", exitCode: 0, timedOut: false };
  let lastDeadline: DeadlineOptions | undefined;
  const executor: Executor = {
    workspaceRoot: "/offline/fake-workspace",
    async readFile(path, opts) { reads.push(path); lastDeadline = opts; await onRead?.(); return files.get(path) ?? "not found"; },
    async writeFile(path, content, opts) { writes.push(path); lastDeadline = opts; files.set(path, content); },
    async listFiles() { return [...files.keys()]; },
    async grep(pattern) { return [{ path: "src/file.ts", line: 1, text: pattern }]; },
    async run(command, opts) { commands.push(command); lastDeadline = opts; await onRun?.(opts); return result; },
  };
  return { executor, reads, writes, commands, files,
    set onRead(fn: () => Promise<void>) { onRead = fn; },
    set onRun(fn: (opts?: RunOpts) => Promise<void>) { onRun = fn; },
    set result(value: ExecResult) { result = value; },
    get lastDeadline() { return lastDeadline; },
  };
}

function harness(extra: Partial<ExecutorBridgeOptions> = {}) {
  const fake = fakeExecutor();
  let epoch = "owner-1", active = true, count = 0;
  const bridge = createExecutorBridge({ executor: fake.executor,
    capability: { taskId: "task-1", token, ownerEpoch: "owner-1", deadlineMs: Date.now() + 60_000 },
    currentOwnerEpoch: () => epoch, isCapabilityActive: () => active,
    allowedTools: allTools, finishGateCommand: "bun run check", ...extra });
  bridges.push(bridge);
  const request = (name: string, args: Record<string, unknown> = {}): ToolInvocation => ({
    taskId: "task-1", token, ownerEpoch: "owner-1", callId: `call-${++count}`, name, arguments: args,
  });
  return { fake, bridge, request, invoke: (name: string, args: Record<string, unknown> = {}) => bridge.invoke(request(name, args)),
    revokeOwner: () => { epoch = "owner-2"; }, revokeToken: () => { active = false; } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("offline Gary executor bridge (fake Executor; no Docker/model/network)", () => {
  test("requires explicit safe allowlist and advertises only requested Gary schemas", async () => {
    const h = harness({ allowedTools: ["read_file", "finish", "report_blocked"] });
    expect(h.bridge.definitions.map(x => x.function.name)).toEqual(["read_file", "finish", "report_blocked"]);
    expect(h.bridge.definitions[0]?.function.parameters).toMatchObject({ type: "object", required: ["path"], additionalProperties: false });
    const definitions = h.bridge.definitions;
    definitions[0]!.function.name = "fetch_url";
    expect(h.bridge.definitions[0]?.function.name).toBe("read_file");
    for (const name of ["fetch_url", "run_bash", "get_pr", "set_ticket_state", "dispatch_subagent", "__proto__", "constructor"]) {
      expect((await h.invoke(name)).ok).toBe(false);
    }
    expect(h.fake.commands).toEqual([]);
    for (const allowedTools of [["fetch_url"], ["read_file", "read_file"], undefined]) {
      expect(() => harness({ allowedTools: allowedTools as string[] })).toThrow("allowlist");
    }
  });

  test("validates task, token and owner on every invocation without exposing task state", async () => {
    const h = harness();
    await h.invoke("report_blocked", { reason: "private task reason" });
    for (const override of [{ taskId: "other" }, { token: "wrong" }, { ownerEpoch: "other" }]) {
      const result = await h.bridge.invoke({ ...h.request("read_file", { path: "src/file.ts" }), ...override });
      expect(result.error).toBe("unauthorized");
      expect(result.state.blockedReason).toBeNull();
      expect(result.truncated).toBe(false);
    }
    expect(h.fake.reads).toEqual([]);
  });

  test("reuses Gary check gate, run log, cache and terminal finish state", async () => {
    const h = harness();
    const premature = await h.invoke("finish", { summary: "done" });
    expect(premature.error).toBe("tool_failed");
    expect(h.bridge.state.finishSummary).toBeNull();
    await h.invoke("read_file", { path: "src/file.ts" });
    await h.invoke("read_file", { path: "src/file.ts" });
    expect(h.fake.reads).toHaveLength(1);
    await h.invoke("run_bash", { command: "bun run check", timeout_seconds: 10000 });
    expect(h.fake.commands).toEqual(["bun run check"]);
    expect(h.fake.lastDeadline?.deadlineMs).toBeLessThan(Date.now() + 61_000);
    expect(h.fake.lastDeadline?.signal).toBeInstanceOf(AbortSignal);
    expect(h.bridge.state.runLog).toHaveLength(1);
    expect(h.bridge.state.runLog[0]).toMatchObject({ cmd: "bun run check", exit: 0 });
    expect(h.bridge.state.readCache).toEqual([]);
    expect((await h.invoke("finish", { summary: "verified" })).ok).toBe(true);
    expect(h.bridge.state.finishSummary).toBe("verified");
    expect((await h.invoke("write_file", { path: "src/file.ts", content: "late" })).error).toBe("task_terminal");
    expect(h.fake.writes).toEqual([]);
    const detached = h.bridge.state;
    detached.runLog.length = 0;
    detached.finishSummary = "tampered";
    expect(h.bridge.state.runLog).toHaveLength(1);
    expect(h.bridge.state.finishSummary).toBe("verified");
  });

  test("file content starting with error is data; actual executor failures are errors", async () => {
    const h = harness();
    h.fake.files.set("error.txt", "error in read_file: ordinary file content");
    const read = await h.invoke("read_file", { path: "error.txt" });
    expect(read.ok).toBe(true);
    expect(read.content).toBe("error in read_file: ordinary file content");
    h.fake.onRead = async () => { throw new Error("offline executor failure"); };
    expect((await h.invoke("read_file", { path: "unread.txt" })).error).toBe("tool_failed");
    expect((await h.invoke("todo_write", { todos: [{ content: "x", status: "invalid" }] })).error).toBe("tool_failed");
  });

  test("blocked exits without meeting verification gate and disallows later work", async () => {
    const h = harness();
    expect((await h.invoke("report_blocked", { reason: "check dependency unavailable" })).ok).toBe(true);
    expect(h.bridge.state.blockedReason).toBe("check dependency unavailable");
    expect(h.bridge.state.finishGateMet).toBe(false);
    expect((await h.invoke("finish", { summary: "pretend" })).error).toBe("task_terminal");
    expect((await h.invoke("run_bash", { command: "late" })).error).toBe("task_terminal");
    expect(h.fake.commands).toEqual([]);
  });

  test("failed and timed-out checks cannot unlock finish", async () => {
    for (const result of [
      { stdout: "", stderr: "failed", exitCode: 1, timedOut: false },
      { stdout: "", stderr: "", exitCode: 0, timedOut: true },
    ]) {
      const h = harness(); h.fake.result = result;
      await h.invoke("run_bash", { command: "bun run check" });
      expect(h.bridge.state.finishGateMet).toBe(false);
      expect((await h.invoke("finish", { summary: "not verified" })).ok).toBe(false);
    }
  });

  test("rejects concurrent and replayed IDs, including changed tools and denied calls", async () => {
    const h = harness(); const wait = deferred();
    h.fake.onRead = () => wait.promise;
    const request = h.request("read_file", { path: "src/file.ts" });
    const pending = h.bridge.invoke(request);
    expect((await h.bridge.invoke({ ...request, name: "write_file", arguments: { path: "src/file.ts", content: "bad" } })).error).toBe("duplicate_call");
    const busyRequest = h.request("report_blocked", { reason: "concurrent" });
    expect((await h.bridge.invoke(busyRequest)).error).toBe("bridge_busy");
    wait.resolve(); expect((await pending).ok).toBe(true);
    expect((await h.bridge.invoke(request)).error).toBe("duplicate_call");
    expect((await h.bridge.invoke(busyRequest)).error).toBe("duplicate_call");
    const denied = h.request("fetch_url");
    expect((await h.bridge.invoke(denied)).error).toBe("tool_denied");
    expect((await h.bridge.invoke({ ...denied, name: "finish", arguments: { summary: "late" } })).error).toBe("duplicate_call");
    expect(h.fake.reads).toHaveLength(1); expect(h.fake.writes).toEqual([]);
  });

  test("rejects traversal, absolute, NUL and glob paths before the executor", async () => {
    const h = harness();
    for (const path of ["../secret", "/etc/passwd", "src/../../secret", "C:\\secret", "a\u0000b", "a\\..\\secret"]) {
      expect((await h.invoke("read_file", { path })).error).toBe("path_denied");
    }
    for (const path_glob of ["../**", "/**", "**/{..,src}/**", "!../**"]) {
      expect((await h.invoke("list_files", { path_glob })).error).toBe("path_denied");
    }
    expect(h.fake.reads).toEqual([]);
    expect((await h.invoke("read_file", { path: "space name.md" })).content).toBe("safe");
  });

  test("epoch loss during edit read prevents its write and suppresses stale result", async () => {
    const h = harness(); h.fake.onRead = async () => { h.revokeOwner(); };
    const result = await h.invoke("edit_file", { path: "src/file.ts", old_string: "original", new_string: "modified" });
    expect(result.ok).toBe(false);
    expect(h.bridge.state.invalidated).toBe(true);
    expect(h.fake.writes).toEqual([]);
    expect(h.fake.files.get("src/file.ts")).toBe("original");
    expect((await h.invoke("run_bash", { command: "late" })).ok).toBe(false);
    expect(h.fake.commands).toEqual([]);
  });

  test("token revocation before invocation prevents all execution", async () => {
    const h = harness(); h.revokeToken();
    expect((await h.invoke("read_file", { path: "src/file.ts" })).error).toBe("capability_revoked");
    expect(h.fake.reads).toEqual([]);
  });

  test("expired deadline denies before execution", async () => {
    const h = harness({ capability: { taskId: "task-1", token, ownerEpoch: "owner-1", deadlineMs: Date.now() - 1 } });
    expect((await h.invoke("run_bash", { command: "late" })).error).toBe("deadline_exceeded");
    expect(h.fake.commands).toEqual([]);
  });

  test("deadline/abort during await is rejected after fake cleanup, not abandoned", async () => {
    const h = harness({ capability: { taskId: "task-1", token, ownerEpoch: "owner-1", deadlineMs: Date.now() + 25 } });
    let cleaned = false;
    h.fake.onRun = async opts => {
      await new Promise<void>(resolve => {
        if (opts?.signal?.aborted) resolve();
        else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await new Promise(resolve => setTimeout(resolve, 5)); cleaned = true;
    };
    const result = await h.invoke("run_bash", { command: "bun run check" });
    expect(result.ok).toBe(false); expect(cleaned).toBe(true);
    expect(h.bridge.state.finishGateMet).toBe(false);
    expect(h.bridge.state.finishSummary).toBeNull();
  });

  test("dispose cancels an in-flight operation through the provided executor signal", async () => {
    const h = harness(); const started = deferred(); let cleaned = false;
    h.fake.onRun = async opts => { started.resolve(); await new Promise<void>(resolve => {
      opts?.signal?.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true });
    }); };
    const pending = h.invoke("run_bash", { command: "work" }); await started.promise;
    h.bridge.dispose(); const result = await pending;
    expect(result.ok).toBe(false); expect(cleaned).toBe(true);
  });

  test("detected owner revocation cancels an existing operation and prevents new work", async () => {
    const h = harness(); const started = deferred(); let cancelled = false;
    h.fake.onRun = async opts => { started.resolve(); await new Promise<void>(resolve => {
      opts?.signal?.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
    }); };
    const pending = h.invoke("run_bash", { command: "work" }); await started.promise;
    h.revokeOwner();
    expect((await h.invoke("read_file", { path: "src/file.ts" })).error).toBe("capability_revoked");
    expect((await pending).ok).toBe(false);
    expect(cancelled).toBe(true); expect(h.fake.reads).toEqual([]);
  });

  test("bounds whole UTF-8 responses and rejects oversized/unexpected inputs", async () => {
    const h = harness({ maxResultBytes: 1024, maxInputBytes: 1024 });
    h.fake.files.set("large", '🦀"\n'.repeat(2000));
    const result = await h.invoke("read_file", { path: "large" });
    expect(result.ok).toBe(true); expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
    expect(h.bridge.state.readCache).not.toContain("large");
    expect((await h.invoke("write_file", { path: "x", content: "x".repeat(2000) })).error).toBe("input_too_large");
    expect((await h.invoke("run_bash", { command: "echo safe", executor: "local" })).error).toBe("invalid_arguments");
    expect((await h.bridge.invoke({ ...h.request("read_file"), arguments: "not json" })).error).toBe("invalid_arguments");
    expect((await h.invoke("report_blocked", { reason: "\u0000".repeat(100) })).ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(await h.invoke("finish", { summary: "unused" })))).toBeLessThanOrEqual(1024);
    expect(h.fake.writes).toEqual([]); expect(h.fake.commands).toEqual([]);
  });

  test("bounds call tombstones and supports OAI JSON argument strings", async () => {
    const h = harness({ maxCalls: 1 });
    const result = await h.bridge.invoke({ ...h.request("read_file"), arguments: JSON.stringify({ path: "src/file.ts" }) });
    expect(result.ok).toBe(true);
    expect((await h.invoke("read_file", { path: "space name.md" })).error).toBe("call_limit");
    expect(h.fake.reads).toHaveLength(1);
  });
});
