import { describe, expect, it } from "bun:test";
import type { LinearAdapter } from "../src/adapters/linear.ts";
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

function makeFakeLinear(overrides: Partial<LinearAdapter> = {}): LinearAdapter {
  const base = {
    fetchByIdentifier: async () => null,
    fetchComments: async () => [],
  };
  return { ...base, ...overrides } as unknown as LinearAdapter;
}

describe("get_linear_issue tool", () => {
  it("renders title, status, description, and comments", async () => {
    const linear = makeFakeLinear({
      fetchByIdentifier: async (id: string) => ({
        id: "uuid-1",
        identifier: id,
        title: "rate limiter is fighting itself",
        description: "interactive and batch contend for the same bucket",
        url: "https://linear.app/x/issue/ERT-1610/foo",
        stateName: "In Progress",
        stateType: "started",
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
        creatorId: "user-1",
        creatorName: "tanner",
        teamId: "team-1",
        teamKey: "ERT",
      }),
      fetchComments: async () => [
        {
          id: "c1",
          body: "split into two queues",
          createdAt: "2026-04-21T10:00:00.000Z",
          userId: "user-1",
          userName: "tanner",
        },
      ],
    });
    const tools = makeToolset(noopExecutor, { linear });
    const tool = tools.handlers.get_linear_issue!;
    const out = await tool.run({ identifier: "ERT-1610" });
    expect(out).toContain("ERT-1610: rate limiter is fighting itself");
    expect(out).toContain("In Progress (started)");
    expect(out).toContain("interactive and batch contend");
    expect(out).toContain("tanner (2026-04-21T10:00:00.000Z): split into two queues");
  });

  it("returns a friendly message when the ticket isn't found", async () => {
    const linear = makeFakeLinear();
    const tools = makeToolset(noopExecutor, { linear });
    const tool = tools.handlers.get_linear_issue!;
    const out = await tool.run({ identifier: "ERT-9999" });
    expect(out).toBe("no issue found for ERT-9999");
  });

  it("validates identifier shape via zod", async () => {
    const linear = makeFakeLinear();
    const tools = makeToolset(noopExecutor, { linear });
    const tool = tools.handlers.get_linear_issue!;
    await expect(tool.run({ identifier: "not-an-id" })).rejects.toThrow();
  });

  it("isn't registered when linear is not provided", () => {
    const tools = makeToolset(noopExecutor);
    expect(tools.handlers.get_linear_issue).toBeUndefined();
    expect(tools.definitions.find((d) => d.name === "get_linear_issue")).toBeUndefined();
  });
});
