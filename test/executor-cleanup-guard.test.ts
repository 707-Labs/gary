import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { DockerExecutor } from "../src/executors/docker.ts";
import { ExecutorCleanupGuard, ExecutorCleanupUncertainError } from "../src/executors/cleanup-guard.ts";
import * as processSeam from "../src/executors/process.ts";
import { bindExecutorDeadline } from "../src/executors/index.ts";

let restore: { mockRestore(): void } | undefined;
afterEach(() => restore?.mockRestore());
const clean = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
const timeout = { ...clean, exitCode: 124, timedOut: true };

describe("ordinary Docker cleanup uncertainty", () => {
  for (const mode of ["nonzero", "timeout", "throw"] as const) {
    it(`latches ${mode} removal, retains evidence and fences every later invocation`, async () => {
      const calls: string[][] = [];
      const run = spyOn(processSeam, "runProcess").mockImplementation(async (_binary, args) => {
        calls.push(args);
        if (args[0] === "run") return { ...timeout };
        expect(args[0]).toBe("rm");
        if (mode === "throw") throw new Error("synthetic-private-process-detail");
        return mode === "timeout" ? { ...clean, timedOut: true } : { ...clean, exitCode: 1, stderr: "private fixture output" };
      });
      restore = run;
      const guard = new ExecutorCleanupGuard();
      const executor = new DockerExecutor("/offline/cleanup-fixture", { image: "offline-image", cleanupGuard: guard });
      let failure: unknown;
      try { await executor.run("fixture timeout", { timeoutMs: 1 }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ExecutorCleanupUncertainError);
      const error = failure as ExecutorCleanupUncertainError;
      expect(error.message).toBe("executor_cleanup_uncertain");
      expect(error.evidence).toEqual({ container: calls[0]![2]!, reason: mode === "throw" ? "removal_threw" : "removal_failed",
        exitCode: mode === "throw" ? null : mode === "timeout" ? 0 : 1, timedOut: mode === "throw" ? null : mode === "timeout" });
      expect(Object.isFrozen(error.evidence)).toBe(true);
      expect(JSON.stringify(error)).not.toContain("private");
      expect(guard.signal.reason).toBe(error);
      const bounded = bindExecutorDeadline(executor, {});
      for (const attempt of [() => bounded.run("later"), () => bounded.readFile("a"), () => bounded.writeFile("a", "b"),
        () => bounded.listFiles("*"), () => bounded.grep("x"),
        () => new DockerExecutor("/offline/cleanup-fixture", { image: "offline-image", cleanupGuard: guard }).run("retry")]) {
        await expect(attempt()).rejects.toBe(error);
      }
      expect(calls).toHaveLength(2);
      expect(() => guard.markUncertain({ container: "later", reason: "removal_threw", exitCode: null, timedOut: null })).toThrow(error);
      expect(guard.signal.reason).toBe(error);
    });
  }

  it("awaits removal before deciding, then preserves recoverable timeout after confirmed cleanup", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = mock(() => {});
    let runs = 0;
    const run = spyOn(processSeam, "runProcess").mockImplementation(async (_binary, args) => {
      if (args[0] === "rm") { entered(); await pending; return { ...clean }; }
      return runs++ === 0 ? { ...timeout } : { ...clean, stdout: "later output" };
    });
    restore = run;
    const guard = new ExecutorCleanupGuard();
    const executor = new DockerExecutor("/offline/cleanup-fixture", { image: "offline-image", cleanupGuard: guard });
    let settled = false;
    const result = executor.run("fixture timeout").finally(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(entered).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
    release(); expect(await result).toEqual(timeout);
    expect(guard.signal.aborted).toBe(false);
    expect(await executor.readFile("later")).toBe("later output");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("keeps ordinary nonzero command exits recoverable without claiming cleanup uncertainty", async () => {
    const run = spyOn(processSeam, "runProcess").mockResolvedValue({ ...clean, exitCode: 2 });
    restore = run;
    const guard = new ExecutorCleanupGuard();
    const executor = new DockerExecutor("/offline/cleanup-fixture", { image: "offline-image", cleanupGuard: guard });
    expect((await executor.run("ordinary failure")).exitCode).toBe(2);
    expect((await executor.run("ordinary retry")).exitCode).toBe(2);
    expect(guard.signal.aborted).toBe(false);
    expect(run.mock.calls.every(([, args]) => args[0] === "run")).toBe(true);
  });
});
