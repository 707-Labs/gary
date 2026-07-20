import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type {
  GitHubClient,
  OpenPullRequestSummary,
} from "../adapters/github.ts";
import { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, IssueComment, LinearAdapter } from "../adapters/linear.ts";
import { type PhaseSpec, runAgentLoop, type RunLogEntry } from "../agent/loop.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import {
  createWorktree,
  ensureBareClone,
  getCommitLog,
  getDiff,
  gitMust,
  hasCommitsAhead,
  pushBranch,
  rebaseOntoFreshBase,
  slugify,
} from "../git.ts";
import { LocalExecutor } from "../executors/local.ts";
import { log } from "../logger.ts";
import {
  formatProjectContext,
  loadProjectContext,
  loadRuleDocs,
  loadSkillIndex,
} from "../skills.ts";
import type { DB } from "../state/db.ts";
import { recordEvent, recordPr, setTerminalState } from "../state/queries.ts";
import { markReviewPassEscalated } from "../state/review-queries.ts";
import type { ReviewConfig } from "../config.ts";
import { chainWithOrder, decorrelatedOrder } from "../providers.ts";
import { runReviewer, type ReviewerResult } from "../review/runner.ts";
import { findUntestedExports, findUnwiredIdentifiers } from "../review/precheck.ts";
import { synthesizeReviewRejectedBody } from "../escalate.ts";

const BASE_BRANCH = "main";
const CHECK_COMMAND = "bun run check";
const CHECK_TIMEOUT_MS = 10 * 60_000;
const FIXUP_MAX_ITERATIONS = 15;
const FIXUP_OUTPUT_BUDGET = 8000;

/**
 * Test command for the post-finish gate. A typecheck-only gate can't see
 * behavioral breakage, so the gate also runs the target repo's unit tests
 * when it can find a safe (non-watch) invocation:
 *
 *   - GARY_TEST_COMMAND=off      → no test gate
 *   - GARY_TEST_COMMAND=<cmd>    → run <cmd> verbatim (all repos)
 *   - unset                     → autodetect from the worktree's
 *     package.json: `test:run` first, then `test` only when its body
 *     mentions "run" (ertai's bare `test: vitest` is watch mode and would
 *     hang the gate until the timeout).
 *
 * Returns null when there's nothing safe to run. Exported for tests.
 */
export function resolveTestGateCommand(worktreePath: string): string | null {
  const env = process.env.GARY_TEST_COMMAND?.trim();
  if (env === "off") return null;
  if (env) return env;
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(worktreePath, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return null;
  }
  if (typeof scripts["test:run"] === "string") return "bun run test:run";
  const test = scripts["test"];
  if (typeof test === "string" && /\brun\b/.test(test)) return "bun run test";
  return null;
}

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
]);

/**
 * Two-phase loop for the CODE handler. Investigate forces the model to
 * read the code and form a plan before being able to write; the model
 * voluntarily ends the phase by producing a turn with no tool calls
 * (signalling "done exploring") OR is forced over by hitting the
 * investigate cap. The implement phase opens with a forcing message
 * directing the model to write a brief plan, implement, and call finish.
 *
 * Iteration budgets are scaled by classification scope. Defaults were
 * raised from 8/20 (S) and 15/35 (M) after ERT-1574-style bounces: a
 * "small" ticket touching five call sites burns the whole investigate
 * budget on discovery and never gets to write. Tunable per scope via
 * GARY_PHASE_BUDGET_{S,M,L}="<investigate>/<implement>" without a deploy;
 * malformed values fall back to the defaults.
 *
 * Exported for tests.
 */
const PHASE_BUDGET_DEFAULTS: Record<
  "S" | "M" | "L",
  { investigate: number; implement: number }
> = {
  S: { investigate: 12, implement: 25 },
  M: { investigate: 20, implement: 45 },
  L: { investigate: 20, implement: 50 },
};

export function phaseBudget(
  scope: "S" | "M" | "L",
): { investigate: number; implement: number } {
  const fallback = PHASE_BUDGET_DEFAULTS[scope];
  const raw = process.env[`GARY_PHASE_BUDGET_${scope}`]?.trim();
  if (!raw) return fallback;
  const m = raw.match(/^(\d{1,3})\/(\d{1,3})$/);
  if (!m) {
    log.warn("malformed phase budget env; using default", { scope, raw });
    return fallback;
  }
  const investigate = Number(m[1]);
  const implement = Number(m[2]);
  if (investigate < 1 || implement < 1) return fallback;
  return { investigate, implement };
}

