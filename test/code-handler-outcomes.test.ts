import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { GitHubClient, PullRequestRef } from "../src/adapters/github.ts";
import { GLMClient } from "../src/adapters/glm.ts";
import type { AssignedIssue, LinearAdapter } from "../src/adapters/linear.ts";
import * as agent from "../src/agent/loop.ts";
import * as executorFactory from "../src/executors/factory.ts";
import type { ExecResult, Executor } from "../src/executors/index.ts";
import * as git from "../src/git.ts";
import { runCodeHandler, type CodeHandlerArgs, type CodeHandlerDeps, type CodePublicationReceipt } from "../src/handlers/code.ts";
import { createProvider, createProviderChain } from "../src/providers.ts";
import * as reviewer from "../src/review/runner.ts";
import * as skills from "../src/skills.ts";
import { openDb } from "../src/state/db.ts";
import { getTicket, upsertTicket } from "../src/state/queries.ts";
import { recordReviewPass } from "../src/state/review-queries.ts";
import { SpendLedger } from "../src/spend.ts";

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

const RECEIPT_HEAD = 'a'.repeat(40);
const REBASED_HEAD = 'b'.repeat(40);
function capturePublication() {
  const receipts: Readonly<CodePublicationReceipt>[] = [];
  const head = restoreAfter(spyOn(git, 'getHeadSha')).mockResolvedValue(RECEIPT_HEAD);
  f.pr.headSha = RECEIPT_HEAD;
  f.deps.runAdmittedAgentLoop = async () => loopResult('finished');
  f.deps.onPublicationReceipt = receipt => {
    expect(f.openPr).toHaveBeenCalledTimes(1);
    expect(f.db.query('SELECT COUNT(*) AS n FROM prs').get()).toEqual({ n: 1 });
    receipts.push(structuredClone(receipt));
  };
  return { receipts, head };
}

function strictPublication() {
  const c=capturePublication();
  f.deps.strictPublicationArtifact=true;
  const artifact={headSha:RECEIPT_HEAD,baseSha:'c'.repeat(40),treeSha:'d'.repeat(40),branchSha:RECEIPT_HEAD,dirty:false};
  c.head.mockImplementation(async()=>artifact.headSha);
  f.gitCommand.mockImplementation(async args=>({stdout:args[0]==='rev-parse'
    ? [artifact.headSha,artifact.treeSha,artifact.baseSha,artifact.branchSha].join('\n')+'\n'
    : artifact.dirty?'?? unexpected.txt\n':'',stderr:'',exitCode:0}));
  f.rebase.mockImplementation(async()=>({kind:'no_op',sha:artifact.headSha}));
  return {...c,artifact};
}

