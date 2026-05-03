import { describe, expect, it } from "bun:test";
import { makeToolset } from "../src/agent/tools.ts";
import type { Executor } from "../src/executors/index.ts";

const noopExecutor: Executor = {
  workspaceRoot: "/tmp",
  readFile: async () => "",
  writeFile: async () => {},
  listFiles: async () => [],
  grep: async () => [],
  run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
};

describe("dispatch_subagent tool", () => {
  it("is not registered without a runner", () => {
    const tools = makeToolset(noopExecutor);
    expect(tools.handlers.dispatch_subagent).toBeUndefined();
  });

  it("is registered when a runner is provided", () => {
    const tools = makeToolset(noopExecutor, {
      subagentRunner: async () => ({
        status: "finished",
        summary: "ok",
        iterations: 1,
      }),
    });
    expect(tools.handlers.dispatch_subagent).toBeDefined();
  });

  it("forwards the task to the runner and returns its summary", async () => {
    const calls: string[] = [];
    const tools = makeToolset(noopExecutor, {
      subagentRunner: async (task) => {
        calls.push(task);
        return { status: "finished", summary: "found 3 callers", iterations: 4 };
      },
    });
    const out = await tools.handlers.dispatch_subagent!.run({
      task: "find every caller of parseConfig",
    });
    expect(calls).toEqual(["find every caller of parseConfig"]);
    expect(out).toContain("found 3 callers");
    expect(out).toContain("4 iter");
  });

  it("reports non-finished status to the model", async () => {
    const tools = makeToolset(noopExecutor, {
      subagentRunner: async () => ({
        status: "iteration_cap",
        summary: null,
        iterations: 15,
      }),
    });
    const out = await tools.handlers.dispatch_subagent!.run({ task: "x" });
    expect(out).toContain("iteration_cap");
    expect(out).toContain("did not finish");
  });

  it("validates that task is a non-empty string", async () => {
    const tools = makeToolset(noopExecutor, {
      subagentRunner: async () => ({
        status: "finished",
        summary: null,
        iterations: 1,
      }),
    });
    const out = await tools.handlers.dispatch_subagent!.run({ task: "" });
    expect(out).toContain("dispatch_subagent");
  });
});

describe("readOnly toolset", () => {
  it("omits write_file, edit_file, and commit when readOnly is set", () => {
    const tools = makeToolset(noopExecutor, { readOnly: true });
    expect(tools.handlers.write_file).toBeUndefined();
    expect(tools.handlers.edit_file).toBeUndefined();
    expect(tools.handlers.commit).toBeUndefined();
    // Read tools are still present.
    expect(tools.handlers.read_file).toBeDefined();
    expect(tools.handlers.grep).toBeDefined();
    expect(tools.handlers.run_bash).toBeDefined();
  });

  it("includes write tools by default", () => {
    const tools = makeToolset(noopExecutor);
    expect(tools.handlers.write_file).toBeDefined();
    expect(tools.handlers.edit_file).toBeDefined();
    expect(tools.handlers.commit).toBeDefined();
  });
});
