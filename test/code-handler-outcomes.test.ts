import { RuntimeDiagnosticError } from "../src/hermes/runtime-diagnostics.ts";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/executors/process.ts";
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
import { createActionVerification, CODING_VERIFICATION_POLICY } from "../src/verification-policy.ts";

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
  const factory = restoreAfter(spyOn(executorFactory, "createWorkspaceExecutor")).mockReturnValue(executor);
  restoreAfter(spyOn(skills, "loadProjectContext")).mockReturnValue({ claudeMd: null, agentsMd: null, hasBeads: false });
  restoreAfter(spyOn(skills, "loadSkillIndex")).mockReturnValue([]);
  const clone = restoreAfter(spyOn(git, "ensureBareClone")).mockResolvedValue("/offline/repos/fixture.git");
  const worktree = restoreAfter(spyOn(git, "createWorktree")).mockResolvedValue(undefined);
  const hasCommits = restoreAfter(spyOn(git, "hasCommitsAhead")).mockResolvedValue(true);
  const diff = restoreAfter(spyOn(git, "getDiff")).mockResolvedValue("diff --git a/README.md b/README.md\n+fixture change\n");
  const commitLog = restoreAfter(spyOn(git, "getCommitLog")).mockResolvedValue("abc123 fixture change");
  const gitCommand = restoreAfter(spyOn(git, "gitMust")).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  const rebase = restoreAfter(spyOn(git, "rebaseOntoFreshBase")).mockResolvedValue({ kind: "no_op", sha: "abc123" });
  const push = restoreAfter(spyOn(git, "pushBranch")).mockResolvedValue(undefined);
  const remoteBase = restoreAfter(spyOn(git, "assertRemoteBase")).mockResolvedValue(undefined);
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
    db, deps, run, hasCommits, primary, review, complete, push, openPr, rebase, postComment, pr, gitCommand, factory,
    clone, worktree, diff, commitLog, remoteBase,
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


describe('trusted parent executor profile at the CODE handler boundary',()=>{
  it('primary, host check and both reviewer attempts reuse the same configured executor',async()=>{
    const profile={image:'sha256:'+'a'.repeat(64),bunCacheVolume:'fixture-cache',cpus:'4',memory:'12g',pidsLimit:512,fixedEnvironment:Object.freeze({VITEST_MAX_WORKERS:'2'})};
    f.deps.workspaceExecutorProfile=profile;
    let primaryExecutor:Executor|undefined;
    f.primary.mockImplementation(async args=>{primaryExecutor=args.executor;await args.executor.run('fixture primary check');return loopResult('finished');});
    f.review.mockResolvedValueOnce({kind:'failed',reason:'offline retry'}).mockResolvedValueOnce(reviewResult());
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.factory.mock.calls[0]).toEqual(['/offline/workspaces/FIX-1',{profile}]);
    expect(f.review).toHaveBeenCalledTimes(2);
    for(const [args] of f.review.mock.calls)expect(args.executor).toBe(primaryExecutor!);
    expect(f.run.mock.calls.map(([command])=>command)).toEqual(['fixture primary check','bun run check']);
  });
  it('legacy omission passes no profile',async()=>{
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(f.factory.mock.calls[0]).toEqual(['/offline/workspaces/FIX-1',{}]);
  });
});