describe('CODE strict canary publication artifact',()=>{
  it('publishes only the clean artifact that passed the full check and independent approval',async()=>{
    const c=strictPublication();
    expect((await f.invoke({draftPr:true})).status).toBe('pr_opened');
    expect(c.receipts[0]?.exactArtifact).toEqual({headSha:RECEIPT_HEAD,baseSha:'c'.repeat(40),treeSha:'d'.repeat(40),worktreeClean:true});
    expect(f.push.mock.calls[0]?.[0].sourceCommit).toBe(RECEIPT_HEAD);
    expect(f.run).toHaveBeenCalledTimes(1);expect(f.run.mock.calls[0]?.[0]).toBe('bun run check');
    expect(f.review).toHaveBeenCalledTimes(1);expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.push).toHaveBeenCalledTimes(1);expect(f.openPr).toHaveBeenCalledTimes(1);
    expect(f.gitCommand.mock.calls.some(([args])=>args.join(' ')==='status --porcelain=v1 --untracked-files=all')).toBe(true);
  });

  for(const field of ['headSha','baseSha','treeSha','dirty'] as const) it('rejects '+field+' mutation during the full check before review',async()=>{
    const c=strictPublication();
    f.run.mockImplementation(async()=>{
      if(field==='dirty')c.artifact.dirty=true;else c.artifact[field]='e'.repeat(40);
      if(field==='headSha')c.artifact.branchSha=c.artifact.headSha;
      return checkResult();
    });
    await expect(f.invoke()).rejects.toThrow('strict_publication_');
    expect(f.review).not.toHaveBeenCalled();expect(f.complete).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled();expect(f.openPr).not.toHaveBeenCalled();expect(c.receipts).toEqual([]);
  });

  it('rejects a timed-out full check even if the executor reports exit zero',async()=>{
    strictPublication();f.run.mockResolvedValue({...checkResult(),timedOut:true});
    await expect(f.invoke()).rejects.toThrow('strict_publication_check_unverified');
    expect(f.review).not.toHaveBeenCalled();expect(f.push).not.toHaveBeenCalled();
  });

  for(const field of ['headSha','baseSha','treeSha','dirty'] as const) it('rejects '+field+' mutation during independent approval',async()=>{
    const c=strictPublication();
    f.review.mockImplementation(async()=>{
      if(field==='dirty')c.artifact.dirty=true;else c.artifact[field]='e'.repeat(40);
      if(field==='headSha')c.artifact.branchSha=c.artifact.headSha;
      return reviewResult();
    });
    await expect(f.invoke()).rejects.toThrow('strict_publication_');
    expect(f.rebase).not.toHaveBeenCalled();expect(f.complete).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled();expect(f.openPr).not.toHaveBeenCalled();
  });

  for(const kind of ['clean','conflict'] as const) it('aborts a '+kind+' rebase before extra checks, PR text or publication',async()=>{
    strictPublication();
    f.rebase.mockResolvedValue(kind==='clean'?{kind,preRebaseSha:RECEIPT_HEAD,postRebaseSha:REBASED_HEAD}:{kind,preRebaseSha:RECEIPT_HEAD});
    await expect(f.invoke()).rejects.toThrow('strict_publication_rebase_changed');
    expect(f.run).toHaveBeenCalledTimes(1);expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.complete).not.toHaveBeenCalled();expect(f.push).not.toHaveBeenCalled();expect(f.openPr).not.toHaveBeenCalled();
  });

  it('a no-op rebase result cannot hide a changed base with the same HEAD and tree',async()=>{
    const c=strictPublication();
    f.rebase.mockImplementation(async()=>{c.artifact.baseSha='e'.repeat(40);return {kind:'no_op',sha:RECEIPT_HEAD};});
    await expect(f.invoke()).rejects.toThrow('strict_publication_artifact_changed');
    expect(f.complete).not.toHaveBeenCalled();expect(f.push).not.toHaveBeenCalled();
  });

  it('enforces the strict guard when readiness receipt capture is omitted',async()=>{
    strictPublication();delete f.deps.onPublicationReceipt;
    f.rebase.mockResolvedValue({kind:'clean',preRebaseSha:RECEIPT_HEAD,postRebaseSha:REBASED_HEAD});
    await expect(f.invoke()).rejects.toThrow('strict_publication_rebase_changed');
    expect(f.push).not.toHaveBeenCalled();expect(f.openPr).not.toHaveBeenCalled();
  });

  it('rechecks the approved artifact after PR text generation before push',async()=>{
    const c=strictPublication();
    f.complete.mockImplementation(async()=>{c.artifact.treeSha='e'.repeat(40);return 'offline metadata';});
    await expect(f.invoke()).rejects.toThrow('strict_publication_artifact_changed');
    expect(f.push).not.toHaveBeenCalled();expect(f.openPr).not.toHaveBeenCalled();expect(c.receipts).toEqual([]);
  });

  it('rechecks after push before creating a PR if a hook changed the local artifact',async()=>{
    const c=strictPublication();f.push.mockImplementation(async()=>{c.artifact.dirty=true;});
    await expect(f.invoke()).rejects.toThrow('strict_publication_artifact_unverified');
    expect(f.push).toHaveBeenCalledTimes(1);expect(f.openPr).not.toHaveBeenCalled();
    expect(f.db.query('SELECT * FROM prs').all()).toEqual([]);expect(c.receipts).toEqual([]);
  });

  for(const kind of ['unknown','different-branch','dirty','changing-observation'] as const) it('fails closed on '+kind+' initial artifact evidence',async()=>{
    const c=strictPublication();
    if(kind==='unknown')c.artifact.baseSha='unknown';
    else if(kind==='different-branch')c.artifact.branchSha=REBASED_HEAD;
    else if(kind==='dirty')c.artifact.dirty=true;
    else {
      let reads=0;
      f.gitCommand.mockImplementation(async args=>({stdout:args[0]==='rev-parse'
        ? [++reads===1?RECEIPT_HEAD:REBASED_HEAD,c.artifact.treeSha,c.artifact.baseSha,RECEIPT_HEAD].join('\n')+'\n':'',stderr:'',exitCode:0}));
    }
    await expect(f.invoke()).rejects.toThrow('strict_publication_artifact_unverified');
    expect(f.run).not.toHaveBeenCalled();expect(f.review).not.toHaveBeenCalled();expect(f.complete).not.toHaveBeenCalled();expect(f.push).not.toHaveBeenCalled();
  });

  it('requires a new full check and independent approval after an existing bounded reviewer fixup',async()=>{
    const c=strictPublication();let loops=0;
    f.deps.runAdmittedAgentLoop=async()=>{
      if(++loops===2){c.artifact.headSha=REBASED_HEAD;c.artifact.branchSha=REBASED_HEAD;c.artifact.treeSha='e'.repeat(40);f.pr.headSha=REBASED_HEAD;}
      return loopResult('finished');
    };
    f.review.mockResolvedValueOnce(reviewResult('changes_needed')).mockResolvedValueOnce(reviewResult('approve'));
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(loops).toBe(2);expect(f.run).toHaveBeenCalledTimes(2);expect(f.review).toHaveBeenCalledTimes(2);
    expect(c.receipts[0]?.exactArtifact).toEqual({headSha:REBASED_HEAD,baseSha:'c'.repeat(40),treeSha:'e'.repeat(40),worktreeClean:true});
    expect(f.push.mock.calls[0]?.[0].sourceCommit).toBe(REBASED_HEAD);
  });
});