/**
 * Wall-clock multiplier for L tickets — the iteration budget above is
 * useless if the 15-minute default timeout fires first.
 */
const L_TIMEOUT_MULTIPLIER = 2;

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
        "good — you've explored. now: (1) write a 3-5 bullet plan of the changes you'll make, (2) implement them with write_file/edit_file/run_bash and commit your work, (3) run `bun run check` and fix anything you broke, (4) call finish() with a 1-2 sentence summary. if at any point you realize the change is bigger than expected or you're stuck, call finish() with a brief partial-progress note and a human will pick it up.",
      nudgeMessage:
        "you're approaching the iteration cap. wrap up: commit what you have, then call finish() with a brief summary (or a partial-progress note if you're stuck). a partial-progress finish is much better than running out of iterations mid-stream.",
    },
  ];
}

function checkFixupInstructions(command: string): string {
  return `Your previous turn ended with finish() but \`${command}\` is failing. Fix the errors caused by your changes, commit, then call finish() again.

Rules:
- Run \`${command}\` and confirm it exits 0 BEFORE calling finish.
- Only fix what's broken — don't refactor unrelated code.
- If the failure is in code you didn't touch, investigate before assuming it's pre-existing. This command gates your push, so anything failing here will block it.
- Commit your fix-up changes before calling finish.
- If you can't make it pass after a few iterations, call finish() with a one-sentence summary of what's still broken so a human can take over.`;
}

const CODE_TASK_INSTRUCTIONS = `You are working on a Linear ticket for 707 Labs. Own it end-to-end: solve the real problem behind the ticket, not just the literal sentence in the title, and take a design swing when the ticket leaves room for one.

You can use tools to read, edit, run bash commands, and commit. When you're done, call finish() with a short summary.

Ambition:
- Fix causes, not symptoms. If the clean solution means restructuring the code you're touching, do it — don't leave a patch on top of a structure that fights the change. Note refactors that are genuinely out of reach as follow-ups in your finish summary.
- When the ticket leaves design decisions to the implementer, make them. Pick the strongest approach and record the decision — and the alternatives you rejected — in your finish summary; it feeds the PR body.
- Don't gold-plate. Ambition is depth on the problem the ticket names, not speculative abstractions or drive-by rewrites of unrelated files.
- Ambition never means forcing a PR. A precise stop that enumerates the open decisions beats a plausible-looking PR you can't back with evidence.

Evidence:
- For a bug ticket, reproduce the bug first. Write a test that fails before your change and passes after, and name that test in your finish summary. If you can't reproduce it, don't guess at a fix — finish() with what you learned and what you'd need.
- If the fix turns out to already exist, ship the regression test alone and say so.
- Feature work is not exempt: a new server route, endpoint, or non-trivial function ships WITH a test that exercises its behavior — including the failure paths (not-found, invalid input, unauthorized). Typecheck passes on plenty of wrong code: a 404 handler that throws 500, HTML sanitized in the wrong order, an error class that doesn't extend Error. Only a test that runs the path catches these.
- A green full suite is not evidence that your specific fix works. Name the specific test or command that demonstrates the behavior change.

Process:
- Read the whole ticket thread before touching code — comments often redefine the ask. If a previous attempt at this ticket failed (bounced, escalated, or review-rejected in the thread), open your plan by stating what that attempt got wrong and how yours differs.
- Read before you write. Look at the existing code, the project's conventions (CLAUDE.md, AGENTS.md, .claude/skills/), and any related files before changing anything.
- BEFORE calling finish, run \`bun run check\` (the project's typecheck/svelte-check command). If there are errors caused by your changes, fix them and re-run. The repo has a pre-push hook that runs the same command — your push will be rejected if it fails.
- If package.json has a \`ci\` script, run \`bun run ci\` and get it as green as you can before finishing. If part of it can't run in this environment (e.g. missing playwright browsers), say exactly which part in your finish summary instead of claiming green.
- Run other tests for the area you touched. If tests fail because of your change, fix them.
- Commit your changes before calling finish.

Hard limits:
- A change that requires a D1 database migration is an automatic stop. Do not write the migration — finish() explaining what migration would be needed and why you stopped. Migrations don't run through the normal deploy path and this class of change has broken prod before.
- Don't install new dependencies unless the ticket clearly requires it.
- If you stop early — stuck, missing context, scope blowout — your finish summary must enumerate every open decision as a numbered list of concrete options with your recommended default for each. You're closest to the code; the enumeration is the valuable part of the hand-off.`;

