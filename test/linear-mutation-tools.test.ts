import { describe, expect, it } from "bun:test";
import type { LinearAdapter, WorkflowStateType } from "../src/adapters/linear.ts";
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

const currentIssue = {
  id: "issue-uuid",
  identifier: "ERT-1569",
  teamId: "team-uuid",
};

function makeFakeLinear(overrides: Partial<LinearAdapter> = {}): LinearAdapter {
  const base = {
    unassign: async () => {},
    setStateByType: async () => ({ stateName: "Backlog" }),
    updateDescription: async () => {},
  };
  return { ...base, ...overrides } as unknown as LinearAdapter;
}

describe("linear mutation tools", () => {
  describe("registration", () => {
    it("does not register mutation tools when currentIssue is missing", () => {
      const linear = makeFakeLinear();
      const tools = makeToolset(noopExecutor, { linear });
      expect(tools.handlers.unassign_self).toBeUndefined();
      expect(tools.handlers.set_ticket_state).toBeUndefined();
      expect(tools.handlers.update_ticket_description).toBeUndefined();
    });

    it("does not register mutation tools when linear is missing", () => {
      const tools = makeToolset(noopExecutor, { currentIssue });
      expect(tools.handlers.unassign_self).toBeUndefined();
      expect(tools.handlers.set_ticket_state).toBeUndefined();
      expect(tools.handlers.update_ticket_description).toBeUndefined();
    });

    it("registers mutation tools when both linear and currentIssue are set", () => {
      const linear = makeFakeLinear();
      const tools = makeToolset(noopExecutor, { linear, currentIssue });
      expect(tools.handlers.unassign_self).toBeDefined();
      expect(tools.handlers.set_ticket_state).toBeDefined();
      expect(tools.handlers.update_ticket_description).toBeDefined();
    });
  });

  describe("unassign_self", () => {
    it("calls linear.unassign with the current issue id", async () => {
      const calls: string[] = [];
      const linear = makeFakeLinear({
        unassign: async (id: string) => {
          calls.push(id);
        },
      });
      const tools = makeToolset(noopExecutor, { linear, currentIssue });
      const out = await tools.handlers.unassign_self!.run({});
      expect(calls).toEqual(["issue-uuid"]);
      expect(out).toContain("ERT-1569");
    });

    it("returns a formatted error string when the adapter throws", async () => {
      const linear = makeFakeLinear({
        unassign: async () => {
          throw new Error("network down");
        },
      });
      const tools = makeToolset(noopExecutor, { linear, currentIssue });
      const out = await tools.handlers.unassign_self!.run({});
      expect(out).toContain("unassign_self");
      expect(out).toContain("network down");
    });
  });

  describe("set_ticket_state", () => {
    it("forwards the type to setStateByType and returns the state name", async () => {
      const calls: { issueId: string; teamId: string; type: WorkflowStateType }[] = [];
      const linear = makeFakeLinear({
        setStateByType: async (issueId: string, teamId: string, type: WorkflowStateType) => {
          calls.push({ issueId, teamId, type });
          return { stateName: "Backlog" };
        },
      });
      const tools = makeToolset(noopExecutor, { linear, currentIssue });
      const out = await tools.handlers.set_ticket_state!.run({ type: "backlog" });
      expect(calls).toEqual([
        { issueId: "issue-uuid", teamId: "team-uuid", type: "backlog" },
      ]);
      expect(out).toContain("ERT-1569");
      expect(out).toContain("Backlog");
    });

    it("rejects invalid state types via zod", async () => {
      const linear = makeFakeLinear();
      const tools = makeToolset(noopExecutor, { linear, currentIssue });
      const out = await tools.handlers.set_ticket_state!.run({ type: "shipped" });
      expect(out).toContain("set_ticket_state");
    });
  });

  describe("update_ticket_description", () => {
    it("calls linear.updateDescription with the new body", async () => {
      const calls: { issueId: string; description: string }[] = [];
      const linear = makeFakeLinear({
        updateDescription: async (issueId: string, description: string) => {
          calls.push({ issueId, description });
        },
      });
      const tools = makeToolset(noopExecutor, { linear, currentIssue });
      const out = await tools.handlers.update_ticket_description!.run({
        description: "new body with **markdown**",
      });
      expect(calls).toEqual([
        { issueId: "issue-uuid", description: "new body with **markdown**" },
      ]);
      expect(out).toContain("ERT-1569");
    });

    it("rejects missing description via zod", async () => {
      const linear = makeFakeLinear();
      const tools = makeToolset(noopExecutor, { linear, currentIssue });
      const out = await tools.handlers.update_ticket_description!.run({});
      expect(out).toContain("update_ticket_description");
    });
  });
});