describe('CODE trusted publication receipts', () => {
  it('records the admitted check/review/publication evidence only after the actual PR receipt persists', async () => {
    const c = capturePublication();
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(c.receipts).toHaveLength(1);
    expect(c.receipts[0]).toEqual({ issueId: issue.id, repo: 'fixture/repo', branch: 'FIX-1-offline-handler-fixture',
      prNumber: 1, prUrl: f.pr.url, draft: false, admittedRuntime: true,
      requiredCheck: { command: 'bun run check', passed: true, exitCode: 0, timedOut: false, afterCheck: { headSha: RECEIPT_HEAD, worktreeClean: true } },
      review: { fingerprint: `${issue.id}:1000000`, verdict: 'approve', afterApproval: { headSha: RECEIPT_HEAD, worktreeClean: true } },
      publication: { beforePush: { headSha: RECEIPT_HEAD, worktreeClean: true }, afterPush: { headSha: RECEIPT_HEAD, worktreeClean: true }, remoteHeadSha: RECEIPT_HEAD },
      postRebaseCheck: 'not_run' });
    expect(c.head).toHaveBeenCalledTimes(4);
    expect(f.gitCommand.mock.calls.every(([args]) => args.join(' ') === 'status --porcelain=v1 --untracked-files=normal')).toBe(true);
  });

  it('adds no Git observation calls when the receipt callback is omitted', async () => {
    const head = restoreAfter(spyOn(git, 'getHeadSha')).mockRejectedValue(new Error('must not be called'));
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(head).not.toHaveBeenCalled();
    expect(f.gitCommand).not.toHaveBeenCalled();
  });

  it('does not claim a receipt when the admitted runtime is blocked', async () => {
    const c = capturePublication();
    f.deps.runAdmittedAgentLoop = async () => loopResult('blocked');
    expect((await f.invoke()).status).toBe('blocked');
    expect(c.receipts).toEqual([]);
    expect(c.head).not.toHaveBeenCalled();
  });

  it('does not claim a receipt when independent review never approves', async () => {
    const c = capturePublication();
    f.review.mockResolvedValue({ kind: 'failed', reason: 'offline failure' });
    expect((await f.invoke()).status).toBe('review_failed');
    expect(c.receipts).toEqual([]);
    expect(f.openPr).not.toHaveBeenCalled();
  });

  it('preserves unknown Git evidence instead of inventing an observed SHA', async () => {
    const c = capturePublication();
    c.head.mockRejectedValue(new Error('fixture Git observation failed'));
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(c.receipts[0]?.requiredCheck.afterCheck).toEqual({ headSha: null, worktreeClean: null });
    expect(c.receipts[0]?.review.afterApproval).toEqual({ headSha: null, worktreeClean: null });
    expect(c.receipts[0]?.publication.remoteHeadSha).toBe(RECEIPT_HEAD);
  });

  it('records a dirty reviewer workspace even if HEAD is unchanged', async () => {
    const c = capturePublication();
    f.gitCommand.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: ' M task.ts\n', stderr: '', exitCode: 0 });
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(c.receipts[0]?.requiredCheck.afterCheck.worktreeClean).toBe(true);
    expect(c.receipts[0]?.review.afterApproval).toEqual({ headSha: RECEIPT_HEAD, worktreeClean: false });
  });

  it('retains changed rebase/published SHAs without pretending that the reviewer approved them', async () => {
    const c = capturePublication();
    c.head.mockResolvedValueOnce(RECEIPT_HEAD).mockResolvedValueOnce(RECEIPT_HEAD).mockResolvedValue(REBASED_HEAD);
    f.rebase.mockResolvedValue({ kind: 'clean', preRebaseSha: RECEIPT_HEAD, postRebaseSha: REBASED_HEAD });
    f.pr.headSha = REBASED_HEAD;
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(c.receipts[0]?.review.afterApproval.headSha).toBe(RECEIPT_HEAD);
    expect(c.receipts[0]?.publication.beforePush.headSha).toBe(REBASED_HEAD);
    expect(c.receipts[0]?.publication.remoteHeadSha).toBe(REBASED_HEAD);
    expect(c.receipts[0]?.postRebaseCheck).toBe('passed');
  });

  it('updates the required-check evidence after reviewer-driven fixups', async () => {
    const c = capturePublication();
    c.head.mockResolvedValueOnce(RECEIPT_HEAD).mockResolvedValue(REBASED_HEAD);
    f.review.mockResolvedValueOnce(reviewResult('changes_needed')).mockResolvedValueOnce(reviewResult('approve'));
    f.pr.headSha = REBASED_HEAD;
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(c.receipts[0]?.requiredCheck.afterCheck.headSha).toBe(REBASED_HEAD);
    expect(c.receipts[0]?.review.afterApproval.headSha).toBe(REBASED_HEAD);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('retains actual PR delivery when readiness persistence fails without leaking the exception', async () => {
    capturePublication();
    f.deps.onPublicationReceipt = async () => { throw new Error('sensitive fixture value'); };
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(f.db.query('SELECT COUNT(*) AS n FROM prs').get()).toEqual({ n: 1 });
    const events = f.db.query('SELECT event_type,payload_json FROM events').all();
    expect(events).toContainEqual({ event_type: 'code_publication_receipt_failed', payload_json: null });
    expect(JSON.stringify(events)).not.toContain('sensitive fixture value');
  });

  it('records the late-created PR without doing more Git reads after the publication deadline', async () => {
    const c = capturePublication();
    f.openPr.mockImplementation(async () => { f.expire(); return f.pr; });
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(c.receipts).toHaveLength(1);
    expect(c.head).toHaveBeenCalledTimes(4);
    expect(f.postComment).not.toHaveBeenCalled();
  });

  it('does not emit a publication receipt after a failed push', async () => {
    const c = capturePublication();
    f.push.mockRejectedValue(new Error('fixture push failed'));
    await expect(f.invoke()).rejects.toThrow('fixture push failed');
    expect(c.receipts).toEqual([]);
    expect(f.openPr).not.toHaveBeenCalled();
  });
});

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
  const gitCommand = restoreAfter(spyOn(git, "gitMust")).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
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
    db, deps, run, hasCommits, primary, review, complete, push, openPr, rebase, postComment, pr, gitCommand,
    expire() { now += 1001; },
    invoke: (options: Pick<CodeHandlerArgs, "draftPr"> = {}) => runCodeHandler(deps, { issue, comments: [], repo: "fixture/repo", scope: "S", ...options }),
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