export const PR_BODY_TASK_INSTRUCTIONS = `Write a PR body for the changes you just made. Use voice.md examples 5 (small, confident) and 6 (medium, with uncertainty) as your structural template — match that exact format. Pick the level of detail based on the size and certainty of this change.

Output ONLY the PR body markdown. Do not output the title — the title is generated separately. Do not output any preamble like "Here is the PR body".

The Summary describes what the diff actually does, not what you originally planned. The diff is the source of truth. If your finish summary, the ticket title, or your initial framing doesn't match what the diff actually changed, trust the diff and describe what landed. Open the file list if you have to — every section in the body should be defensible by pointing at a hunk.

Required sections, in order:
1. \`## Summary\` — 1-3 short paragraphs and/or bullets explaining what changed and why. Lead with the most important change.
2. \`## Things i'm less sure about\` — only if there's genuine uncertainty. Skip the section entirely if the change is small and confident.
3. \`## Verification\` — paste the reviewer's verification report verbatim. Do not edit, summarize, or paraphrase. If you were given the placeholder text "_reviewer pass unavailable for this PR_", use that.
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
  /** Reviewer pass config — provider order, max rounds, per-round caps. */
  review: ReviewConfig;
}

export interface CodeHandlerArgs {
  issue: AssignedIssue;
  comments: readonly IssueComment[];
  repo: string; // "owner/repo"
  /**
   * Classifier-assigned scope. Used to scale the agent loop iteration caps
   * (defaults: S: 37 total, M: 65, L: 70 — see phaseBudget) and the loop
   * timeout (L gets 2x wall clock). Optional — old call paths without
   * scope info default to M.
   */
  scope?: "S" | "M" | "L";
  /**
   * Classifier-assigned conventional-commit type (feat/fix/...). Prefixes
   * the branch name (fix/ert-1891-...). Optional — absent means the legacy
   * unprefixed branch format.
   */
  changeType?: string;
}

export interface CodeHandlerResult {
  status: "pr_opened" | "no_changes" | "agent_failed" | "pr_skipped";
  prUrl?: string;
  prNumber?: number;
  branch: string;
  summary: string | null;
}

const KNOWN_CHANGE_TYPES = new Set([
  "feat",
  "fix",
  "refactor",
  "chore",
  "docs",
  "test",
  "perf",
]);

/**
 * Branch name for a ticket: `fix/ert-1891-<slug>` when the classifier
 * supplied a change type, `ERT-1891-<slug>` (legacy) when it didn't.
 * Lowercased identifier in the prefixed form matches Linear's own
 * copy-git-branch-name convention; Linear's PR auto-linking matches the
 * identifier case-insensitively either way. Exported for tests.
 */
export function buildBranchName(
  identifier: string,
  title: string,
  changeType?: string,
): string {
  const slug = slugify(title);
  if (changeType && KNOWN_CHANGE_TYPES.has(changeType)) {
    return `${changeType}/${identifier.toLowerCase()}-${slug}`;
  }
  return `${identifier}-${slug}`;
}

export async function runCodeHandler(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
): Promise<CodeHandlerResult> {
  const [owner, name] = args.repo.split("/") as [string, string];

  const branch = buildBranchName(
    args.issue.identifier,
    args.issue.title,
    args.changeType,
  );
  const worktreePath = resolve(deps.workspacesDir, args.issue.identifier);

  log.info("code handler starting", {
    issue: args.issue.identifier,
    repo: args.repo,
    branch,
    worktreePath,
  });

  const freshUrl = await deps.github.cloneUrl(owner, name);
  const bareDir = await ensureBareClone({
    owner,
    repo: name,
    reposDir: deps.reposDir,
    freshTokenUrl: freshUrl,
  });

  const viewer = await deps.github.getViewer();
  const authorEmail = `${viewer.login}@users.noreply.github.com`;

  await createWorktree({
    bareDir,
    worktreePath,
    branch,
    baseBranch: BASE_BRANCH,
    authorName: viewer.login,
    authorEmail,
  });

  const executor = new LocalExecutor(worktreePath);
  const testCommand = resolveTestGateCommand(worktreePath);
  const system = composeSystemPrompt({ taskInstructions: CODE_TASK_INSTRUCTIONS });
  const projectSection = formatProjectContext(
    loadProjectContext(worktreePath),
    loadSkillIndex(worktreePath),
    loadRuleDocs(worktreePath),
  );
  const ticketMessage = renderTicketForAgent(args.issue, args.comments, {
    worktreePath,
    branch,
  });
  const taskMessage = projectSection
    ? `${projectSection}\n\n---\n\n${ticketMessage}`
    : ticketMessage;

  const loopResult = await runAgentLoop({
    glm: deps.glm,
    executor,
    systemPrompt: system,
    task: taskMessage,
    maxIterations: deps.agentLoopMaxIterations,
    phases: buildCodePhases(args.scope),
    timeoutMs:
      deps.agentLoopTimeoutMs * (args.scope === "L" ? L_TIMEOUT_MULTIPLIER : 1),
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

  const baseRef = BASE_BRANCH;
  const hasCommits = await hasCommitsAhead(worktreePath, baseRef);

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
    testCommand,
  });
  if (!checkPassed) {
    return { status: "agent_failed", branch, summary: loopResult.summary };
  }

  // ===== reviewer pass =====
  const reviewFingerprint = `${args.issue.id}:${Date.now()}`;
  const reviewOutcome = await runReviewLoop(deps, args, {
    executor,
    primaryRunLog: loopResult.runLog,
    fingerprint: reviewFingerprint,
    worktreePath,
    testCommand,
  });
  if (reviewOutcome.kind === "escalated") {
    return { status: "agent_failed", branch, summary: loopResult.summary };
  }
  const verificationReport = reviewOutcome.verificationReport;

  // Rebase onto fresh main so the PR opens on top of latest. Degrades
  // gracefully: conflict → push un-rebased; check fails after rebase →
  // revert and push pre-rebase. Never fails the run.
  const freshUrlForPush = await deps.github.cloneUrl(owner, name);
  const rebase = await rebaseOntoFreshBase({
    bareDir,
    worktreePath,
    freshTokenUrl: freshUrlForPush,
    baseBranch: BASE_BRANCH,
  });
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
      log.warn("check failed after rebase; reverting and pushing pre-rebase", {
        issue: args.issue.identifier,
        branch,
        exitCode: recheck.exitCode,
      });
      await gitMust(["reset", "--hard", rebase.preRebaseSha], {
        cwd: worktreePath,
      });
    } else {
      log.info("rebased onto fresh main", {
        issue: args.issue.identifier,
        branch,
        preRebaseSha: rebase.preRebaseSha,
        postRebaseSha: rebase.postRebaseSha,
      });
    }
  }

  await pushBranch({ worktreePath, freshTokenUrl: freshUrlForPush, branch });

  const diff = await getDiff(worktreePath, baseRef);
  const log_ = await getCommitLog(worktreePath, baseRef);

  const prBody = await composePrBody(deps, {
    issue: args.issue,
    branch,
    summary: loopResult.summary,
    diff,
    commitLog: log_,
    verificationReport,
  });
  const prTitle = await composePrTitle(deps, {
    issue: args.issue,
    summary: loopResult.summary,
    diff,
  });

  // Belt-and-suspenders idempotence: re-check the world right before the
  // PR call. The agent loop can run for a long time; the ticket may have
  // been completed or reassigned meanwhile, or another Gary instance may
  // have already opened an equivalent PR (ERT-1891 got two byte-identical
  // PRs from two daemons two minutes after the ticket went Done).
  const skip = await preflightPrOpen(deps, args, { owner, name });
  if (skip) {
    log.warn("pr-open preflight tripped; not opening PR", {
      issue: args.issue.identifier,
      reason: skip.reason,
      detail: skip.detail,
    });
    recordEvent(deps.db, {
      eventType: "pr_open_skipped",
      ticketLinearId: args.issue.id,
      payload: { reason: skip.reason, detail: skip.detail, branch },
    });
    if (skip.reason === "duplicate_pr" && skip.existingPrUrl) {
      try {
        await deps.linear.postComment(
          args.issue.id,
          `heads up — there's already an open pr covering this: ${skip.existingPrUrl}. i finished my own pass but i'm not opening a duplicate. branch \`${branch}\` is pushed if you want to compare.`,
        );
      } catch (err) {
        log.warn("could not post duplicate-pr comment", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { status: "pr_skipped", branch, summary: loopResult.summary };
  }

  const pr = await deps.github.openPullRequest({
    owner,
    repo: name,
    head: branch,
    base: BASE_BRANCH,
    title: prTitle,
    body: prBody,
    draft: false,
  });

  recordPr(deps.db, {
    githubId: pr.number, // we use number as a stable id within a repo for our purposes
    ticketLinearId: args.issue.id,
    repo: args.repo,
    prNumber: pr.number,
    branch,
  });

  try {
    await deps.linear.addPrAttachment(args.issue.id, pr.url, prTitle);
  } catch (err) {
    // Linear auto-detects [TICKET] references in PR bodies and creates
    // its own attachment via the GitHub integration. If we lose that race
    // we get "Duplicate attachment for duplicate url" — non-fatal; the
    // attachment exists either way.
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate/i.test(message)) throw err;
    log.debug("attachment already exists (Linear auto-detected)", {
      issue: args.issue.identifier,
      pr: pr.url,
    });
  }
  await deps.linear.postComment(
    args.issue.id,
    `pr is up: ${pr.url}\n\n${loopResult.summary ?? ""}`.trim(),
  );

  return {
    status: "pr_opened",
    prUrl: pr.url,
    prNumber: pr.number,
    branch,
    summary: loopResult.summary,
  };
}

