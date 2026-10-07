import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { GitHubClient, PullRequestRef } from "../src/adapters/github.ts";
import { GLMClient } from "../src/adapters/glm.ts";
import type { AssignedIssue, LinearAdapter } from "../src/adapters/linear.ts";
import * as agent from "../src/agent/loop.ts";
import * as executorFactory from "../src/executors/factory.ts";
import type { ExecResult, Executor } from "../src/executors/index.ts";
import * as git from "../src/git.ts";
import { runCodeHandler, type CodeHandlerDeps } from "../src/handlers/code.ts";
import { createProvider, createProviderChain } from "../src/providers.ts";
import * as reviewer from "../src/review/runner.ts";
import * as skills from "../src/skills.ts";
import { openDb } from "../src/state/db.ts";
import { getTicket, upsertTicket } from "../src/state/queries.ts";
import { recordReviewPass } from "../src/state/review-queries.ts";

const issue: AssignedIssue = {
  id: "offline-issue", identifier: "FIX-1", title: "Offline handler fixture", description: "Small fixture change",
  url: "https://linear.invalid/FIX-1", stateName: "Todo", stateType: "unstarted",
  createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
  creatorId: null, creatorName: null, teamId: "offline-team", teamKey: "FIX", blockedBy: [],
};

const restores: Array<{ mockRestore(): void }> = [];
function restoreAfter<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(spy);
  return spy;
}

function loopResult(status: agent.AgentLoopStatus, summary = "Fixture summary"): agent.AgentLoopResult {
  return {
    status, summary, iterations: 1, inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0, phase: "implement", runLog: [],
  };
}

function checkResult(exitCode = 0): ExecResult {
  return { exitCode, stdout: "", stderr: exitCode ? "Fixture check failure" : "", timedOut: false };
}

function reviewResult(verdict: "approve" | "changes_needed" = "approve"): reviewer.ReviewerResult {
  return {
    kind: "verdict",
    review: {
      verdict,
      findings: verdict === "approve" ? [] : [{ title: "Fixture finding", detail: "Fix fixture branch", bugClass: "wrong_code_path" }],
      advisoryNotes: [], verificationReport: "Fixture checks passed",
    },
  };
}