describe("CODE handler PR publication", () => {
  it("preserves ready PRs when draft mode is omitted", async () => {
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(f.openPr.mock.calls[0]?.[0].draft).toBe(false);
  });

  it("publishes a draft when the ticket opts into draft mode", async () => {
    expect((await f.invoke({ draftPr: true })).status).toBe("pr_opened");
    expect(f.openPr.mock.calls[0]?.[0].draft).toBe(true);
  });

  it("preserves an explicit ready PR request", async () => {
    expect((await f.invoke({ draftPr: false })).status).toBe("pr_opened");
    expect(f.openPr.mock.calls[0]?.[0].draft).toBe(false);
  });

  it("stops before pushing when the run-level publication guard fails", async () => {
    f.deps.assertCanPublish = () => { throw new Error("Fixture spending limit exhausted"); };
    await expect(f.invoke({ draftPr: true })).rejects.toThrow("Fixture spending limit exhausted");
    expect(f.push).not.toHaveBeenCalled();
    expect(f.openPr).not.toHaveBeenCalled();
    expect(f.db.query("SELECT * FROM prs").all()).toEqual([]);
  });

  it("rechecks the publication guard before opening the PR", async () => {
    f.deps.assertCanPublish = mock(() => {
      if (f.push.mock.calls.length > 0) throw new Error("Fixture spending limit exhausted");
    });
    await expect(f.invoke({ draftPr: true })).rejects.toThrow("Fixture spending limit exhausted");
    expect(f.deps.assertCanPublish).toHaveBeenCalledTimes(2);
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.openPr).not.toHaveBeenCalled();
    expect(f.db.query("SELECT * FROM prs").all()).toEqual([]);
  });
});

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

