import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { GitHubClient } from "../src/adapters/github.ts";
import type { GLMClient } from "../src/adapters/glm.ts";
import type { AssignedIssue, LinearAdapter } from "../src/adapters/linear.ts";
import * as agent from "../src/agent/loop.ts";
import * as executorFactory from "../src/executors/factory.ts";
import type { Executor } from "../src/executors/index.ts";
import * as git from "../src/git.ts";
import { runAnswerHandler, type AnswerHandlerDeps } from "../src/handlers/answer.ts";
import { runCiFailureHandler, type CiFailureHandlerDeps } from "../src/handlers/ci-failure.ts";
import { runPrReviewHandler, type PrReviewHandlerDeps } from "../src/handlers/pr-review.ts";
import * as skills from "../src/skills.ts";
import { SpendLedger } from "../src/spend.ts";
import { openDb } from "../src/state/db.ts";
import * as queries from "../src/state/queries.ts";

const issue: AssignedIssue = {
  id: "offline-publication", identifier: "FIX-1", title: "Publication fixture", description: "Offline only",
  url: "https://linear.invalid/FIX-1", stateName: "In Progress", stateType: "started",
  createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
  creatorId: null, creatorName: null, teamId: "fixture", teamKey: "FIX", blockedBy: [],
};
const restores: Array<{ mockRestore(): void }> = [];
function restoreAfter<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(spy);
  return spy;
}

function makeFixture() {
  const db = openDb(":memory:");
  const spend = new SpendLedger(":memory:");
  spend.createCampaign("offline", 5);
  spend.enrollTicket("offline", issue.id, 5);
  let head = "before";
  let closeDuringAgent = false;
  let agentMakesCommit = true;
  const close = () => spend.markTerminal(issue.id, "operator_stopped");
  const executor: Executor = {
    workspaceRoot: "/offline/workspaces/FIX-1",
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    readFile: async () => "fixture", writeFile: async () => {}, listFiles: async () => [], grep: async () => [],
  };
  restoreAfter(spyOn(executorFactory, "createWorkspaceExecutor")).mockReturnValue(executor);
  restoreAfter(spyOn(skills, "loadProjectContext")).mockReturnValue({ claudeMd: null, agentsMd: null, hasBeads: false });
  restoreAfter(spyOn(skills, "loadSkillIndex")).mockReturnValue([]);
  restoreAfter(spyOn(git, "ensureBareClone")).mockResolvedValue("/offline/repos/fixture.git");
  restoreAfter(spyOn(git, "createWorktree")).mockResolvedValue(undefined);
  restoreAfter(spyOn(git, "hasCommitsAhead")).mockResolvedValue(true);
  restoreAfter(spyOn(git, "gitRun")).mockImplementation(async () => ({ stdout: head, stderr: "", exitCode: 0 }));
  const push = restoreAfter(spyOn(git, "pushBranch")).mockResolvedValue(undefined);
  const markResponded = restoreAfter(spyOn(queries, "markPrCommentsResponded")).mockImplementation(() => {});
  restoreAfter(spyOn(agent, "runAgentLoop")).mockImplementation(async () => {
    if (agentMakesCommit) head = "after";
    if (closeDuringAgent) close();
    // A parent can finish after a subagent exhausts the shared allocation.
    // The handler must check the ledger even when this status is successful.
    return { status: "finished", summary: "Fixture response", iterations: 1, inputTokens: 0,
      outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, phase: "implement", runLog: [] };
  });
  const postComment = mock<LinearAdapter["postComment"]>(async () => "offline-comment");
  const comment = mock<GitHubClient["comment"]>(async () => {});
  const deps: CiFailureHandlerDeps & PrReviewHandlerDeps & AnswerHandlerDeps = {
    db, cloudflare: null, reposDir: "/offline/repos", workspacesDir: "/offline/workspaces",
    agentLoopMaxIterations: 3, agentLoopTimeoutMs: 1000, maxCiAttempts: 3,
    glm: { createMessage: async () => { throw new Error("Network forbidden in offline fixture"); } } as unknown as GLMClient,
    linear: { linearUserId: "gary", postComment } as unknown as LinearAdapter,
    github: {
      cloneUrl: async () => "https://github.invalid/fixture/repo.git", getViewer: async () => ({ login: "gary" }), comment,
      getFailingCheckDetails: async () => [{ name: "check", conclusion: "failure", outputTitle: "fixture failure", outputSummary: null, outputText: null, htmlUrl: "", detailsUrl: "" }],
      getPullRequestComments: async () => [{ id: 1, authorType: "User", authorLogin: "reviewer", kind: "issue", body: "Please fix the fixture", createdAt: "2026-10-07T00:00:00Z", htmlUrl: "" }],
      getPullRequestDetail: async () => null,
    } as unknown as GitHubClient,
    assertCanPublish: () => {
      if (spend.status(issue.id)?.state !== "active") throw new Error("Fixture allocation closed before publication");
    },
  };
  return {
    db, spend, deps, push, postComment, comment, markResponded, close,
    closeDuringAgent() { closeDuringAgent = true; },
    replyOnly() { agentMakesCommit = false; },
    ci: () => runCiFailureHandler(deps, { issue, repo: "fixture/repo", prNumber: 1, branch: "fixture", headSha: "before" }),
    review: () => runPrReviewHandler(deps, { issue, repo: "fixture/repo", prGithubId: 1, prNumber: 1, branch: "fixture" }),
    answer: () => runAnswerHandler(deps, { issue, repo: "fixture/repo", comments: [] }),
  };
}

let f: ReturnType<typeof makeFixture>;
beforeEach(() => { f = makeFixture(); });
afterEach(() => {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
  f.spend.close();
  f.db.close();
});

describe("handler publication guards", () => {
  it("blocks a finished CI fix when its allocation closed during execution", async () => {
    f.closeDuringAgent();
    await expect(f.ci()).rejects.toThrow("allocation closed before publication");
    expect(f.push).not.toHaveBeenCalled();
  });

  it("blocks a finished review fix and reply when its allocation closed during execution", async () => {
    f.closeDuringAgent();
    await expect(f.review()).rejects.toThrow("allocation closed before publication");
    expect(f.push).not.toHaveBeenCalled();
    expect(f.comment).not.toHaveBeenCalled();
    expect(f.markResponded).not.toHaveBeenCalled();
  });

  it("checks the guard for reply-only reviews", async () => {
    f.replyOnly();
    f.closeDuringAgent();
    await expect(f.review()).rejects.toThrow("allocation closed before publication");
    expect(f.push).not.toHaveBeenCalled();
    expect(f.comment).not.toHaveBeenCalled();
    expect(f.markResponded).not.toHaveBeenCalled();
  });

  it("rechecks before replying if the allocation closes while pushing a review fix", async () => {
    f.push.mockImplementationOnce(async () => { f.close(); });
    await expect(f.review()).rejects.toThrow("allocation closed before publication");
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.comment).not.toHaveBeenCalled();
    expect(f.markResponded).not.toHaveBeenCalled();
  });

  it("blocks an answer after a finished investigation whose allocation closed", async () => {
    f.closeDuringAgent();
    await expect(f.answer()).rejects.toThrow("allocation closed before publication");
    expect(f.postComment).not.toHaveBeenCalled();
  });

  it("preserves normal publication while the allocation remains active", async () => {
    expect((await f.ci()).status).toBe("fix_pushed");
    expect((await f.review()).status).toBe("replied");
    expect((await f.answer()).status).toBe("answered");
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.comment).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledTimes(1);
    expect(f.markResponded).toHaveBeenCalledTimes(1);
  });
});