function makeFixture() {
  let now = 1_000_000;
  restoreAfter(spyOn(Date, "now")).mockImplementation(() => now);
  const db = openDb(":memory:");
  upsertTicket(db, { linearId: issue.id, identifier: issue.identifier });
  const provider = createProvider(
    { name: "z.ai", apiKey: "offline-fixture", baseUrl: "https://provider.invalid", model: "fake", defaultBackoffMs: 1000 },
    { fetch: (async () => { throw new Error("Network forbidden in offline handler tests"); }) as unknown as typeof fetch },
  );
  const glm = new GLMClient(createProviderChain([provider]));
  const complete = restoreAfter(spyOn(glm, "complete")).mockResolvedValue("Fixture PR text");
  const run = mock<Executor["run"]>(async () => checkResult());
  const executor: Executor = {
    workspaceRoot: "/offline/workspaces/FIX-1",
    run, readFile: async () => "fixture", writeFile: async () => {}, listFiles: async () => [], grep: async () => [],
  };
  restoreAfter(spyOn(executorFactory, "createWorkspaceExecutor")).mockReturnValue(executor);
  restoreAfter(spyOn(skills, "loadProjectContext")).mockReturnValue({ claudeMd: null, agentsMd: null, hasBeads: false });
  restoreAfter(spyOn(skills, "loadSkillIndex")).mockReturnValue([]);
  restoreAfter(spyOn(git, "ensureBareClone")).mockResolvedValue("/offline/repos/fixture.git");
  restoreAfter(spyOn(git, "createWorktree")).mockResolvedValue(undefined);
  const hasCommits = restoreAfter(spyOn(git, "hasCommitsAhead")).mockResolvedValue(true);
  restoreAfter(spyOn(git, "getDiff")).mockResolvedValue("diff --git a/README.md b/README.md\n+fixture change\n");
  restoreAfter(spyOn(git, "getCommitLog")).mockResolvedValue("abc123 fixture change");
  restoreAfter(spyOn(git, "gitMust")).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  const rebase = restoreAfter(spyOn(git, "rebaseOntoFreshBase")).mockResolvedValue({ kind: "no_op", sha: "abc123" });
  const push = restoreAfter(spyOn(git, "pushBranch")).mockResolvedValue(undefined);
  const primary = restoreAfter(spyOn(agent, "runAgentLoop")).mockResolvedValue(loopResult("finished"));
  const review = restoreAfter(spyOn(reviewer, "runReviewer")).mockResolvedValue(reviewResult());
  const pr: PullRequestRef = {
    owner: "fixture", repo: "repo", number: 1, url: "https://github.invalid/fixture/repo/pull/1", headSha: "abc123",
    state: "open", merged: false, isDraft: false, createdAt: "2026-10-06T00:00:00Z",
  };
  const openPr = mock<GitHubClient["openPullRequest"]>(async () => pr);
  const postComment = mock<LinearAdapter["postComment"]>(async () => "offline-comment");
  const deps: CodeHandlerDeps = {
    db, glm, cloudflare: null,
    github: { cloneUrl: async () => "https://github.invalid/fixture/repo.git", getViewer: async () => ({ login: "fixture" }), openPullRequest: openPr } as unknown as GitHubClient,
    linear: { postComment, unassign: async () => {}, addPrAttachment: async () => {} } as unknown as LinearAdapter,
    reposDir: "/offline/repos", workspacesDir: "/offline/workspaces",
    agentLoopMaxIterations: 50, agentLoopTimeoutMs: 1000,
    review: { providerOrder: ["z.ai"], maxRounds: 2, iterationCap: 15, timeoutMs: 1000 },
  };
  return {
    db, deps, run, hasCommits, primary, review, complete, push, openPr, rebase, postComment, pr,
    expire() { now += 1001; },
    invoke: () => runCodeHandler(deps, { issue, comments: [], repo: "fixture/repo", scope: "S" }),
  };
}

let f: ReturnType<typeof makeFixture>;
beforeEach(() => { f = makeFixture(); });
afterEach(() => {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
  f.db.close();
});

function expectNoDelivery(): void {
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.push).not.toHaveBeenCalled();
  expect(f.openPr).not.toHaveBeenCalled();
  expect(f.db.query("SELECT * FROM prs").all()).toEqual([]);
  expect(getTicket(f.db, issue.id)?.terminal_state).toBe("escalated");
}

/** Keep reviewer persistence real while replacing every model invocation. */
function scriptReviews(results: reviewer.ReviewerResult[], afterInvocation?: (count: number) => void): void {
  let count = 0;
  f.review.mockImplementation(async (args) => {
    const result = results[count++];
    if (!result) throw new Error("Unexpected extra reviewer invocation");
    recordReviewPass(args.db, {
      issueLinearId: args.issueLinearId, fingerprint: args.fingerprint, round: args.round,
      verdict: result.kind === "failed" ? "failed" : result.review.verdict,
      findingCount: result.kind === "failed" ? 0 : result.review.findings.length,
      advisoryCount: 0, providerUsed: "offline", inputTokens: 0, outputTokens: 0,
      durationMs: 0, escalated: false,
    });
    afterInvocation?.(count);
    return result;
  });
}

function reviewEvents(eventType: string): unknown[] {
  return f.db.query<{ payload_json: string }, [string]>(
    "SELECT payload_json FROM events WHERE event_type = ? ORDER BY id",
  ).all(eventType).map((row) => JSON.parse(row.payload_json));
}

function reviewRows(): Array<{ round: number; verdict: string; escalated: number }> {
  return f.db.query<{ round: number; verdict: string; escalated: number }, []>(
    "SELECT round, verdict, escalated FROM review_passes ORDER BY id",
  ).all();
}

