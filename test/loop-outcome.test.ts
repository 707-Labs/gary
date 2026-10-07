import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AssignedIssue, LinearAdapter } from "../src/adapters/linear.ts";
import type { GitHubClient } from "../src/adapters/github.ts";
import { GLMClient } from "../src/adapters/glm.ts";
import * as codeHandler from "../src/handlers/code.ts";
import { tick, type LoopDeps } from "../src/loop.ts";
import { AllProvidersExhaustedError, createProvider, createProviderChain } from "../src/providers.ts";
import { openDb, type DB } from "../src/state/db.ts";
import { getRevisitMark, getTicket, setClassification, setTerminalState, upsertTicket } from "../src/state/queries.ts";

const issue: AssignedIssue = {
  id: "issue-1", identifier: "ERT-1", title: "Offline fixture", description: "A fixed description",
  url: "https://linear.invalid/issue/ERT-1", stateName: "Todo", stateType: "unstarted",
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  creatorId: null, creatorName: null, teamId: "team-1", teamKey: "ERT", blockedBy: [],
};

let db: DB;
let deps: LoopDeps;
let coding: ReturnType<typeof spyOn<typeof codeHandler, "runCodeHandler">>;

beforeEach(() => {
  db = openDb(":memory:");
  upsertTicket(db, { linearId: issue.id, identifier: issue.identifier });
  setClassification(db, { linearId: issue.id, classification: "CODE", confidence: 0.9, scope: "S" });
  const provider = createProvider(
    { name: "z.ai", apiKey: "offline-fixture", baseUrl: "https://provider.invalid", model: "fake", defaultBackoffMs: 1000 },
    { fetch: (async () => { throw new Error("Network is forbidden in this test"); }) as unknown as typeof fetch },
  );
  deps = {
    db,
    linear: {
      linearUserId: "gary",
      fetchAssignedIssues: async () => [issue],
      fetchCommentMeta: async () => [],
      fetchComments: async () => [],
      postComment: async () => {},
      unassign: async () => {},
    } as unknown as LinearAdapter,
    github: {} as GitHubClient,
    glm: new GLMClient(createProviderChain([provider])), cloudflare: null,
    repoMap: new Map([["ERT", "fixture/repo"]]), allowlistedMentionUserIds: [],
    reposDir: "/offline/repos", workspacesDir: "/offline/workspaces",
    agentLoopMaxIterations: 5, agentLoopTimeoutMs: 1000,
    maxCiAttempts: 3, maxAttemptsPerTicket: 5, circuitBreakerWindowHours: 6, stalePrAfterMs: 1000,
    review: { providerOrder: ["z.ai"], maxRounds: 1, iterationCap: 1, timeoutMs: 1000 },
  };
  coding = spyOn(codeHandler, "runCodeHandler");
});

afterEach(() => {
  coding.mockRestore();
  db.close();
});

function actionRows(): Array<{ success: number; outcome: string; error_message: string | null }> {
  return db.query<{ success: number; outcome: string; error_message: string | null }, []>(
    "SELECT success, outcome, error_message FROM actions ORDER BY id",
  ).all();
}

describe("tick outcome reporting", () => {
  for (const status of ["pr_opened", "no_changes", "agent_failed", "blocked", "timeout", "check_failed", "review_failed"] as const) {
    it(`records ${status} from the coding handler without re-dispatching unchanged input`, async () => {
      coding.mockImplementation(async () => {
        if (!["pr_opened", "no_changes"].includes(status)) setTerminalState(db, issue.id, "escalated");
        return { status, branch: "fixture", summary: "Offline fixture" };
      });
      const first = await tick(deps);
      expect(first.actionsTaken).toEqual(["start_coding"]);
      expect(actionRows()).toEqual([{ success: 1, outcome: status, error_message: null }]);
      expect(getRevisitMark(db, issue.id)).not.toBeNull();

      // Simulate Gary still assigned after best-effort escalation. Reopening
      // the terminal state must not turn a delivery failure into a retry loop.
      const second = await tick(deps);
      expect(second.actionsTaken).toEqual([]);
      expect(coding).toHaveBeenCalledTimes(1);
      expect(actionRows()).toHaveLength(1);
    });
  }

  it("records an unmapped team's handled escalation explicitly", async () => {
    deps.repoMap = new Map();
    await tick(deps);
    expect(actionRows()).toEqual([{ success: 1, outcome: "escalated", error_message: null }]);
    expect(getTicket(db, issue.id)?.terminal_state).toBe("escalated");
    expect(coding).not.toHaveBeenCalled();
  });

  it("records a non-coding handler as handled without claiming delivery", async () => {
    deps.linear.fetchAssignedIssues = async () => [{
      ...issue,
      blockedBy: [{ id: "blocker-1", identifier: "ERT-2", stateName: "Todo", stateType: "unstarted", isOpen: true }],
    }];
    expect((await tick(deps)).actionsTaken).toEqual(["wait_for_blocker"]);
    expect(actionRows()).toEqual([{ success: 1, outcome: "handled", error_message: null }]);
    expect(coding).not.toHaveBeenCalled();
  });

  it("keeps thrown failures retryable and distinct from handled results", async () => {
    coding.mockRejectedValue(new Error("fixture failure"));
    await tick(deps);
    expect(actionRows()).toEqual([{ success: 0, outcome: "error", error_message: "fixture failure" }]);
    await tick(deps);
    expect(coding).toHaveBeenCalledTimes(2);
  });

  it("records provider exhaustion without claiming delivery or counting a dispatched result", async () => {
    coding.mockRejectedValue(new AllProvidersExhaustedError(null));
    expect((await tick(deps)).actionsTaken).toEqual([]);
    expect(actionRows()).toEqual([{ success: 0, outcome: "rate_limited", error_message: "all providers armed; earliest reset unknown" }]);
  });
});