describe("CODE handler admitted loop dependency", () => {
  it("routes primary and both fixups through the supplied runner with unchanged contracts", async () => {
    const admitted = mock<typeof agent.runAgentLoop>(async () => loopResult("finished"));
    f.deps.runAdmittedAgentLoop = admitted;
    f.run.mockResolvedValueOnce(checkResult(1)).mockResolvedValue(checkResult());
    f.review.mockResolvedValueOnce(reviewResult("changes_needed")).mockResolvedValue(reviewResult());
    expect((await f.invoke({ draftPr: true })).status).toBe("pr_opened");
    expect(admitted).toHaveBeenCalledTimes(3);
    expect(f.primary).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.openPr.mock.calls[0]?.[0].draft).toBe(true);
    const calls = admitted.mock.calls.map(([args]) => args);
    expect(calls[0]!.phases?.map(phase => ({ name: phase.name, maxIter: phase.maxIter }))).toEqual([
      { name: "investigate", maxIter: 8 }, { name: "implement", maxIter: 20 },
    ]);
    expect(calls[1]!.phases).toBeUndefined(); expect(calls[1]!.maxIterations).toBe(15);
    expect(calls[2]!.phases).toBeUndefined(); expect(calls[2]!.maxIterations).toBe(15);
    for (const call of calls) {
      expect(call.glm).toBe(f.deps.glm); expect(call.executor).toBe(calls[0]!.executor);
      expect(call.deadlineMs).toBe(1_001_000); expect(call.signal).toBe(calls[0]!.signal);
      expect(call.linear).toBe(f.deps.linear); expect(call.github).toBe(f.deps.github);
      expect(call.currentIssue).toEqual({ id: issue.id, identifier: issue.identifier, teamId: issue.teamId });
      expect(call.defaultRepo).toBe("fixture/repo"); expect(call.finishGateCommand).toBe("bun run check");
      // The seam does not quietly strip unsupported integrations or subagent policy.
      expect(call.disableSubagent).toBeUndefined();
    }
    for (const [review] of f.review.mock.calls) {
      expect(review.deadlineMs).toBe(calls[0]!.deadlineMs); expect(review.signal).toBe(calls[0]!.signal);
    }
  });

  it("leaves the legacy incomplete-with-commits path unchanged when no runner is injected", async () => {
    f.primary.mockResolvedValueOnce(loopResult("no_finish"));
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(f.primary).toHaveBeenCalledTimes(1); expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(1); expect(f.push).toHaveBeenCalledTimes(1);
  });

  it("never falls back to the default runner when the admitted runner throws", async () => {
    const failure = new Error("Offline admission refused");
    const admitted = mock<typeof agent.runAgentLoop>(async () => { throw failure; });
    f.deps.runAdmittedAgentLoop = admitted;
    await expect(f.invoke()).rejects.toBe(failure);
    expect(admitted).toHaveBeenCalledTimes(1); expect(f.primary).not.toHaveBeenCalled();
    expect(f.hasCommits).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
    expect(f.db.query("SELECT * FROM prs").all()).toEqual([]);
  });

  for (const status of ["error", "no_finish", "iteration_cap"] as const) {
    it(`does not salvage existing commits after an admitted primary ${status}`, async () => {
      const admitted = mock<typeof agent.runAgentLoop>(async () => loopResult(status));
      f.deps.runAdmittedAgentLoop = admitted;
      await expect(f.invoke()).rejects.toThrow(`Admitted code loop did not finish (${status})`);
      expect(f.primary).not.toHaveBeenCalled(); expect(f.hasCommits).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
      expect(f.db.query("SELECT * FROM prs").all()).toEqual([]);
    });

    it(`does not recheck or publish after an admitted check-fixup ${status}`, async () => {
      const admitted = mock<typeof agent.runAgentLoop>()
        .mockResolvedValueOnce(loopResult("finished")).mockResolvedValueOnce(loopResult(status));
      f.deps.runAdmittedAgentLoop = admitted; f.run.mockResolvedValueOnce(checkResult(1));
      await expect(f.invoke()).rejects.toThrow(`Admitted code loop did not finish (${status})`);
      expect(admitted).toHaveBeenCalledTimes(2); expect(f.primary).not.toHaveBeenCalled();
      expect(f.run).toHaveBeenCalledTimes(1); expect(f.review).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
      expect(f.db.query("SELECT * FROM prs").all()).toEqual([]);
    });

    it(`does not recheck or publish after an admitted reviewer-fixup ${status}`, async () => {
      const admitted = mock<typeof agent.runAgentLoop>()
        .mockResolvedValueOnce(loopResult("finished")).mockResolvedValueOnce(loopResult(status));
      f.deps.runAdmittedAgentLoop = admitted;
      f.review.mockResolvedValueOnce(reviewResult("changes_needed"));
      await expect(f.invoke()).rejects.toThrow(`Admitted code loop did not finish (${status})`);
      expect(admitted).toHaveBeenCalledTimes(2); expect(f.primary).not.toHaveBeenCalled();
      expect(f.run).toHaveBeenCalledTimes(1); expect(f.review).toHaveBeenCalledTimes(1);
      expect(f.complete).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
      expect(f.db.query("SELECT * FROM prs").all()).toEqual([]);
    });
  }

  it("retains blocked escalation and never publishes an injected blocked result", async () => {
    f.deps.runAdmittedAgentLoop = mock<typeof agent.runAgentLoop>(async () => loopResult("blocked", "Offline runtime unavailable"));
    expect((await f.invoke()).status).toBe("blocked"); expect(f.primary).not.toHaveBeenCalled();
    expect(f.hasCommits).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled(); expectNoDelivery();
  });

  it("keeps the original deadline when an injected result arrives late", async () => {
    f.deps.runAdmittedAgentLoop = mock<typeof agent.runAgentLoop>(async () => { f.expire(); return loopResult("finished"); });
    expect((await f.invoke()).status).toBe("timeout"); expect(f.primary).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled(); expectNoDelivery();
  });

  it("still fails closed when independent review is unavailable after injected success", async () => {
    const admitted = mock<typeof agent.runAgentLoop>(async () => loopResult("finished"));
    f.deps.runAdmittedAgentLoop = admitted;
    scriptReviews([{ kind: "failed", reason: "offline first failure" }, { kind: "failed", reason: "offline second failure" }]);
    expect((await f.invoke()).status).toBe("review_failed"); expect(admitted).toHaveBeenCalledTimes(1);
    expect(f.primary).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledTimes(1); expect(f.review).toHaveBeenCalledTimes(2);
    expectNoDelivery();
  });

  it("preserves the existing publication guard and real ledger after injected success", async () => {
    const spend = new SpendLedger(":memory:");
    try {
      spend.createCampaign("offline-admitted-loop", 5); spend.enrollTicket("offline-admitted-loop", issue.id, 5);
      f.deps.assertCanPublish = () => {
        if (spend.status(issue.id)?.state !== "active") throw new Error("spend allocation closed before publication");
      };
      f.deps.runAdmittedAgentLoop = mock<typeof agent.runAgentLoop>(async () => {
        spend.markTerminal(issue.id, "offline_operator_stopped"); return loopResult("finished");
      });
      await expect(f.invoke({ draftPr: true })).rejects.toThrow("spend allocation closed before publication");
      expect(f.primary).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledTimes(1); expect(f.review).toHaveBeenCalledTimes(1);
      expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
      expect(spend.status(issue.id)?.state).toBe("closed"); expect(spend.status(issue.id)?.attemptCount).toBe(0);
    } finally { spend.close(); }
  });
});
