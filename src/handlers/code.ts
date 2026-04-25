import { resolve } from "node:path";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type { GitHubClient } from "../adapters/github.ts";
import type { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, IssueComment, LinearAdapter } from "../adapters/linear.ts";
import { type PhaseSpec, runAgentLoop } from "../agent/loop.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import {
  createWorktree,
  ensureBareClone,
  getCommitLog,
  getDiff,
  hasCommitsAhead,
  pushBranch,
  slugify,
} from "../git.ts";
import { LocalExecutor } from "../executors/local.ts";
import { log } from "../logger.ts";
import {
  formatProjectContext,
  loadProjectContext,
  loadSkillIndex,
} from "../skills.ts";
import type { DB } from "../state/db.ts";
import { recordPr, setTerminalState } from "../state/queries.ts";

const BASE_BRANCH = "main";
const CHECK_COMMAND = "bun run check";
const CHECK_TIMEOUT_MS = 10 * 60_000;
const FIXUP_MAX_ITERATIONS = 15;
const FIXUP_OUTPUT_BUDGET = 8000;

// Read-only tools advertised in the investigate phase. Anything that
// mutates the workspace (write_file, edit_file, run_bash, commit) or ends
// the loop (finish) is hidden until the model transitions to implement.
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
        "good — you've explored. now: (1) write a 3-5 bullet plan of the changes you'll make, (2) implement them with write_file/edit_file/run_bash and commit your work, (3) run `bun run check` and fix anything you broke, (4) call finish() with a 1-2 sentence summary. if at any point you realize the change is bigger than expected or you're stuck, call finish() with a brief partial-progress note and a human will pick it up.",
      nudgeMessage:
        "you're approaching the iteration cap. wrap up: commit what you have, then call finish() with a brief summary (or a partial-progress note if you're stuck). a partial-progress finish is much better than running out of iterations mid-stream.",
    },
  ];
}

const CHECK_FIXUP_TASK_INSTRUCTIONS = `Your previous turn ended with finish() but \`${CHECK_COMMAND}\` is failing. Fix the errors caused by your changes, commit, then call finish() again.

Rules:
- Run \`${CHECK_COMMAND}\` and confirm it exits 0 BEFORE calling finish.
- Only fix what's broken — don't refactor unrelated code.
- If the failure is in code you didn't touch, investigate before assuming it's pre-existing. The pre-push hook runs the same command, so anything failing here will block your push.
- Commit your fix-up changes before calling finish.
- If you can't make the check pass after a few iterations, call finish() with a one-sentence summary of what's still broken so a human can take over.`;

const CODE_TASK_INSTRUCTIONS = `You are working on a Linear ticket for 707 Labs. Make the smallest change that solves the ticket and stop.

You can use tools to read, edit, run bash commands, and commit. When you're done, call finish() with a one-sentence summary.

Rules:
- Read before you write. Look at the existing code, the project's conventions (CLAUDE.md, AGENTS.md, .claude/skills/), and any related files before changing anything.
- Make the smallest change that solves the ticket. Don't refactor unrelated code.
- BEFORE calling finish, run \`bun run check\` (the project's typecheck/svelte-check command). If there are errors caused by your changes, fix them and re-run. The repo has a pre-push hook that runs the same command — your push will be rejected if it fails.
- Run other tests if there's an obvious command for the area you touched (look at package.json scripts and tests in the changed file's directory). If tests fail, try to fix them.
- If the ticket is ambiguous, make a reasonable choice and note it in finish()'s summary.
- If you realize the ticket is bigger than you can handle, call finish() with a summary explaining what you got done and what's left. Escalation will happen automatically.
- Don't install new dependencies unless the ticket clearly requires it.
- Commit your changes before calling finish.`;