describe("CODE shared verification policy", () => {
  function configure() {
    const verification = createActionVerification({ policy: CODING_VERIFICATION_POLICY, assertActive: () => {} });
    f.deps.verification = verification;
    f.deps.agentLoopTimeoutMs = 9_000_000;
    return verification;
  }
  function primaryGate(verification: ReturnType<typeof configure>, before?: (args: agent.AgentLoopArgs) => void) {
    const calls: agent.AgentLoopArgs[] = [];
    f.deps.runAdmittedAgentLoop = async args => {
      calls.push(args); before?.(args);
      expect(args.finishGateCommand).toBe("bun run ci:full");
      expect(args.systemPrompt).toContain("host-required full verification gate");
      await verification.run(args.finishGateCommand!, {}, opts => args.executor.run(args.finishGateCommand!, opts));
      return loopResult("finished");
    };
    return calls;
  }

  it("shares the primary and host gate budget and forwards the exact checked artifact to review", async () => {
    const c = strictPublication();
    const verification = configure();
    const calls = primaryGate(verification);
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(calls[0]?.phases?.[1]?.entryMessage).toContain("bun run ci:full");
    expect(verification.snapshot()).toEqual({ deadlineMs: 10_000_000,
      counts: { "bun run ci:full": 2, "bun run check": 0 } });
    expect(f.run.mock.calls.map(([command]) => command)).toEqual(["bun run ci:full", "bun run ci:full"]);
    for (const [, opts] of f.run.mock.calls) {
      expect(opts?.timeoutMs).toBe(1_800_000);
      expect(opts?.deadlineMs).toBe(2_800_000);
    }
    expect(c.receipts[0]?.requiredCheck.command).toBe("bun run ci:full");
    expect(f.review.mock.calls[0]?.[0].hostCheck).toEqual({ command: "bun run ci:full", exitCode: 0, timedOut: false,
      exactArtifact: { headSha: RECEIPT_HEAD, baseSha: "c".repeat(40), treeSha: "d".repeat(40), worktreeClean: true } });
    expect(f.review.mock.calls[0]?.[0].deadlineMs).toBe(calls[0]?.deadlineMs);
  });

  it("uses the same four-start budget through a host-check repair without extending the action", async () => {
    strictPublication();
    const verification = configure();
    const calls = primaryGate(verification, () => f.expire());
    let runs = 0;
    f.run.mockImplementation(async () => checkResult(++runs === 2 ? 1 : 0));
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.task).toContain("Most recent `bun run ci:full` output");
    expect(calls[1]?.task).toContain("host requires this gate to pass");
    expect(calls.map(call => call.deadlineMs)).toEqual([10_000_000, 10_000_000]);
    expect(verification.snapshot().counts["bun run ci:full"]).toBe(4);
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.run.mock.calls.every(([command]) => command === "bun run ci:full")).toBe(true);
    expect(f.review.mock.calls[0]?.[0].hostCheck?.command).toBe("bun run ci:full");
  });

  it("refuses a fifth gate during repair before executing or publishing", async () => {
    strictPublication();
    const verification = configure();
    let primaryCalls = 0;
    f.deps.runAdmittedAgentLoop = async args => {
      const repetitions = ++primaryCalls === 1 ? 3 : 1;
      for (let i = 0; i < repetitions; i++) {
        await verification.run(args.finishGateCommand!, {}, opts => args.executor.run(args.finishGateCommand!, opts));
      }
      return loopResult("finished");
    };
    let runs = 0;
    f.run.mockImplementation(async () => checkResult(++runs === 4 ? 1 : 0));
    await expect(f.invoke()).rejects.toThrow("verification_rejected:test_start_limit");
    expect(primaryCalls).toBe(2);
    expect(verification.snapshot().counts["bun run ci:full"]).toBe(4);
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled();
    expect(f.openPr).not.toHaveBeenCalled();
  });

  it("refreshes the gate and exact-artifact receipt through the bounded reviewer-repair path", async () => {
    const c = strictPublication();
    const verification = configure();
    let loops = 0;
    const calls = primaryGate(verification, () => {
      if (++loops === 2) {
        c.artifact.headSha = REBASED_HEAD; c.artifact.branchSha = REBASED_HEAD;
        c.artifact.treeSha = "e".repeat(40); f.pr.headSha = REBASED_HEAD;
      }
    });
    f.review.mockResolvedValueOnce(reviewResult("changes_needed")).mockResolvedValueOnce(reviewResult("approve"));
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.task).toContain("Run `bun run ci:full` before finish");
    expect(verification.snapshot().counts["bun run ci:full"]).toBe(4);
    expect(f.review.mock.calls.map(([args]) => args.hostCheck?.exactArtifact.headSha)).toEqual([RECEIPT_HEAD, REBASED_HEAD]);
    expect(f.review.mock.calls[1]?.[0].hostCheck?.exactArtifact.treeSha).toBe("e".repeat(40));
    expect(c.receipts[0]?.requiredCheck.command).toBe("bun run ci:full");
    expect(c.receipts[0]?.exactArtifact?.headSha).toBe(REBASED_HEAD);
  });

  it("preserves host evidence on a failed-review retry and counts any reviewer gate in the same budget", async () => {
    strictPublication();
    const verification = configure();
    primaryGate(verification);
    let reviews = 0;
    f.review.mockImplementation(async args => {
      await args.executor.run("bun run ci:full", { timeoutMs: 180_000,
        ...(args.deadlineMs === undefined ? {} : { deadlineMs: args.deadlineMs }),
        ...(args.signal === undefined ? {} : { signal: args.signal }) });
      return ++reviews === 1 ? { kind: "failed", reason: "fixture retry" } : reviewResult();
    });
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(verification.snapshot().counts["bun run ci:full"]).toBe(4);
    expect(f.review.mock.calls[0]?.[0].hostCheck).toEqual(f.review.mock.calls[1]?.[0].hostCheck);
    expect(f.run.mock.calls.slice(2).every(([, opts]) => opts?.timeoutMs === 180_000)).toBe(true);
  });

  it("routes a legacy-compatible post-rebase recheck through the selected shared gate", async () => {
    const verification = configure();
    primaryGate(verification);
    f.rebase.mockResolvedValue({ kind: "clean", preRebaseSha: RECEIPT_HEAD, postRebaseSha: REBASED_HEAD });
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(verification.snapshot().counts["bun run ci:full"]).toBe(3);
    expect(f.run.mock.calls.map(([command]) => command)).toEqual(Array(3).fill("bun run ci:full"));
    expect(f.review.mock.calls[0]?.[0].hostCheck).toBeUndefined();
  });

  it("keeps the legacy gate, timeout and reviewer prompt input when policy is omitted", async () => {
    expect((await f.invoke()).status).toBe("pr_opened");
    expect(f.primary.mock.calls[0]?.[0].finishGateCommand).toBe("bun run check");
    expect(f.primary.mock.calls[0]?.[0].systemPrompt).toContain("project's typecheck/svelte-check command");
    expect(f.run.mock.calls[0]?.[0]).toBe("bun run check");
    expect(f.run.mock.calls[0]?.[1]?.timeoutMs).toBe(600_000);
    expect(f.review.mock.calls[0]?.[0].hostCheck).toBeUndefined();
  });
});