describe("CODE handler blocked exits", () => {
  it("stops primary blocked work even when the branch has commits", async () => {
    f.primary.mockResolvedValue(loopResult("blocked", "Missing fixture dependency; partial changes committed"));
    expect((await f.invoke()).status).toBe("blocked");
    expect(f.hasCommits).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.postComment.mock.calls[0]?.[1]).toContain("Missing fixture dependency");
    expectNoDelivery();
  });

  it("does not recheck or review after a blocked check-fixup", async () => {
    f.primary.mockResolvedValueOnce(loopResult("finished")).mockResolvedValueOnce(loopResult("blocked", "Fixture dependency unavailable"));
    f.run.mockResolvedValueOnce(checkResult(1));
    expect((await f.invoke()).status).toBe("blocked");
    expect(f.primary).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.postComment.mock.calls[0]?.[1]).toContain("Fixture dependency unavailable");
    expectNoDelivery();
  });

  it("does not run another check or review after a blocked reviewer-fixup", async () => {
    f.primary.mockResolvedValueOnce(loopResult("finished")).mockResolvedValueOnce(loopResult("blocked", "Fixture reviewer request is blocked"));
    f.review.mockResolvedValueOnce(reviewResult("changes_needed"));
    expect((await f.invoke()).status).toBe("blocked");
    expect(f.primary).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(1);
    expectNoDelivery();
  });
});

describe("CODE handler unavailable reviews", () => {
  it("escalates two failed attempts without inventing an approval or starting a fixup", async () => {
    scriptReviews([
      { kind: "failed", reason: "fixture provider unavailable" },
      { kind: "failed", reason: "fixture malformed verdict" },
    ]);
    const result = await f.invoke();
    expect(result.status).toBe("review_failed");
    expect(result.summary).toMatch(/review unavailable/i);
    expect(f.primary).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.rebase).not.toHaveBeenCalled();
    expect(reviewRows().map((row) => row.verdict)).toEqual(["failed", "failed"]);
    expect(reviewRows().at(-1)).toEqual({ round: 1, verdict: "failed", escalated: 1 });
    expect(reviewEvents("review_failed")).toEqual([{
      round: 1, reason: "fixture malformed verdict", firstReason: "fixture provider unavailable",
      attempts: 2, failureClass: "review_unavailable",
    }]);
    expect(reviewEvents("review_decision")).toEqual([]);
    expect(f.postComment).toHaveBeenCalledTimes(1);
    expect(f.postComment.mock.calls[0]?.[1]).toMatch(/no (?:review )?verdict/i);
    expectNoDelivery();
  });

  it("publishes after a failed attempt is followed by a valid approval", async () => {
    scriptReviews([{ kind: "failed", reason: "fixture transient error" }, reviewResult()]);
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.primary).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(reviewRows()).toEqual([
      { round: 1, verdict: "failed", escalated: 0 },
      { round: 1, verdict: "approve", escalated: 0 },
    ]);
    expect(reviewEvents("review_failed")).toEqual([]);
    expect(reviewEvents("review_decision")).toEqual([{ round: 1, verdict: "approve", finding_count: 0 }]);
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.openPr).toHaveBeenCalledTimes(1);
    expect(f.db.query("SELECT pr_number FROM prs").all()).toEqual([{ pr_number: 1 }]);
    expect(getTicket(f.db, issue.id)?.terminal_state).toBeNull();
  });

  it("requires a valid review of the repaired revision after earlier changes-needed feedback", async () => {
    scriptReviews([
      reviewResult("changes_needed"),
      { kind: "failed", reason: "fixture revision review unavailable" },
      { kind: "failed", reason: "fixture revision review still unavailable" },
    ]);
    expect((await f.invoke()).status).toBe("review_failed");
    expect(f.primary).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.review).toHaveBeenCalledTimes(3);
    expect(f.review.mock.calls.map(([args]) => args.round)).toEqual([1, 2, 2]);
    expect(f.review.mock.calls[1]![0].previousFindings).toHaveLength(1);
    expect(reviewRows()[0]).toEqual({ round: 1, verdict: "changes_needed", escalated: 0 });
    expect(reviewRows().at(-1)).toEqual({ round: 2, verdict: "failed", escalated: 1 });
    expect(reviewEvents("review_decision")).toEqual([{ round: 1, verdict: "changes_needed", finding_count: 1 }]);
    expect(reviewEvents("review_failed")).toEqual([{
      round: 2, reason: "fixture revision review still unavailable", firstReason: "fixture revision review unavailable",
      attempts: 2, failureClass: "review_unavailable",
    }]);
    expect(f.rebase).not.toHaveBeenCalled();
    expectNoDelivery();
  });
});

