import { expect, it, mock, spyOn } from "bun:test";
import { LinearAdapter } from "../src/adapters/linear.ts";
import { makeToolset } from "../src/agent/tools.ts";
import type { Executor } from "../src/executors/index.ts";

it("a late workflow-state lookup cannot start the subsequent issue mutation", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const update = mock(async () => ({}));
  const linear = Object.assign(Object.create(LinearAdapter.prototype), {
    client: { updateIssue: update },
    async fetchTeamStates() { now = 2001; return [{ id: "state", name: "Backlog", type: "backlog" }]; },
  }) as LinearAdapter;
  try {
    const tools = makeToolset({ workspaceRoot: "/offline" } as Executor, {
      linear, deadlineMs: 2000,
      currentIssue: { id: "issue", identifier: "FIX-1", teamId: "team" },
    });
    const result = await tools.handlers["set_ticket_state"]!.run({ type: "backlog" });
    expect(result).toContain("deadline exceeded");
    expect(update).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it("a late issue read cannot start a second adapter request", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const comments = mock(async () => []);
  const linear = {
    async fetchByIdentifier() { now = 2001; return { id: "fixture" }; },
    fetchComments: comments,
  } as unknown as LinearAdapter;
  const executor = { workspaceRoot: "/offline" } as Executor;
  try {
    const tools = makeToolset(executor, { linear, deadlineMs: 2000 });
    const result = await tools.handlers["get_linear_issue"]!.run({ identifier: "FIX-1", include_comments: true });
    expect(result).toContain("deadline exceeded");
    expect(comments).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});
