import { resolve } from "node:path";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type { GitHubClient } from "../adapters/github.ts";
import { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, IssueComment, LinearAdapter } from "../adapters/linear.ts";
import { type AgentLoopArgs, type AgentLoopResult, type PhaseSpec, runAgentLoop, type RunLogEntry } from "../agent/loop.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import {
  createWorktree,
  ensureBareClone,
  getCommitLog,
  getDiff,
  getHeadSha,
  gitMust,
  hasCommitsAhead,
  pushBranch,
  rebaseOntoFreshBase,
  slugify,
} from "../git.ts";
import { createWorkspaceExecutor } from "../executors/factory.ts";
import { bindExecutorDeadline, type Executor, type ExecResult } from "../executors/index.ts";
import { createDeadline, DeadlineExceededError, throwIfExpired, type DeadlineOptions } from "../deadline.ts";
import { log } from "../logger.ts";
import {
  formatProjectContext,
  loadProjectContext,
  loadSkillIndex,
} from "../skills.ts";
import type { DB } from "../state/db.ts";
import { recordEvent, recordPr, setTerminalState } from "../state/queries.ts";
import { markReviewPassEscalated } from "../state/review-queries.ts";
import type { ReviewConfig } from "../config.ts";
import { chainWithOrder } from "../providers.ts";
import { runReviewer, type ReviewerResult } from "../review/runner.ts";
import { findUntestedExports, findUnwiredIdentifiers } from "../review/precheck.ts";
import { synthesizeReviewRejectedBody } from "../escalate.ts";

const BASE_BRANCH = "main";
const CHECK_COMMAND = "bun run check";
const CHECK_TIMEOUT_MS = 10 * 60_000;
const FIXUP_MAX_ITERATIONS = 15;
const FIXUP_OUTPUT_BUDGET = 8000;

// Read-only tools advertised in the investigate phase. Anything that
// mutates the workspace (write_file, edit_file, run_bash, commit) or ends
// the loop (finish) is hidden until the model transitions to implement.
// `todo_write` and `dispatch_subagent` are both safe and useful here:
// laying out a plan as todos and offloading wide investigations to a
// sub-agent are exactly what this phase is for.
const INVESTIGATE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "list_files",
  "fetch_url",
  "get_linear_issue",
  "get_pr",
  "query_cloudflare_logs",
  "list_cloudflare_invocations",
  "d1_query",
  "todo_write",
  "dispatch_subagent",
  "report_blocked",
]);

/**
 * Two-phase loop for the CODE handler. Investigate forces the model to
 * read the code and form a plan before being able to write; the model
 * voluntarily ends the phase by producing a turn with no tool calls
 * (signalling "done exploring") OR is forced over by hitting the
 * investigate cap. The implement phase opens with a forcing message
 * directing the model to write a brief plan, implement, and call finish.
 *
 * Iteration budgets are scaled by classification scope: small tickets get
 * a tight cap (rename a button, fix a typo) while medium tickets get the
 * historical 15/35 budget. L tickets are already auto-bounced upstream.
 */
function phaseBudget(scope: "S" | "M" | "L"): { investigate: number; implement: number } {
  if (scope === "S") return { investigate: 8, implement: 20 };
  // M is the historical flat cap (50 total). L never reaches here.
  return { investigate: 15, implement: 35 };
}

function buildCodePhases(scope: "S" | "M" | "L" = "M"): readonly PhaseSpec[] {
  const { investigate, implement } = phaseBudget(scope);
  return [
    {
      name: "investigate",
      maxIter: investigate,
      allowedTools: INVESTIGATE_ALLOWED_TOOLS,
      nudgeMessage:
        "you've used most of your investigate budget. wrap up exploration on your next turn — finish reading what's needed and end your turn without tool calls so you can move to the implement phase.",
    },
    {
      name: "implement",
      maxIter: implement,
      entryMessage:
        "good — you've explored. now: (1) write a 3-5 bullet plan, (2) implement the change and commit, (3) run `bun run check` and fix anything you broke, (4) call finish() after verification passes. If you're stuck or cannot verify, call report_blocked with the concrete error, partial work, and needed human action. After two attempts reproduce the same failure without new evidence, stop and report the blocker.",
      nudgeMessage:
        "you're approaching the iteration cap. If verified, commit and call finish(). Otherwise call report_blocked with partial progress and the specific unresolved error; do not claim verification passed.",
    },
  ];
}

const CHECK_FIXUP_TASK_INSTRUCTIONS = `Your previous turn ended with finish() but \`${CHECK_COMMAND}\` is failing. Fix the errors caused by your changes, commit, then call finish() again.

Rules:
- Run \`${CHECK_COMMAND}\` and confirm it exits 0 BEFORE calling finish.
- Only fix what's broken — don't refactor unrelated code.
- If the failure is in code you didn't touch, investigate before assuming it's pre-existing. The pre-push hook runs the same command, so anything failing here will block your push.
- Commit your fix-up changes before calling finish.
- First distinguish a changed-code failure from an existing repository failure or unavailable tooling/dependencies. Cite the first actionable error; do not change unrelated code to bypass an environment problem.
- After two attempts reproduce the same failure without new evidence, call report_blocked with the error and partial progress. A blocked exit does not require a passing check.`;

const CODE_TASK_INSTRUCTIONS = `You are working on a Linear ticket for 707 Labs. Make the smallest change that solves the ticket and stop.

You can use tools to read, edit, run bash commands, and commit. When you're done, call finish() with a one-sentence summary.

Rules:
- Read before you write. Look at the existing code, the project's conventions (CLAUDE.md, AGENTS.md, .claude/skills/), and any related files before changing anything.
- Make the smallest change that solves the ticket. Don't refactor unrelated code.
- BEFORE calling finish, run \`bun run check\` (the project's typecheck/svelte-check command). If there are errors caused by your changes, fix them and re-run. The repo has a pre-push hook that runs the same command — your push will be rejected if it fails.
- Run other tests if there's an obvious command for the area you touched (look at package.json scripts and tests in the changed file's directory). If tests fail, try to fix them.
- If the ticket is ambiguous, make a reasonable choice and note it in finish()'s summary.
- If you cannot complete or verify the task, call report_blocked with the concrete blocker, partial work, and what a human must resolve. Do not use finish() for partial progress.
- Don't install new dependencies unless the ticket clearly requires it.
- Commit your changes before calling finish.`;