describe("CODE handler shared deadline", () => {
  it("records a late created PR without starting follow-up writes or reporting a false timeout", async () => {
    const attachment = restoreAfter(spyOn(f.deps.linear, "addPrAttachment"));
    f.openPr.mockImplementationOnce(async () => { f.expire(); return f.pr; });
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(f.db.query("SELECT pr_number FROM prs").all()).toEqual([{ pr_number: 1 }]);
    expect(attachment).not.toHaveBeenCalled();
    expect(f.postComment).not.toHaveBeenCalled();
    expect(getTicket(f.db, issue.id)?.terminal_state).toBeNull();
  });

  it("retains the delivered outcome when Linear metadata fails after PR creation", async () => {
    restoreAfter(spyOn(f.deps.linear, "addPrAttachment")).mockRejectedValueOnce(new Error("fixture unavailable"));
    f.postComment.mockRejectedValueOnce(new Error("fixture unavailable"));
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(f.db.query("SELECT pr_number FROM prs").all()).toEqual([{ pr_number: 1 }]);
  });
  it("passes one budget to primary, both fixups, checks, reviewers, and PR text", async () => {
    f.run.mockResolvedValueOnce(checkResult(1)).mockResolvedValue(checkResult());
    f.review.mockResolvedValueOnce(reviewResult("changes_needed")).mockResolvedValue(reviewResult());
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(f.primary).toHaveBeenCalledTimes(3);
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.complete).toHaveBeenCalledTimes(2);
    const parent = f.primary.mock.calls[0]![0];
    expect(parent.deadlineMs).toBe(1_001_000);
    expect(parent.signal).toBeInstanceOf(AbortSignal);
    const stages = [
      ...f.primary.mock.calls.map(([args]) => args),
      ...f.review.mock.calls.map(([args]) => args),
      ...f.run.mock.calls.map(([, opts]) => opts!),
      ...f.complete.mock.calls.map(([args]) => args),
    ];
    for (const stage of stages) {
      expect(stage.deadlineMs).toBe(parent.deadlineMs);
      expect(stage.signal).toBe(parent.signal);
    }
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.openPr).toHaveBeenCalledTimes(1);
  });

  it("does not start a fixup after the first check consumes the remaining budget", async () => {
    f.run.mockImplementationOnce(async () => {
      f.expire();
      return checkResult(1);
    });
    expect((await f.invoke()).status).toBe("timeout");
    expect(f.primary).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.review).not.toHaveBeenCalled();
    expectNoDelivery();
  });

  it("does not retry a failed reviewer after the shared budget expires", async () => {
    scriptReviews([{ kind: "failed", reason: "timeout" }], () => f.expire());
    expect((await f.invoke()).status).toBe("timeout");
    expect(f.primary).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.rebase).not.toHaveBeenCalled();
    expectNoDelivery();
  });

  it("does not publish when the retry returns approval after the shared deadline", async () => {
    scriptReviews([{ kind: "failed", reason: "fixture transient error" }, reviewResult()], (count) => {
      if (count === 2) f.expire();
    });
    expect((await f.invoke()).status).toBe("timeout");
    expect(f.primary).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.rebase).not.toHaveBeenCalled();
    expect(reviewEvents("review_decision")).toEqual([]);
    expectNoDelivery();
  });

  it("does not continue when a primary result arrives after the deadline", async () => {
    f.primary.mockImplementationOnce(async () => {
      f.expire();
      return loopResult("finished");
    });
    expect((await f.invoke()).status).toBe("timeout");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expectNoDelivery();
  });
});