describe('CODE host-selected stacked base', () => {
  const base = { branch: 'codex/baseline-test-repairs', commit: 'c'.repeat(40) };

  it('uses one pinned base for checkout, review, commit range, fresh-base check and draft PR', async () => {
    const c = strictPublication();
    f.deps.codeBase = base;
    Object.assign(f.pr, { baseRef: base.branch, baseSha: base.commit, isDraft: true });
    expect((await f.invoke({ draftPr: true })).status).toBe('pr_opened');
    expect(f.clone.mock.calls[0]?.[0].base).toEqual(base);
    expect(f.worktree.mock.calls[0]?.[0]).toMatchObject({ baseBranch: base.branch, expectedBaseCommit: base.commit });
    expect(f.hasCommits.mock.calls[0]?.[1]).toBe(base.commit);
    expect(f.diff.mock.calls.map(call => call[1])).toEqual([base.commit, base.commit]);
    expect(f.commitLog.mock.calls[0]?.[1]).toBe(base.commit);
    expect(f.rebase.mock.calls[0]?.[0]).toMatchObject({ baseBranch: base.branch, expectedBaseCommit: base.commit });
    expect(f.remoteBase.mock.calls.map(call => call[0].base)).toEqual([base, base]);
    expect(f.openPr.mock.calls[0]?.[0]).toMatchObject({ base: base.branch, draft: true });
    expect(f.openPr.mock.calls[0]?.[0].body).toContain('Stacked base: `' + base.branch + '` (`' + base.commit + '`)');
    expect(c.receipts[0]?.publicationBase).toEqual(base);
    expect(c.receipts[0]?.publication.remoteBase).toEqual(base);
    expect(c.receipts[0]?.exactArtifact?.baseSha).toBe(base.commit);
    expect(f.push.mock.calls[0]?.[0].sourceCommit).toBe(RECEIPT_HEAD);
  });

  it('keeps all legacy base choices on main when the host does not select a base', async () => {
    expect((await f.invoke()).status).toBe('pr_opened');
    expect(f.clone.mock.calls[0]?.[0].base).toBeUndefined();
    expect(f.worktree.mock.calls[0]?.[0].baseBranch).toBe('main');
    expect(f.diff.mock.calls.map(call => call[1])).toEqual(['main', 'main']);
    expect(f.rebase.mock.calls[0]?.[0].baseBranch).toBe('main');
    expect(f.remoteBase).not.toHaveBeenCalled();
    expect(f.openPr.mock.calls[0]?.[0].base).toBe('main');
    expect(f.openPr.mock.calls[0]?.[0].body).toBe('Fixture PR text');
  });

  it('does not fall back to main when the selected remote ref is unavailable', async () => {
    strictPublication(); f.deps.codeBase = base;
    f.clone.mockRejectedValue(new Error('selected ref missing'));
    await expect(f.invoke()).rejects.toThrow('selected ref missing');
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.worktree).not.toHaveBeenCalled(); expect(f.primary).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
  });

  for (const boundary of ['push', 'pr'] as const) it('rejects remote base drift at the ' + boundary + ' boundary', async () => {
    const c = strictPublication(); f.deps.codeBase = base;
    if (boundary === 'pr') f.remoteBase.mockResolvedValueOnce(undefined);
    f.remoteBase.mockRejectedValueOnce(new Error('pinned_remote_base_changed'));
    await expect(f.invoke()).rejects.toThrow('pinned_remote_base_changed');
    expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.push).toHaveBeenCalledTimes(boundary === 'push' ? 0 : 1);
    expect(f.openPr).not.toHaveBeenCalled(); expect(c.receipts).toEqual([]);
  });

  it('rejects even a stable local artifact if its selected base differs from the activation pin', async () => {
    strictPublication(); f.deps.codeBase = { ...base, commit: 'e'.repeat(40) };
    await expect(f.invoke()).rejects.toThrow('strict_publication_artifact_unverified');
    expect(f.run).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
  });

  for (const kind of ['unsafe-ref', 'unpinned', 'without-strict', 'same-work-branch'] as const) it('rejects ' + kind + ' before any repository or model work', async () => {
    strictPublication();
    f.deps.codeBase = kind === 'unsafe-ref' ? { ...base, branch: 'main:other' }
      : kind === 'unpinned' ? { ...base, commit: 'main' }
      : kind === 'same-work-branch' ? { ...base, branch: 'FIX-1-offline-handler-fixture' } : base;
    if (kind === 'without-strict') delete f.deps.strictPublicationArtifact;
    await expect(f.invoke()).rejects.toThrow();
    expect(f.clone).not.toHaveBeenCalled(); expect(f.primary).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
  });
});


