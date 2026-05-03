import { describe, expect, it } from "bun:test";
import { makeToolset, renderTodos } from "../src/agent/tools.ts";
import type { Executor } from "../src/executors/index.ts";

const noopExecutor: Executor = {
  workspaceRoot: "/tmp",
  readFile: async () => "",
  writeFile: async () => {},
  listFiles: async () => [],
  grep: async () => [],
  run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
};

describe("todo_write tool", () => {
  it("is registered by default", () => {
    const tools = makeToolset(noopExecutor);
    expect(tools.handlers.todo_write).toBeDefined();
    expect(tools.todos).toEqual([]);
  });

  it("replaces the entire todo list each call", async () => {
    const tools = makeToolset(noopExecutor);
    await tools.handlers.todo_write!.run({
      todos: [
        { content: "investigate", status: "in_progress" },
        { content: "write fix", status: "pending" },
      ],
    });
    expect(tools.todos).toHaveLength(2);
    expect(tools.todos[0]!.status).toBe("in_progress");

    await tools.handlers.todo_write!.run({
      todos: [{ content: "ship it", status: "pending" }],
    });
    expect(tools.todos).toHaveLength(1);
    expect(tools.todos[0]!.content).toBe("ship it");
  });

  it("returns the rendered list", async () => {
    const tools = makeToolset(noopExecutor);
    const out = await tools.handlers.todo_write!.run({
      todos: [
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "in_progress" },
        { content: "step 3", status: "pending" },
      ],
    });
    expect(out).toContain("[x] step 1");
    expect(out).toContain("[>] step 2");
    expect(out).toContain("[ ] step 3");
  });

  it("rejects malformed input via zod", async () => {
    const tools = makeToolset(noopExecutor);
    const out = await tools.handlers.todo_write!.run({ todos: "nope" });
    expect(out).toContain("todo_write");
  });

  it("rejects status values outside the enum", async () => {
    const tools = makeToolset(noopExecutor);
    const out = await tools.handlers.todo_write!.run({
      todos: [{ content: "x", status: "blocked" }],
    });
    expect(out).toContain("todo_write");
  });

  it("renderTodos returns empty marker for empty list", () => {
    expect(renderTodos([])).toBe("(no todos)");
  });
});