interface PreflightSkip {
  reason: "ticket_concluded" | "ticket_reassigned" | "duplicate_pr";
  detail: string;
  existingPrUrl?: string;
}

/**
 * Match an open PR that already covers the ticket, by identifier in the
 * head ref or title. Word-bounded with a trailing digit guard so ERT-1
 * doesn't match ERT-1891. Exported for tests.
 */
export function findExistingPrForTicket(
  prs: readonly OpenPullRequestSummary[],
  identifier: string,
): OpenPullRequestSummary | null {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}(?![0-9])`, "i");
  return (
    prs.find((p) => pattern.test(p.headRef) || pattern.test(p.title)) ?? null
  );
}

/**
 * Pre-open guard. Returns a skip descriptor when the PR should NOT be
 * opened, null when it's safe. Each check fails open — a Linear or GitHub
 * blip must not spike an otherwise-good run; the guard exists to stop the
 * clearly-wrong cases, not to be a hard dependency.
 */
async function preflightPrOpen(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  repo: { owner: string; name: string },
): Promise<PreflightSkip | null> {
  try {
    const status = await deps.linear.fetchIssueStatus(args.issue.id);
    if (status) {
      if (status.stateType === "completed" || status.stateType === "canceled") {
        return {
          reason: "ticket_concluded",
          detail: `${status.stateType} (${status.stateName})`,
        };
      }
      if (status.assigneeId !== deps.linear.linearUserId) {
        return {
          reason: "ticket_reassigned",
          detail: status.assigneeId ?? "unassigned",
        };
      }
    }
  } catch (err) {
    log.warn("pr-open preflight: linear check failed; proceeding", {
      issue: args.issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const open = await deps.github.listOpenPullRequests(repo.owner, repo.name);
    const existing = findExistingPrForTicket(open, args.issue.identifier);
    if (existing) {
      return {
        reason: "duplicate_pr",
        detail: `#${existing.number} by ${existing.authorLogin ?? "?"} (${existing.headRef})`,
        existingPrUrl: existing.url,
      };
    }
  } catch (err) {
    log.warn("pr-open preflight: github check failed; proceeding", {
      issue: args.issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
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

const PR_SIGNATURE_PREFIX = "🤖 Generated by";

/**
 * Post-process the model's PR body. The prompt says the signature line is
 * last, but models occasionally trail garbage after it (#512 ended with a
 * stray "EOF\n)") or wrap the whole body in a markdown fence. The signature
 * line is the contract: everything after it is dropped. Exported for tests.
 */
export function sanitizePrBody(raw: string): string {
  let body = raw.trim();
  const fenced = body.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  if (fenced?.[1]) body = fenced[1].trim();
  const sigAt = body.indexOf(PR_SIGNATURE_PREFIX);
  if (sigAt >= 0) {
    const lineEnd = body.indexOf("\n", sigAt);
    if (lineEnd !== -1) body = body.slice(0, lineEnd);
  }
  return body.trim();
}

interface ComposePrBodyArgs {
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
  // 2048 leaves room for K3's thinking block ahead of the body text.
  const raw = await deps.glm.complete({
    system,
    user,
    temperature: 0.4,
    maxTokens: 2048,
  });
  return sanitizePrBody(raw);
}

interface ComposePrTitleArgs {
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
  // 1024 max_tokens for a one-line title because K3 (the main-work
  // primary) emits a thinking block first; a tight budget can get fully
  // consumed by reasoning, returning zero text blocks.
  const raw = await deps.glm.complete({
    system,
    user,
    temperature: 0.2,
    maxTokens: 1024,
  });
  const firstLine = raw.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : args.issue.title;
}

interface FixupContext {
  executor: LocalExecutor;
  system: string;
  /** Test command for the gate, or null when the repo has none. */
  testCommand: string | null;
}

interface GateFailure {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Run gate commands in order; return the first failure, or null if all pass. */
async function firstFailingGate(
  executor: LocalExecutor,
  commands: readonly string[],
): Promise<GateFailure | null> {
  for (const command of commands) {
    const r = await executor.run(command, { timeoutMs: CHECK_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      return {
        command,
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
      };
    }
  }
  return null;
}

/**
 * Run the post-finish gate: `bun run check`, then the repo's test command
 * (see resolveTestGateCommand). If a gate fails, feed the failure back to
 * the agent for one fix-up cycle and re-run every gate. Returns true if
 * the gates are clean (either on the first pass or after fix-up); false
 * if we couldn't recover, in which case the ticket is already escalated.
 */
async function ensurePostFinishCheckPasses(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  ctx: FixupContext,
): Promise<boolean> {
  const gates = ctx.testCommand
    ? [CHECK_COMMAND, ctx.testCommand]
    : [CHECK_COMMAND];
  const first = await firstFailingGate(ctx.executor, gates);
  if (!first) return true;

  log.warn("post-finish gate failed; running fix-up", {
    issue: args.issue.identifier,
    command: first.command,
    exitCode: first.exitCode,
    timedOut: first.timedOut,
  });

  const fixupTask = renderCheckFixupTask(first);
  const fixupResult = await runAgentLoop({
    glm: deps.glm,
    executor: ctx.executor,
    systemPrompt: ctx.system,
    task: fixupTask,
    maxIterations: FIXUP_MAX_ITERATIONS,
    timeoutMs: deps.agentLoopTimeoutMs,
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

  const second = await firstFailingGate(ctx.executor, gates);
  if (!second) return true;

  log.warn("gate still failing after fix-up; escalating", {
    issue: args.issue.identifier,
    command: second.command,
  });
  await postCheckFailureEscalation(deps, args, second);
  return false;
}

function renderCheckFixupTask(failed: GateFailure): string {
  const combined = `${failed.stdout}\n${failed.stderr}`.trim();
  const truncated =
    combined.length > FIXUP_OUTPUT_BUDGET
      ? `${combined.slice(0, FIXUP_OUTPUT_BUDGET)}\n... (truncated)`
      : combined;
  return `${checkFixupInstructions(failed.command)}\n\nMost recent \`${failed.command}\` output:\n\n\`\`\`\n${truncated}\n\`\`\``;
}

async function postCheckFailureEscalation(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  failed: GateFailure,
): Promise<void> {
  const tail = `${failed.stdout}\n${failed.stderr}`
    .trim()
    .split("\n")
    .slice(-25)
    .join("\n");
  const body = [
    `i thought i was done but \`${failed.command}\` is still failing after a fix-up pass. bouncing — i'd want a human to look before i try again.`,
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
  // Hand-off hygiene: an In Progress ticket nobody's working on is a lie.
  try {
    await deps.linear.setStateByType(args.issue.id, args.issue.teamId, "unstarted");
  } catch (err) {
    log.warn("could not move ticket back to todo on hand-off", {
      issue: args.issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
): Promise<void> {
  const messages: Record<string, string> = {
    iteration_cap:
      "i hit the iteration cap on this one before getting to a clean stopping point. bouncing it back so a human can take a look.",
    timeout:
      "i ran out of time on this one. bouncing it back — happy to take another swing if someone can point me at the right approach.",
    no_finish:
      "the model returned without calling finish, which usually means it lost the thread. bouncing — i'd want a human to look before i try again.",
    error:
      "ran into an error i couldn't recover from. bouncing back to you.",
  };
  const body =
    messages[reason] ?? `something went wrong (${reason}). bouncing back.`;
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
  executor: LocalExecutor;
  primaryRunLog: readonly RunLogEntry[];
  fingerprint: string;
  worktreePath: string;
  /** Test command for the post-fixup gate, or null when the repo has none. */
  testCommand: string | null;
}

type ReviewLoopOutcome =
  | { kind: "approved"; verificationReport: string }
  | { kind: "escalated" };

async function runReviewLoop(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  ctx: ReviewLoopCtx,
): Promise<ReviewLoopOutcome> {
  let round = 0;
  let previousFindings: readonly { title: string; detail: string; bugClass: string }[] = [];
  let lastRunLog = ctx.primaryRunLog;
  const ruleDocs = loadRuleDocs(ctx.worktreePath);

  while (round < deps.review.maxRounds) {
    round++;
    const diff = await getDiff(ctx.worktreePath, BASE_BRANCH);
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

    // Rebuild the reviewer chain each round with the author's providers
    // sunk to the back — fixup rounds can pull in additional providers, so
    // the decorrelation set grows as the loop iterates. Soft preference:
    // if rate-limit arming leaves only an author provider available, the
    // review still runs on it (logged for calibration).
    const authorProviders = deps.glm.providersUsed();
    const reviewerGlm = new GLMClient(
      chainWithOrder(
        deps.glm.chain,
        decorrelatedOrder(deps.review.providerOrder, authorProviders),
      ),
    );
    const reviewerProvider = reviewerGlm.chain.active()?.name ?? null;
    if (reviewerProvider !== null && authorProviders.includes(reviewerProvider)) {
      log.warn("reviewer decorrelation unavailable; reviewing with author's provider", {
        issue: args.issue.identifier,
        round,
        provider: reviewerProvider,
      });
      recordEvent(deps.db, {
        eventType: "review_correlated_provider",
        ticketLinearId: args.issue.id,
        payload: { round, provider: reviewerProvider },
      });
    }

    let outcome: ReviewerResult = await runReviewer({
      db: deps.db,
      glm: reviewerGlm,
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
      ruleDocs,
      iterationCap: deps.review.iterationCap,
      timeoutMs: deps.review.timeoutMs,
    });

    if (outcome.kind === "failed") {
      log.warn("reviewer pass failed; retrying once", {
        issue: args.issue.identifier,
        round,
        reason: outcome.reason,
      });
      outcome = await runReviewer({
        db: deps.db,
        glm: reviewerGlm,
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
        ruleDocs,
        iterationCap: deps.review.iterationCap,
        timeoutMs: deps.review.timeoutMs,
      });
      if (outcome.kind === "failed") {
        recordEvent(deps.db, {
          eventType: "review_failed",
          ticketLinearId: args.issue.id,
          payload: { round, reason: outcome.reason },
        });
        log.warn("reviewer failed twice; default-approving", {
          issue: args.issue.identifier,
          round,
        });
        return {
          kind: "approved",
          verificationReport: "_reviewer pass unavailable for this PR_",
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
        author_providers: authorProviders.join(","),
        reviewer_provider: reviewerGlm.lastProviderUsed(),
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
    const fixup = await runAgentLoop({
      glm: deps.glm,
      executor: ctx.executor,
      systemPrompt: primarySystem,
      task: fixupTask,
      maxIterations: FIXUP_MAX_ITERATIONS,
      timeoutMs: deps.agentLoopTimeoutMs,
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
    lastRunLog = fixup.runLog;
    previousFindings = outcome.review.findings.map((f) => ({
      title: f.title,
      detail: f.detail,
      bugClass: f.bugClass,
    }));
    const checkOk = await ensurePostFinishCheckPasses(deps, args, {
      executor: ctx.executor,
      system: primarySystem,
      testCommand: ctx.testCommand,
    });
    if (!checkOk) return { kind: "escalated" };
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