export const PR_BODY_TASK_INSTRUCTIONS = `Write a PR body for the changes you just made. Use voice.md examples 5 (small, confident) and 6 (medium, with uncertainty) as your structural template — match that exact format. Pick the level of detail based on the size and certainty of this change.

Output ONLY the PR body markdown. Do not output the title — the title is generated separately. Do not output any preamble like "Here is the PR body".

The Summary describes what the diff actually does, not what you originally planned. The diff is the source of truth. If your finish summary, the ticket title, or your initial framing doesn't match what the diff actually changed, trust the diff and describe what landed. Open the file list if you have to — every section in the body should be defensible by pointing at a hunk.

Required sections, in order:
1. \`## Summary\` — 1-3 short paragraphs and/or bullets explaining what changed and why. Lead with the most important change.
2. \`## Things i'm less sure about\` — only if there's genuine uncertainty. Skip the section entirely if the change is small and confident.
3. \`## Verification\` — paste the reviewer's verification report verbatim. Do not edit, summarize, or paraphrase.
4. \`## Test plan\` — markdown checklist. Each line is \`- [x] <command>\` for things you ran, \`- [ ] <thing>\` for things still to verify (always include \`- [ ] CI green\`). At minimum include the typecheck command you ran (\`bun run check\` or equivalent).
5. \`## Follow-ups\` — only if there are genuine related tasks not in scope here.
6. A blank line, then \`closes [<TICKET-ID>]\` (uppercase).
7. A blank line, then a parenthetical "(i'm gary — ai agent. <specific things to double-check>.)" line.
8. A blank line, then the signature: \`🤖 Generated by [gary-707-labs](https://github.com/apps/gary-707-labs)\`

Voice rules: lowercase-friendly, contractions, terse. Don't fake confidence — if you're uncertain, say so in the "less sure about" section. If the test plan only has one or two items, that's fine — don't pad.`;

export const PR_TITLE_TASK_INSTRUCTIONS = `Write a PR title in conventional commit format with a Linear ticket suffix.

Format: \`<type>(<scope>): <description> (<TICKET-ID>)\`

- type: one of feat, fix, refactor, chore, docs, test, perf
- scope: optional but encouraged — derive from the area of code changed (e.g., screenshot, scryfall, hotkey, decks)
- description: lowercase, no leading capital, no trailing period, present tense ("add x" not "added x" or "adds x")
- ticket: include the ticket ID in parentheses at the end, uppercase, no \`closes\` keyword

Output ONLY the title on a single line. No quotes, no preamble.

Examples:
\`feat(hotkey): extend F to toggle face-down on morph cards (ERT-1615)\`
\`fix(scryfall): split rate limiter into interactive and batch queues (ERT-1610)\`
\`refactor(delta): audit PlayerStateDelta against PlayerGameState (ERT-1613)\``;

export type AdmittedCodeLoopRunner = typeof runAgentLoop;

/** Point-in-time host observations, not a lock or an immutable workspace proof. */
export interface CodeGitObservation {
  headSha: string | null;
  worktreeClean: boolean | null;
}

/** Exact committed artifact observed throughout the opt-in publication guard. */
export interface CodePublicationArtifact {
  headSha: string;
  baseSha: string;
  treeSha: string;
  worktreeClean: true;
}

/** Emitted only after existing check/review/push/PR branches complete successfully.
 * The caller must bind this receipt to its canonical action and independently
 * confirm ledger closure. Different/missing SHAs never mean exact-head approval.
 */
export interface CodePublicationReceipt {
  issueId: string;
  repo: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  draft: boolean;
  admittedRuntime: boolean;
  requiredCheck: {
    command: string;
    passed: boolean;
    exitCode: number;
    timedOut: boolean;
    afterCheck: CodeGitObservation;
  };
  review: { fingerprint: string; verdict: "approve"; afterApproval: CodeGitObservation };
  publication: { beforePush: CodeGitObservation; afterPush: CodeGitObservation; remoteHeadSha: string | null };
  postRebaseCheck: "not_run" | "passed" | "failed_reverted" | "incomplete";
  /** Present only after strict check/review/publication artifact comparisons pass. */
  exactArtifact?: CodePublicationArtifact;
}

export interface CodeHandlerDeps {
  db: DB;
  linear: LinearAdapter;
  github: GitHubClient;
  glm: GLMClient;
  cloudflare: CloudflareClient | null;
  reposDir: string;
  workspacesDir: string;
  agentLoopMaxIterations: number;
  agentLoopTimeoutMs: number;
  /**
   * Optional runner supplied by a host that admits each invocation against the
   * existing owner, executor, ledger and shared deadline. Used for the primary
   * loop and both fix-up stages. Omission keeps the current runner unchanged.
   * An injected failure never falls back or publishes partially completed work.
   */
  runAdmittedAgentLoop?: AdmittedCodeLoopRunner;
  /** Reviewer pass config — provider order, max rounds, per-round caps. */
  review: ReviewConfig;
  /** Optional run-level guard checked before publishing any branch or PR. */
  assertCanPublish?: () => void;
  /** Trusted canary opt-in. Legacy publication behavior is unchanged on omission. */
  strictPublicationArtifact?: true;
  /** Trusted host-only readiness persistence; never a publication authorization.
   * Failure is recorded without relabeling an already-created PR as a failure.
   */
  onPublicationReceipt?: (receipt: Readonly<CodePublicationReceipt>) => void | Promise<void>;
}