describe('CODE observes the actual created PR base', () => {
  const base = { branch: 'codex/baseline-test-repairs', commit: 'c'.repeat(40) };
  for (const kind of ['missing-base', 'wrong-branch', 'moved-base', 'wrong-head', 'not-draft'] as const) {
    it('preserves real PR identity without successful publication when GitHub returns ' + kind, async () => {
      const c = strictPublication(); f.deps.codeBase = base;
      Object.assign(f.pr, { baseRef: base.branch, baseSha: base.commit, isDraft: true });
      // The final remote preflight succeeds. Drift is reported only by the subsequent creation response.
      if (kind === 'missing-base') { delete f.pr.baseRef; delete f.pr.baseSha; }
      if (kind === 'wrong-branch') f.pr.baseRef = 'main';
      if (kind === 'moved-base') f.pr.baseSha = 'e'.repeat(40);
      if (kind === 'wrong-head') f.pr.headSha = 'f'.repeat(40);
      if (kind === 'not-draft') f.pr.isDraft = false;
      const result = await f.invoke({ draftPr: true });
      expect(result).toMatchObject({ status: 'blocked', prUrl: f.pr.url, prNumber: f.pr.number });
      expect(result.summary).toContain('Publication is unverified');
      expect(f.remoteBase).toHaveBeenCalledTimes(2); expect(f.openPr).toHaveBeenCalledTimes(1);
      expect(f.db.query('SELECT pr_number, branch FROM prs').get()).toEqual({ pr_number: f.pr.number, branch: result.branch });
      expect(c.receipts).toEqual([]); expect(f.postComment).not.toHaveBeenCalled();
      expect(f.db.query("SELECT count(*) AS n FROM events WHERE event_type='code_publication_unverified'").get()).toEqual({ n: 1 });
    });
  }
});