export const PR_BODY_TASK_INSTRUCTIONS = `Write a PR title and body for the changes you just made. Use voice.md examples 5 (small, confident) and 6 (medium, with uncertainty) as your structural template — match that exact format. Pick the level of detail based on the size and certainty of this change.

Output ONLY the PR body markdown. Do not output the title — the title is generated separately. Do not output any preamble like "Here is the PR body".

Required sections, in order:
1. \`## Summary\` — 1-3 short paragraphs and/or bullets explaining what changed and why. Lead with the most important change.
2. \`## Things i'm less sure about\` — only if there's genuine uncertainty. Skip the section entirely if the change is small and confident.
3. \`## Test plan\` — markdown checklist. Each line is \`- [x] <command>\` for things you ran, \`- [ ] <thing>\` for things still to verify (always include \`- [ ] CI green\`). At minimum include the typecheck command you ran (\`bun run check\` or equivalent).
4. \`## Follow-ups\` — only if there are genuine related tasks not in scope here.
5. A blank line, then \`closes [<TICKET-ID>]\` (uppercase).
6. A blank line, then a parenthetical "(i'm gary — ai agent. <specific things to double-check>.)" line.
7. A blank line, then the signature: \`🤖 Generated by [gary-707-labs](https://github.com/apps/gary-707-labs)\`

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
}

export interface CodeHandlerResult {
  status: "pr_opened" | "no_changes" | "agent_failed";
  prUrl?: string;
  prNumber?: number;
  branch: string;
  summary: string | null;
}

export async function runCodeHandler(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
): Promise<CodeHandlerResult> {
  const [owner, name] = args.repo.split("/") as [string, string];

  const branch = `${args.issue.identifier}-${slugify(args.issue.title)}`;
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

  const loopResult = await runAgentLoop({
    glm: deps.glm,
    executor,
    systemPrompt: system,
    task: taskMessage,
    maxIterations: deps.agentLoopMaxIterations,
    phases: buildCodePhases(args.scope),
    timeoutMs: deps.agentLoopTimeoutMs,
    temperature: 0.3,
    linear: deps.linear,
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
  });
  if (!checkPassed) {
    return { status: "agent_failed", branch, summary: loopResult.summary };
  }

  // Open the PR.
  const freshUrlForPush = await deps.github.cloneUrl(owner, name);
  await pushBranch({ worktreePath, freshTokenUrl: freshUrlForPush, branch });

  const diff = await getDiff(worktreePath, baseRef);
  const log_ = await getCommitLog(worktreePath, baseRef);

  const prBody = await composePrBody(deps, {
    issue: args.issue,
    branch,
    summary: loopResult.summary,
    diff,
    commitLog: log_,
  });
  const prTitle = await composePrTitle(deps, {
    issue: args.issue,
    summary: loopResult.summary,
    diff,
  });

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

interface ComposePrBodyArgs {
  issue: AssignedIssue;
  branch: string;
  summary: string | null;
  diff: string;
  commitLog: string;
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
  ].join("\n");
  return await deps.glm.complete({
    system,
    user,
    temperature: 0.4,
    maxTokens: 1024,
  });
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
  const raw = await deps.glm.complete({
    system,
    user,
    temperature: 0.2,
    maxTokens: 128,
  });
  return raw.trim().split("\n")[0]?.trim() ?? args.issue.title;
}

interface FixupContext {
  executor: LocalExecutor;
  system: string;
}

/**
 * Run `bun run check`. If it fails, feed the failure back to the agent for
 * one fix-up cycle and re-check. Returns true if the check is clean (either
 * on the first pass or after fix-up); false if we couldn't recover, in
 * which case the ticket is already escalated.
 */
async function ensurePostFinishCheckPasses(
  deps: CodeHandlerDeps,
  args: CodeHandlerArgs,
  ctx: FixupContext,
): Promise<boolean> {
  const first = await ctx.executor.run(CHECK_COMMAND, {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (first.exitCode === 0) return true;

  log.warn("post-finish check failed; running fix-up", {
    issue: args.issue.identifier,
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

  const second = await ctx.executor.run(CHECK_COMMAND, {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (second.exitCode === 0) return true;

  log.warn("check still failing after fix-up; escalating", {
    issue: args.issue.identifier,
  });
  await postCheckFailureEscalation(deps, args, second);
  return false;
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