export interface CodeHandlerArgs {
  issue: AssignedIssue;
  comments: readonly IssueComment[];
  repo: string; // "owner/repo"
  /**
   * Classifier-assigned scope. Used to scale the agent loop iteration caps:
   * S tickets get a tighter budget (28 iters total) than M (50). L is
   * already auto-bounced before reaching here. Optional — old call paths
   * without scope info default to M.
   */
  scope?: "S" | "M" | "L";
  /** Publish this ticket's PR as a draft; existing intake defaults to ready. */
  draftPr?: boolean;
}

export interface CodeHandlerResult {
  status: "pr_opened" | "no_changes" | "agent_failed" | "blocked" | "timeout" | "check_failed" | "review_failed";
  prUrl?: string;
  prNumber?: number;
  branch: string;
  summary: string | null;
}

/** The optional seam changes no credentials, providers, intake or publication authority. */
async function runCodeAgentLoop(deps: CodeHandlerDeps, args: AgentLoopArgs): Promise<AgentLoopResult> {
  const admitted = deps.runAdmittedAgentLoop;
  if (admitted) throwIfExpired(args);
  const result = await (admitted ?? runAgentLoop)(args);
  if (admitted) {
    throwIfExpired(args);
    // The legacy runner may salvage commits after an incomplete loop. A newly
    // admitted runtime must finish explicitly before checks/review/publication
    // proceed. Keep blocked/timeout handling in the existing caller branches.
    if (result.status !== "finished" && result.status !== "blocked" && result.status !== "timeout") {
      throw new Error(`Admitted code loop did not finish (${result.status})`);
    }
  }
  return result;
}

export async function runCodeHandler(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
): Promise<CodeHandlerResult> {
  const budget = createDeadline({ timeoutMs: deps.agentLoopTimeoutMs });
  try {
    return await runCodeHandlerWithinDeadline(deps, args, budget);
  } catch (err) {
    if (!(err instanceof DeadlineExceededError) && !budget.signal.aborted) throw err;
    await escalateToReporter(deps, args, "timeout");
    return {
      status: "timeout",
      branch: `${args.issue.identifier}-${slugify(args.issue.title)}`,
      summary: "Shared execution deadline exhausted; remaining work was stopped.",
    };
  } finally {
    budget.dispose();
  }
}

type CodeBudget = ReturnType<typeof createDeadline>;