describe('CODE inherits host shutdown without abandoning cleanup', () => {
  it('an already-aborted host starts no Git/model work and sends no timeout escalation', async () => {
    const host = new AbortController(), reason = new Error('host stopped'); host.abort(reason); f.deps.signal = host.signal;
    await expect(f.invoke()).rejects.toBe(reason);
    expect(f.clone).not.toHaveBeenCalled(); expect(f.primary).not.toHaveBeenCalled();
    expect(f.postComment).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
  });

  for (const stage of ['primary', 'check', 'check-repair', 'review', 'review-repair', 'pr-body', 'pr-title'] as const) {
    it('cancels ' + stage + ', awaits its cleanup, and starts no subsequent work or publication', async () => {
      const host = new AbortController(), reason = new Error('host stopped'); f.deps.signal = host.signal;
      f.deps.agentLoopTimeoutMs = 9_000_000;
      f.deps.runAdmittedAgentLoop = args => f.primary(args);
      let entered!: () => void, sawAbort!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const aborted = new Promise<void>(resolve => { sawAbort = resolve; });
      const cleanup = new Promise<void>(resolve => { release = resolve; });
      let cleaned = false, settled = false;
      const pendingStage = async (signal: AbortSignal | undefined): Promise<never> => {
        expect(signal).toBeInstanceOf(AbortSignal); entered();
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => { sawAbort(); resolve(); }, { once: true }));
        await cleanup; cleaned = true; throw signal!.reason;
      };
      if (stage === 'primary') f.primary.mockImplementation(args => pendingStage(args.signal));
      if (stage === 'check') f.run.mockImplementation((_cmd, opts) => pendingStage(opts?.signal));
      if (stage === 'check-repair') {
        f.run.mockResolvedValueOnce(checkResult(1));
        f.primary.mockResolvedValueOnce(loopResult('finished')).mockImplementationOnce(args => pendingStage(args.signal));
      }
      if (stage === 'review') f.review.mockImplementation(args => pendingStage(args.signal));
      if (stage === 'review-repair') {
        f.review.mockResolvedValueOnce(reviewResult('changes_needed'));
        f.primary.mockResolvedValueOnce(loopResult('finished')).mockImplementationOnce(args => pendingStage(args.signal));
      }
      if (stage === 'pr-body') f.complete.mockImplementation(args => pendingStage(args.signal));
      if (stage === 'pr-title') f.complete.mockResolvedValueOnce('body').mockImplementationOnce(args => pendingStage(args.signal));
      const result = f.invoke().then(() => { settled = true; throw new Error('unexpected success'); }, error => { settled = true; return error; });
      await started; host.abort(reason); await aborted; await Bun.sleep(5);
      expect(settled).toBe(false); expect(cleaned).toBe(false);
      const calls = [f.primary.mock.calls.length, f.run.mock.calls.length, f.review.mock.calls.length, f.complete.mock.calls.length];
      release(); expect(await result).toBe(reason); expect(cleaned).toBe(true);
      expect([f.primary.mock.calls.length, f.run.mock.calls.length, f.review.mock.calls.length, f.complete.mock.calls.length]).toEqual(calls);
      expect(f.postComment).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled(); expect(f.openPr).not.toHaveBeenCalled();
    });
  }

  it('kills a real full-check process and its descendant before the host-aborted action returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gary-host-full-check-')), pidsPath = join(root, 'pids');
    const host = new AbortController(), reason = new Error('host stopped full check');
    f.deps.signal = host.signal; f.deps.agentLoopTimeoutMs = 9_000_000;
    f.deps.verification = createActionVerification({ policy: CODING_VERIFICATION_POLICY, assertActive() {} });
    f.run.mockImplementation(async (command, options) => {
      expect(command).toBe('bun run ci:full');
      return runProcess('/bin/bash', ['-c', 'sleep 300 & child=$!; printf "%s %s" "$$" "$child" > "$GARY_FIXTURE_PIDS"; wait'], {
        ...options, timeoutMs: options!.timeoutMs!, cwd: root, env: { PATH: '/usr/bin:/bin', GARY_FIXTURE_PIDS: pidsPath },
      });
    });
    let pids: number[] = [];
    const result = f.invoke().then(() => new Error('unexpected success'), error => error);
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(pidsPath); attempt++) await Bun.sleep(10);
      expect(existsSync(pidsPath)).toBe(true);
      pids = readFileSync(pidsPath, 'utf8').split(' ').map(Number); expect(pids).toHaveLength(2);
      host.abort(reason); expect(await result).toBe(reason);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(f.review).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled(); expect(f.postComment).not.toHaveBeenCalled();
    } finally {
      host.abort(reason); await result;
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains a PR creation already in flight at host abort and suppresses all follow-up writes', async () => {
    const host = new AbortController(); f.deps.signal = host.signal;
    f.openPr.mockImplementation(async () => { host.abort(new Error('host stopped during creation')); return f.pr; });
    const result = await f.invoke();
    expect(result).toMatchObject({ status: 'pr_opened', prUrl: f.pr.url });
    expect(f.db.query('SELECT pr_number FROM prs').get()).toEqual({ pr_number: f.pr.number });
    expect(f.postComment).not.toHaveBeenCalled();
  });
});

it('preserves validated admitted runtime diagnostics through the CODE exception without later work',async()=>{
  const diagnostic={origin:'worker',code:'invalid_model_history_response',stage:'model_response',category:'none'} as const;
  f.deps.runAdmittedAgentLoop=async()=>({...loopResult('error'),diagnostic,errorMessage:'SECRET'});
  const error=await f.invoke().then(()=>null,error=>error);
  expect(error).toBeInstanceOf(RuntimeDiagnosticError);expect(error.diagnostic).toEqual(diagnostic);
  expect(error.message).not.toContain('SECRET');expect(f.run).not.toHaveBeenCalled();expect(f.push).not.toHaveBeenCalled();expect(f.postComment).not.toHaveBeenCalled();
});

it('native timeout diagnostic retains the existing timeout escalation without publication',async()=>{
 const diagnostic={origin:'worker',code:'deadline_exceeded',stage:'stdio_read',category:'none'} as const;
 f.deps.runAdmittedAgentLoop=async()=>({...loopResult('timeout'),diagnostic});
 const result=await f.invoke();
 expect(result.status).toBe('timeout');expect(result.diagnostic).toEqual(diagnostic);
 expect(f.postComment).toHaveBeenCalledTimes(1);expect(f.run).not.toHaveBeenCalled();expect(f.push).not.toHaveBeenCalled();
});