async function runCodeHandlerWithinDeadline(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  budget: CodeBudget,
): Promise<CodeHandlerResult> {
  budget.throwIfExpired();
  const [owner, name] = args.repo.split("/") as [string, string];

  const branch = `${args.issue.identifier}-${slugify(args.issue.title)}`;
  const worktreePath = resolve(deps.workspacesDir, args.issue.identifier);
  const strictArtifact = deps.strictPublicationArtifact === true;
  if (deps.strictPublicationArtifact !== undefined && !strictArtifact) throw new Error("invalid_strict_publication_policy");
  const sameArtifact = (left: CodePublicationArtifact, right: CodePublicationArtifact) =>
    left.headSha === right.headSha && left.baseSha === right.baseSha && left.treeSha === right.treeSha;
  const observeArtifact = async (): Promise<CodePublicationArtifact> => {
    budget.throwIfExpired();
    try {
      const refs = ["rev-parse", "HEAD", "HEAD^{tree}", `${BASE_BRANCH}^{commit}`, `refs/heads/${branch}^{commit}`];
      const before = await gitMust(refs, { ...budget, cwd: worktreePath });
      const status = await gitMust(["status", "--porcelain=v1", "--untracked-files=all"], { ...budget, cwd: worktreePath });
      const after = await gitMust(refs, { ...budget, cwd: worktreePath });
      const parts = before.stdout.trim().split("\n");
      if (before.stdout !== after.stdout || status.stdout !== "" || parts.length !== 4
          || parts.some(sha => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) || parts[0] !== parts[3]) throw new Error();
      budget.throwIfExpired();
      return { headSha: parts[0]!, treeSha: parts[1]!, baseSha: parts[2]!, worktreeClean: true };
    } catch { budget.throwIfExpired(); throw new Error("strict_publication_artifact_unverified"); }
  };
  let checkStartedArtifact: CodePublicationArtifact | undefined;
  let checkedArtifact: CodePublicationArtifact | undefined;
  const beforeRequiredCheck = strictArtifact ? async () => {
    checkedArtifact = undefined;
    checkStartedArtifact = await observeArtifact();
  } : undefined;
  const assertCheckedArtifact = strictArtifact ? async () => {
    if (!checkedArtifact || !sameArtifact(checkedArtifact, await observeArtifact())) throw new Error("strict_publication_artifact_changed");
  } : undefined;
  const observeGit = async (): Promise<CodeGitObservation> => {
    if (!deps.onPublicationReceipt) return { headSha: null, worktreeClean: null };
    try {
      const head = await getHeadSha(worktreePath, budget);
      const status = await gitMust(["status", "--porcelain=v1", "--untracked-files=normal"], { ...budget, cwd: worktreePath });
      return { headSha: /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head) ? head : null, worktreeClean: status.stdout.length === 0 };
    } catch { return { headSha: null, worktreeClean: null }; }
  };
  let requiredCheck: CodePublicationReceipt["requiredCheck"] | undefined;
  const observeRequiredCheck = deps.onPublicationReceipt || strictArtifact ? async (result: ExecResult) => {
    if (strictArtifact) {
      const after = await observeArtifact();
      if (result.exitCode !== 0 || result.timedOut || !checkStartedArtifact || !sameArtifact(checkStartedArtifact, after)) throw new Error("strict_publication_check_unverified");
      checkedArtifact = after;
    }
    requiredCheck = { command: CHECK_COMMAND, passed: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode, timedOut: result.timedOut, afterCheck: await observeGit() };
  } : undefined;

  log.info("code handler starting", {
    issue: args.issue.identifier,
    repo: args.repo,
    branch,
    worktreePath,
  });

  const freshUrl = await deps.github.cloneUrl(owner, name);
  budget.throwIfExpired();
  const bareDir = await ensureBareClone({
    owner,
    repo: name,
    reposDir: deps.reposDir,
    freshTokenUrl: freshUrl,
    deadlineMs: budget.deadlineMs,
    signal: budget.signal,
  });

  const viewer = await deps.github.getViewer();
  budget.throwIfExpired();
  const authorEmail = `${viewer.login}@users.noreply.github.com`;

  await createWorktree({
    bareDir,
    worktreePath,
    branch,
    baseBranch: BASE_BRANCH,
    authorName: viewer.login,
    authorEmail,
    deadlineMs: budget.deadlineMs,
    signal: budget.signal,
  });

  const executor = bindExecutorDeadline(createWorkspaceExecutor(worktreePath), budget);
  const system = composeSystemPrompt({ taskInstructions: CODE_TASK_INSTRUCTIONS });
  const projectSection = formatProjectContext(
    loadProjectContext(worktreePath),
    loadSkillIndex(worktreePath),
  );
  const ticketMessage = renderTicketForAgent(args.issue, args.comments, {
    worktreePath,
    branch,
  });
  const taskMessage = projectSection
    ? `${projectSection}\n\n---\n\n${ticketMessage}`
    : ticketMessage;

  const loopResult = await runCodeAgentLoop(deps, {
    glm: deps.glm,
    executor,
    systemPrompt: system,
    task: taskMessage,
    maxIterations: deps.agentLoopMaxIterations,
    phases: buildCodePhases(args.scope),
    timeoutMs: deps.agentLoopTimeoutMs,
    deadlineMs: budget.deadlineMs,
    signal: budget.signal,
    temperature: 0.3,
    linear: deps.linear,
    currentIssue: {
      id: args.issue.id,
      identifier: args.issue.identifier,
      teamId: args.issue.teamId,
    },
    github: deps.github,
    defaultRepo: args.repo,
    finishGateCommand: CHECK_COMMAND,
    ...(deps.cloudflare ? { cloudflare: deps.cloudflare } : {}),
  });

  log.info("agent loop done", {
    issue: args.issue.identifier,
    status: loopResult.status,
    phase: loopResult.phase,
    iterations: loopResult.iterations,
    inputTokens: loopResult.inputTokens,
    outputTokens: loopResult.outputTokens,
    cacheCreationTokens: loopResult.cacheCreationTokens,
    cacheReadTokens: loopResult.cacheReadTokens,
  });

  if (loopResult.status === "blocked") {
    await escalateToReporter(deps, args, "blocked", loopResult.summary);
    return { status: "blocked", branch, summary: loopResult.summary };
  }
  budget.throwIfExpired();
  if (loopResult.status === "timeout") throw new DeadlineExceededError();

  const baseRef = BASE_BRANCH;
  const hasCommits = await hasCommitsAhead(worktreePath, baseRef, budget);

  if (loopResult.status !== "finished") {
    if (hasCommits) {
      log.warn("agent did not finish but has commits; opening PR anyway", {
        issue: args.issue.identifier,
        status: loopResult.status,
      });
    } else {
      // No commits and didn't finish cleanly — escalate.
      await escalateToReporter(deps, args, loopResult.status);
      return { status: "agent_failed", branch, summary: null };
    }
  }

  if (!hasCommits) {
    const summary = loopResult.summary ?? "no changes needed";
    await deps.linear.postComment(
      args.issue.id,
      `i looked at this but didn't end up changing anything. ${summary}`,
    );
    await reassignToReporter(deps, args);
    setTerminalState(deps.db, args.issue.id, "escalated");
    return { status: "no_changes", branch, summary };
  }

  // Trust-but-verify the check gate. The agent task instructions tell it
  // to run `bun run check` before finish, but it doesn't always honor that
  // (see ERT-1645). Re-running here lets us catch the failure and feed it
  // back to the agent for a fix-up cycle, instead of hitting the pre-push
  // hook with no recourse.
  const checkPassed = await ensurePostFinishCheckPasses(deps, args, {
    executor,
    system,
    budget,
    ...(beforeRequiredCheck ? { beforeRequiredCheck } : {}),
    ...(observeRequiredCheck ? { observeRequiredCheck } : {}),
  });
  if (checkPassed !== "passed") {
    return { status: checkPassed, branch, summary: loopResult.summary };
  }

  // ===== reviewer pass =====
  const reviewerGlm = new GLMClient(
    chainWithOrder(deps.glm.chain, deps.review.providerOrder),
  );
  const reviewFingerprint = `${args.issue.id}:${Date.now()}`;
  const reviewOutcome = await runReviewLoop(deps, args, {
    executor,
    primaryRunLog: loopResult.runLog,
    reviewerGlm,
    fingerprint: reviewFingerprint,
    worktreePath,
    budget,
    ...(beforeRequiredCheck ? { beforeRequiredCheck } : {}),
    ...(assertCheckedArtifact ? { assertCheckedArtifact } : {}),
    ...(observeRequiredCheck ? { observeRequiredCheck } : {}),
  });
  if (reviewOutcome.kind === "escalated") {
    return {
      status: reviewOutcome.status ?? "review_failed",
      branch,
      summary: reviewOutcome.summary ?? loopResult.summary,
    };
  }
  const verificationReport = reviewOutcome.verificationReport;
  await assertCheckedArtifact?.();
  const afterApproval = deps.onPublicationReceipt ? await observeGit() : { headSha: null, worktreeClean: null };
  if (deps.onPublicationReceipt) budget.throwIfExpired();
  let postRebaseCheck: CodePublicationReceipt["postRebaseCheck"] = "not_run";

  // Rebase onto fresh main so the PR opens on top of latest. Degrades
  // gracefully: conflict → push un-rebased; check fails after rebase →
  // revert and push pre-rebase. Never fails the run.
  const freshUrlForPush = await deps.github.cloneUrl(owner, name);
  budget.throwIfExpired();
  const rebase = await rebaseOntoFreshBase({
    bareDir,
    worktreePath,
    freshTokenUrl: freshUrlForPush,
    baseBranch: BASE_BRANCH,
    deadlineMs: budget.deadlineMs,
    signal: budget.signal,
  });
  if (strictArtifact) {
    if (rebase.kind !== "no_op" || rebase.sha !== checkedArtifact?.headSha) throw new Error("strict_publication_rebase_changed");
    await assertCheckedArtifact!();
  }
  if (rebase.kind === "conflict") {
    log.warn("rebase onto main conflicted; pushing un-rebased branch", {
      issue: args.issue.identifier,
      branch,
    });
  } else if (rebase.kind === "clean") {
    const recheck = await executor.run(CHECK_COMMAND, {
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    if (recheck.exitCode !== 0) {
      postRebaseCheck = "failed_reverted";
      log.warn("check failed after rebase; reverting and pushing pre-rebase", {
        issue: args.issue.identifier,
        branch,
        exitCode: recheck.exitCode,
      });
      await gitMust(["reset", "--hard", rebase.preRebaseSha], {
        cwd: worktreePath,
        deadlineMs: budget.deadlineMs,
        signal: budget.signal,
      });
    } else {
      postRebaseCheck = recheck.timedOut ? "incomplete" : "passed";
      log.info("rebased onto fresh main", {
        issue: args.issue.identifier,
        branch,
        preRebaseSha: rebase.preRebaseSha,
        postRebaseSha: rebase.postRebaseSha,
      });
    }
  }

  const diff = await getDiff(worktreePath, baseRef, budget);
  const log_ = await getCommitLog(worktreePath, baseRef, budget);

  const prBody = await composePrBody(deps, {
    issue: args.issue,
    branch,
    summary: loopResult.summary,
    diff,
    commitLog: log_,
    verificationReport,
    deadlineMs: budget.deadlineMs,
    signal: budget.signal,
  });
  const prTitle = await composePrTitle(deps, {
    issue: args.issue,
    summary: loopResult.summary,
    diff,
    deadlineMs: budget.deadlineMs,
    signal: budget.signal,
  });

  budget.throwIfExpired();
  const beforePush = deps.onPublicationReceipt ? await observeGit() : { headSha: null, worktreeClean: null };
  if (deps.onPublicationReceipt) budget.throwIfExpired();
  await assertCheckedArtifact?.();
  deps.assertCanPublish?.();
  await pushBranch({ worktreePath, freshTokenUrl: freshUrlForPush, branch,
    ...(strictArtifact ? { sourceCommit: checkedArtifact!.headSha } : {}),
    deadlineMs: budget.deadlineMs, signal: budget.signal });
  budget.throwIfExpired();
  const afterPush = deps.onPublicationReceipt ? await observeGit() : { headSha: null, worktreeClean: null };
  if (deps.onPublicationReceipt) budget.throwIfExpired();
  await assertCheckedArtifact?.();
  deps.assertCanPublish?.();
  const pr = await deps.github.openPullRequest({
    owner,
    repo: name,
    head: branch,
    base: BASE_BRANCH,
    title: prTitle,
    body: prBody,
    draft: args.draftPr ?? false,
  });

  recordPr(deps.db, {
    githubId: pr.number, // we use number as a stable id within a repo for our purposes
    ticketLinearId: args.issue.id,
    repo: args.repo,
    prNumber: pr.number,
    branch,
  });

  if (deps.onPublicationReceipt && requiredCheck) {
    try {
      await deps.onPublicationReceipt(Object.freeze({ issueId: args.issue.id, repo: args.repo, branch,
        prNumber: pr.number, prUrl: pr.url, draft: pr.isDraft, admittedRuntime: !!deps.runAdmittedAgentLoop,
        requiredCheck, review: { fingerprint: reviewFingerprint, verdict: "approve" as const, afterApproval },
        publication: { beforePush, afterPush, remoteHeadSha: /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(pr.headSha) ? pr.headSha : null },
        postRebaseCheck, ...(strictArtifact && checkedArtifact ? { exactArtifact: { ...checkedArtifact } } : {}) }));
    } catch {
      // A notification/persistence failure cannot erase the real PR delivery or
      // trigger another coding attempt. Missing receipt remains unready.
      try { recordEvent(deps.db, { eventType: "code_publication_receipt_failed", ticketLinearId: args.issue.id }); } catch { /* Delivery is already durable above. */ }
      log.warn("publication receipt persistence failed", { issue: args.issue.identifier });
    }
  }

  // PR creation is a legacy non-cancellable API call. Once its response arrives,
  // preserve the real delivery outcome even if it crossed the execution deadline.
  // Do not start follow-up remote writes after expiry.
  const published: CodeHandlerResult = {
    status: "pr_opened", prUrl: pr.url, prNumber: pr.number, branch,
    summary: loopResult.summary,
  };
  const publicationExpired = () => budget.signal.aborted || Date.now() >= budget.deadlineMs;
  if (publicationExpired()) {
    log.warn("PR recorded after deadline; skipping Linear follow-up", { issue: args.issue.identifier, pr: pr.url });
    return published;
  }
  try {
    await deps.linear.addPrAttachment(args.issue.id, pr.url, prTitle);
  } catch (err) {
    // Linear auto-detects [TICKET] references in PR bodies and creates
    // its own attachment via the GitHub integration. If we lose that race
    // we get "Duplicate attachment for duplicate url" — non-fatal; the
    // attachment exists either way.
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate/i.test(message)) log.warn("PR opened but Linear attachment failed", {
      issue: args.issue.identifier, pr: pr.url, error: message,
    });
    else log.debug("attachment already exists (Linear auto-detected)", {
      issue: args.issue.identifier,
      pr: pr.url,
    });
  }
  if (!publicationExpired()) {
    try {
      await deps.linear.postComment(args.issue.id, `pr is up: ${pr.url}\n\n${loopResult.summary ?? ""}`.trim());
    } catch (err) {
      log.warn("PR opened but Linear notification failed", {
        issue: args.issue.identifier, pr: pr.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return published;
}

interface RenderTicketOpts {
  worktreePath: string;
  branch: string;
}

function renderTicketForAgent(
  issue: AssignedIssue,
  comments: readonly IssueComment[],
  opts: RenderTicketOpts,
): string {
  const sections: string[] = [];
  sections.push(`Repo is at: ${opts.worktreePath}`);
  sections.push(`Branch: ${opts.branch}`);
  sections.push("");
  sections.push(`Ticket: ${issue.identifier} — ${issue.title}`);
  sections.push("");
  sections.push("Description:");
  sections.push(issue.description ?? "(no description)");
  if (comments.length > 0) {
    sections.push("");
    sections.push(`Comments (${comments.length}, oldest first):`);
    const sorted = [...comments].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const c of sorted) {
      sections.push(`  ${c.userName ?? "?"} (${c.createdAt}): ${c.body}`);
    }
  }
  sections.push("");
  sections.push("Make the change, commit, and call finish() when done.");
  return sections.join("\n");
}

interface ComposePrBodyArgs extends DeadlineOptions {
  issue: AssignedIssue;
  branch: string;
  summary: string | null;
  diff: string;
  commitLog: string;
  verificationReport: string;
}

async function composePrBody(
  deps: CodeHandlerDeps,
  args: ComposePrBodyArgs,
): Promise<string> {
  const system = composeSystemPrompt({
    taskInstructions: PR_BODY_TASK_INSTRUCTIONS,
  });
  const truncatedDiff =
    args.diff.length > 12_000
      ? args.diff.slice(0, 12_000) + "\n... (diff truncated)"
      : args.diff;
  const user = [
    `Ticket: ${args.issue.identifier} — ${args.issue.title}`,
    `Branch: ${args.branch}`,
    `Your finish summary: ${args.summary ?? "(none)"}`,
    "",
    "Commits:",
    args.commitLog,
    "",
    "Diff:",
    truncatedDiff,
    "",
    "Verification (from reviewer pass — append this verbatim as the ## Verification section):",
    args.verificationReport,
  ].join("\n");
  return await deps.glm.complete({
    system,
    user,
    temperature: 0.4,
    maxTokens: 1024,
    ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

interface ComposePrTitleArgs extends DeadlineOptions {
  issue: AssignedIssue;
  summary: string | null;
  diff: string;
}

async function composePrTitle(
  deps: CodeHandlerDeps,
  args: ComposePrTitleArgs,
): Promise<string> {
  const system = composeSystemPrompt({
    taskInstructions: PR_TITLE_TASK_INSTRUCTIONS,
  });
  // Heuristic for scope: take the first changed top-level src/ directory
  // from the diff if there is one, else leave it for the model to infer.
  const truncatedDiff =
    args.diff.length > 6000 ? args.diff.slice(0, 6000) + "\n... (truncated)" : args.diff;
  const user = [
    `Ticket: ${args.issue.identifier} — ${args.issue.title}`,
    `Your finish summary: ${args.summary ?? "(none)"}`,
    "",
    "Diff (truncated):",
    truncatedDiff,
  ].join("\n");
  const raw = await deps.glm.complete({
    system,
    user,
    temperature: 0.2,
    maxTokens: 128,
    ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return raw.trim().split("\n")[0]?.trim() || args.issue.title;
}

interface FixupContext {
  executor: Executor;
  system: string;
  budget: CodeBudget;
  observeRequiredCheck?: (result: ExecResult) => Promise<void>;
  beforeRequiredCheck?: () => Promise<void>;
}

/**
 * Run `bun run check`. If it fails, feed the failure back to the agent for
 * one fix-up cycle and re-check. All stages share the original deadline.
 * Unsuccessful outcomes have already been escalated before returning.
 */
async function ensurePostFinishCheckPasses(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  ctx: FixupContext,
): Promise<"passed" | "blocked" | "check_failed"> {
  ctx.budget.throwIfExpired();
  await ctx.beforeRequiredCheck?.();
  const first = await ctx.executor.run(CHECK_COMMAND, {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (first.exitCode === 0) { await ctx.observeRequiredCheck?.(first); return "passed"; }

  log.warn("post-finish check failed; running fix-up", {
    issue: args.issue.identifier,
    exitCode: first.exitCode,
    timedOut: first.timedOut,
  });

  const fixupTask = renderCheckFixupTask(first);
  const fixupResult = await runCodeAgentLoop(deps, {
    glm: deps.glm,
    executor: ctx.executor,
    systemPrompt: ctx.system,
    task: fixupTask,
    maxIterations: FIXUP_MAX_ITERATIONS,
    timeoutMs: deps.agentLoopTimeoutMs,
    deadlineMs: ctx.budget.deadlineMs,
    signal: ctx.budget.signal,
    temperature: 0.3,
    linear: deps.linear,
    currentIssue: {
      id: args.issue.id,
      identifier: args.issue.identifier,
      teamId: args.issue.teamId,
    },
    github: deps.github,
    defaultRepo: args.repo,
    finishGateCommand: CHECK_COMMAND,
    ...(deps.cloudflare ? { cloudflare: deps.cloudflare } : {}),
  });
  log.info("fixup loop done", {
    issue: args.issue.identifier,
    status: fixupResult.status,
    iterations: fixupResult.iterations,
    inputTokens: fixupResult.inputTokens,
    outputTokens: fixupResult.outputTokens,
    cacheCreationTokens: fixupResult.cacheCreationTokens,
    cacheReadTokens: fixupResult.cacheReadTokens,
  });
  if (fixupResult.status === "blocked") {
    await escalateToReporter(deps, args, "blocked", fixupResult.summary);
    return "blocked";
  }
  ctx.budget.throwIfExpired();
  if (fixupResult.status === "timeout") throw new DeadlineExceededError();

  await ctx.beforeRequiredCheck?.();
  const second = await ctx.executor.run(CHECK_COMMAND, {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (second.exitCode === 0) { await ctx.observeRequiredCheck?.(second); return "passed"; }

  log.warn("check still failing after fix-up; escalating", {
    issue: args.issue.identifier,
  });
  await postCheckFailureEscalation(deps, args, second);
  return "check_failed";
}

function renderCheckFixupTask(failed: { stdout: string; stderr: string }): string {
  const combined = `${failed.stdout}\n${failed.stderr}`.trim();
  const truncated =
    combined.length > FIXUP_OUTPUT_BUDGET
      ? `${combined.slice(0, FIXUP_OUTPUT_BUDGET)}\n... (truncated)`
      : combined;
  return `${CHECK_FIXUP_TASK_INSTRUCTIONS}\n\nMost recent \`${CHECK_COMMAND}\` output:\n\n\`\`\`\n${truncated}\n\`\`\``;
}

async function postCheckFailureEscalation(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  failed: { stdout: string; stderr: string },
): Promise<void> {
  const tail = `${failed.stdout}\n${failed.stderr}`
    .trim()
    .split("\n")
    .slice(-25)
    .join("\n");
  const body = [
    `i thought i was done but \`${CHECK_COMMAND}\` is still failing after a fix-up pass. bouncing — i'd want a human to look before i try again.`,
    "",
    "tail of the failure output:",
    "```",
    tail,
    "```",
  ].join("\n");
  try {
    await deps.linear.postComment(args.issue.id, body);
  } catch (err) {
    log.warn("could not post check-failure escalation comment", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await reassignToReporter(deps, args);
  setTerminalState(deps.db, args.issue.id, "escalated");
}

async function reassignToReporter(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
): Promise<void> {
  if (args.issue.creatorId) {
    try {
      await deps.linear.reassign(args.issue.id, args.issue.creatorId);
    } catch (err) {
      log.warn("could not reassign", {
        issue: args.issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    try {
      await deps.linear.unassign(args.issue.id);
    } catch (err) {
      log.warn("could not unassign", {
        issue: args.issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function escalateToReporter(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  reason: string,
  detail?: string | null,
): Promise<void> {
  const messages: Record<string, string> = {
    blocked: "i'm blocked and haven't verified this work. handing it back with the evidence below.",
    review_failed:
      "the reviewer couldn't complete after two attempts, so there's no review verdict for this revision. i've preserved the work and haven't opened a PR. handing it back for human review.",
    iteration_cap:
      "i hit the iteration cap on this one before getting to a clean stopping point. bouncing it back so a human can take a look.",
    timeout:
      "i ran out of time on this one. bouncing it back — happy to take another swing if someone can point me at the right approach.",
    no_finish:
      "the model returned without calling finish, which usually means it lost the thread. bouncing — i'd want a human to look before i try again.",
    error:
      "ran into an error i couldn't recover from. bouncing back to you.",
  };
  const body = [messages[reason] ?? `something went wrong (${reason}). bouncing back.`, detail]
    .filter(Boolean).join("\n\n");
  try {
    await deps.linear.postComment(args.issue.id, body);
  } catch (err) {
    log.warn("could not post escalation comment", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await reassignToReporter(deps, args);
  setTerminalState(deps.db, args.issue.id, "escalated");
}

interface ReviewLoopCtx {
  executor: Executor;
  primaryRunLog: readonly RunLogEntry[];
  reviewerGlm: GLMClient;
  fingerprint: string;
  worktreePath: string;
  budget: CodeBudget;
  observeRequiredCheck?: (result: ExecResult) => Promise<void>;
  beforeRequiredCheck?: () => Promise<void>;
  assertCheckedArtifact?: () => Promise<void>;
}

type ReviewLoopOutcome =
  | { kind: "approved"; verificationReport: string }
  | { kind: "escalated"; status?: "blocked" | "check_failed" | "review_failed"; summary?: string };

async function runReviewLoop(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  ctx: ReviewLoopCtx,
): Promise<ReviewLoopOutcome> {
  let round = 0;
  let previousFindings: readonly { title: string; detail: string; bugClass: string }[] = [];
  let lastRunLog = ctx.primaryRunLog;

  while (round < deps.review.maxRounds) {
    ctx.budget.throwIfExpired();
    round++;
    await ctx.assertCheckedArtifact?.();
    const diff = await getDiff(ctx.worktreePath, BASE_BRANCH, ctx.budget);
    const grepFn = async (pattern: string, glob?: string) =>
      ctx.executor.grep(pattern, glob);
    const untested = await findUntestedExports({ diff, grep: grepFn });
    const unwired = await findUnwiredIdentifiers({ diff, grep: grepFn });
    const precheck = [...untested, ...unwired];
    const ticket = {
      identifier: args.issue.identifier,
      title: args.issue.title,
      description: args.issue.description ?? null,
    };

    await ctx.assertCheckedArtifact?.();
    let outcome: ReviewerResult = await runReviewer({
      db: deps.db,
      glm: ctx.reviewerGlm,
      executor: ctx.executor,
      ticket,
      issueLinearId: args.issue.id,
      fingerprint: ctx.fingerprint,
      round,
      diff,
      runLog: lastRunLog,
      precheckFindings: precheck,
      previousFindings,
      worktreePath: ctx.worktreePath,
      iterationCap: deps.review.iterationCap,
      timeoutMs: deps.review.timeoutMs,
      deadlineMs: ctx.budget.deadlineMs,
      signal: ctx.budget.signal,
    });

    ctx.budget.throwIfExpired();
    await ctx.assertCheckedArtifact?.();

    if (outcome.kind === "failed") {
      const firstReason = outcome.reason;
      log.warn("reviewer pass failed; retrying once", {
        issue: args.issue.identifier,
        round,
        reason: outcome.reason,
      });
      outcome = await runReviewer({
        db: deps.db,
        glm: ctx.reviewerGlm,
        executor: ctx.executor,
        ticket,
        issueLinearId: args.issue.id,
        fingerprint: ctx.fingerprint,
        round,
        diff,
        runLog: lastRunLog,
        precheckFindings: precheck,
        previousFindings,
        worktreePath: ctx.worktreePath,
        iterationCap: deps.review.iterationCap,
        timeoutMs: deps.review.timeoutMs,
        deadlineMs: ctx.budget.deadlineMs,
        signal: ctx.budget.signal,
      });
      ctx.budget.throwIfExpired();
      await ctx.assertCheckedArtifact?.();
      if (outcome.kind === "failed") {
        recordEvent(deps.db, {
          eventType: "review_failed",
          ticketLinearId: args.issue.id,
          payload: {
            round,
            reason: outcome.reason,
            firstReason,
            attempts: 2,
            failureClass: "review_unavailable",
          },
        });
        log.warn("reviewer unavailable after two attempts; escalating without publication", {
          issue: args.issue.identifier,
          round,
        });
        // A failed reviewer supplied no verdict. Preserve the work for a human;
        // do not invent findings or send the primary into another repair loop.
        markReviewPassEscalated(deps.db, {
          issueLinearId: args.issue.id,
          fingerprint: ctx.fingerprint,
          round,
        });
        await escalateToReporter(deps, args, "review_failed");
        return {
          kind: "escalated",
          status: "review_failed",
          summary: "Review unavailable after two failed attempts for this revision; human review is required before publication.",
        };
      }
    }

    recordEvent(deps.db, {
      eventType: "review_decision",
      ticketLinearId: args.issue.id,
      payload: {
        round,
        verdict: outcome.review.verdict,
        finding_count: outcome.review.findings.length,
      },
    });

    if (outcome.review.verdict === "approve") {
      const report = outcome.review.verificationReport.trim();
      return {
        kind: "approved",
        verificationReport:
          report.length > 0
            ? outcome.review.verificationReport
            : "(no verification report — reviewer approved without findings)",
      };
    }

    // changes_needed
    if (round >= deps.review.maxRounds) {
      const body = synthesizeReviewRejectedBody({
        finalFindings: outcome.review.findings.map((f) => ({
          title: f.title,
          bugClass: f.bugClass,
        })),
        rounds: deps.review.maxRounds,
      });
      try {
        await deps.linear.postComment(args.issue.id, body);
      } catch (err) {
        log.warn("could not post review-rejected escalation comment", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await reassignToReporter(deps, args);
      setTerminalState(deps.db, args.issue.id, "escalated");
      markReviewPassEscalated(deps.db, {
        issueLinearId: args.issue.id,
        fingerprint: ctx.fingerprint,
        round,
      });
      return { kind: "escalated" };
    }

    // Re-run the primary with findings as a fixup task.
    const fixupTask = renderReviewerFixupTask(outcome.review.findings);
    const primarySystem = composeSystemPrompt({
      taskInstructions: CODE_TASK_INSTRUCTIONS,
    });
    const fixup = await runCodeAgentLoop(deps, {
      glm: deps.glm,
      executor: ctx.executor,
      systemPrompt: primarySystem,
      task: fixupTask,
      maxIterations: FIXUP_MAX_ITERATIONS,
      timeoutMs: deps.agentLoopTimeoutMs,
      deadlineMs: ctx.budget.deadlineMs,
      signal: ctx.budget.signal,
      temperature: 0.3,
      linear: deps.linear,
      currentIssue: {
        id: args.issue.id,
        identifier: args.issue.identifier,
        teamId: args.issue.teamId,
      },
      github: deps.github,
      defaultRepo: args.repo,
      finishGateCommand: CHECK_COMMAND,
      ...(deps.cloudflare ? { cloudflare: deps.cloudflare } : {}),
    });
    log.info("reviewer-driven fixup loop done", {
      issue: args.issue.identifier,
      round,
      status: fixup.status,
      iterations: fixup.iterations,
    });
    if (fixup.status === "blocked") {
      await escalateToReporter(deps, args, "blocked", fixup.summary);
      return { kind: "escalated", status: "blocked" };
    }
    ctx.budget.throwIfExpired();
    if (fixup.status === "timeout") throw new DeadlineExceededError();
    lastRunLog = fixup.runLog;
    previousFindings = outcome.review.findings.map((f) => ({
      title: f.title,
      detail: f.detail,
      bugClass: f.bugClass,
    }));
    const checkOk = await ensurePostFinishCheckPasses(deps, args, {
      executor: ctx.executor,
      system: primarySystem,
      budget: ctx.budget,
      ...(ctx.beforeRequiredCheck ? { beforeRequiredCheck: ctx.beforeRequiredCheck } : {}),
      ...(ctx.observeRequiredCheck ? { observeRequiredCheck: ctx.observeRequiredCheck } : {}),
    });
    if (checkOk !== "passed") return { kind: "escalated", status: checkOk };
  }
  return { kind: "escalated" };
}

function renderReviewerFixupTask(
  findings: readonly { title: string; detail: string; bugClass: string }[],
): string {
  const lines = [
    "A reviewer agent looked at your work and found blocking issues. Fix each one, commit, then call finish() again.",
    "",
    "Rules:",
    `- Run \`${CHECK_COMMAND}\` before finish.`,
    "- Address each finding directly. If you disagree with one, fix it anyway and explain in your finish summary.",
    "- Don't refactor unrelated code.",
    "",
    "Findings:",
  ];
  for (const f of findings) {
    lines.push(`- [${f.bugClass}] ${f.title}`);
    lines.push(`  ${f.detail}`);
  }
  return lines.join("\n");
}
