import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type { GitHubClient } from "../adapters/github.ts";
import type { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, IssueComment, LinearAdapter } from "../adapters/linear.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import { LocalExecutor } from "../executors/local.ts";
import {
  createWorktree,
  ensureBareClone,
} from "../git.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.ts";
import {
  formatProjectContext,
  loadProjectContext,
  loadSkillIndex,
} from "../skills.ts";

const ANSWER_TASK_INSTRUCTIONS = `Someone asked a question on this Linear ticket. The classifier already posted an initial reply at triage. Your job here is to take a deeper look at the code and either confirm the initial answer or post a clarifying follow-up.

Rules:
- READ ONLY on the codebase. Do not write, edit, or commit. Do not run commands that modify state. You may run grep, find, ls, cat, git log, etc.
- Use list_files, grep, and read_file to investigate. run_bash is fine for read-only commands like \`git log\` or \`cat\`.
- Output your follow-up via finish() — pass the comment body as the summary. Voice example 3 from voice.md is the model.
- If the initial classifier reply was complete and accurate, finish() with a brief "still stands, looked at <file>:<line>" rather than re-explaining everything.
- If the classifier got it wrong, say so plainly and explain what you actually found.

Linear admin actions:
- If the human asks you to unassign yourself, change ticket status, or update the description, you have tools for those: \`unassign_self\`, \`set_ticket_state\` (e.g. type "backlog"), \`update_ticket_description\` (full replace — read current via \`get_linear_issue\` first if you need to preserve content). Call them, then mention what you did in your finish() comment.
- NEVER claim you performed an admin action without actually calling the tool. If a request is outside your tool capabilities, say so plainly in your finish() comment instead of fabricating compliance.`;

export interface AnswerHandlerDeps {
  linear: LinearAdapter;
  github: GitHubClient;
  glm: GLMClient;
  cloudflare: CloudflareClient | null;
  reposDir: string;
  workspacesDir: string;
  agentLoopMaxIterations: number;
  agentLoopTimeoutMs: number;
}

export interface AnswerHandlerArgs {
  issue: AssignedIssue;
  comments: readonly IssueComment[];
  repo: string;
}

export async function runAnswerHandler(
  deps: AnswerHandlerDeps,
  args: AnswerHandlerArgs,
): Promise<{ status: "answered" | "skipped"; followup: string | null }> {
  const [owner, name] = args.repo.split("/") as [string, string];

  // Set up a read-only worktree. We pass the worktree to the agent loop;
  // the agent's prompt forbids writes/commits. The Executor itself can't
  // strictly enforce read-only without a separate `ReadOnlyExecutor` wrapper —
  // call this out as a Weekend 2 hardening item.
  const worktreePath = resolve(deps.workspacesDir, `${args.issue.identifier}-answer`);
  const viewer = await deps.github.getViewer();
  const authorEmail = `${viewer.login}@users.noreply.github.com`;
  const branch = `${args.issue.identifier}-answer-readonly`;

  if (!existsSync(worktreePath)) {
    const freshUrl = await deps.github.cloneUrl(owner, name);
    const bareDir = await ensureBareClone({
      owner,
      repo: name,
      reposDir: deps.reposDir,
      freshTokenUrl: freshUrl,
    });
    await createWorktree({
      bareDir,
      worktreePath,
      branch,
      baseBranch: "main",
      authorName: viewer.login,
      authorEmail,
    });
  }

  const executor = new LocalExecutor(worktreePath);
  const system = composeSystemPrompt({ taskInstructions: ANSWER_TASK_INSTRUCTIONS });
  const projectSection = formatProjectContext(
    loadProjectContext(worktreePath),
    loadSkillIndex(worktreePath),
  );
  const question = renderQuestion(
    args.issue,
    args.comments,
    deps.linear.linearUserId,
  );
  const task = projectSection
    ? `${projectSection}\n\n---\n\n${question}`
    : question;

  const loopResult = await runAgentLoop({
    glm: deps.glm,
    executor,
    systemPrompt: system,
    task,
    maxIterations: Math.min(deps.agentLoopMaxIterations, 20),
    timeoutMs: Math.min(deps.agentLoopTimeoutMs, 5 * 60_000),
    temperature: 0.3,
    linear: deps.linear,
    currentIssue: {
      id: args.issue.id,
      identifier: args.issue.identifier,
      teamId: args.issue.teamId,
    },
    github: deps.github,
    defaultRepo: args.repo,
    ...(deps.cloudflare ? { cloudflare: deps.cloudflare } : {}),
  });

  log.info("answer agent loop done", {
    issue: args.issue.identifier,
    status: loopResult.status,
  });

  if (loopResult.status !== "finished" || !loopResult.summary) {
    return { status: "skipped", followup: null };
  }

  await deps.linear.postComment(args.issue.id, loopResult.summary);
  return { status: "answered", followup: loopResult.summary };
}

/**
 * Build the prompt body for the answer agent. Renders the description and
 * the chronological comment thread, then surfaces the *latest non-Gary
 * comment* as an explicit "current question" so the agent focuses on what's
 * actually being asked rather than re-answering the original.
 *
 * Exported so tests can pin the structure directly.
 */
export function renderQuestion(
  issue: AssignedIssue,
  comments: readonly IssueComment[],
  garyUserId: string,
): string {
  const sections: string[] = [];
  sections.push(`Ticket: ${issue.identifier} — ${issue.title}`);
  sections.push("");
  sections.push("Description:");
  sections.push(issue.description ?? "(no description)");

  const sorted = [...comments].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  if (sorted.length > 0) {
    sections.push("");
    sections.push(`Comments (${sorted.length}, oldest first):`);
    for (const c of sorted) {
      sections.push(`  ${c.userName ?? "?"} (${c.createdAt}): ${c.body}`);
    }
  }

  // Find the latest non-Gary comment — that's the actual question to focus on.
  // If the most recent input is a follow-up, this prevents the agent from
  // re-explaining the original answer.
  const latestHuman = [...sorted]
    .reverse()
    .find((c) => c.userId !== garyUserId);
  if (latestHuman) {
    sections.push("");
    sections.push(
      `Latest from ${latestHuman.userName ?? "?"} (${latestHuman.createdAt}) — focus your reply on this:`,
    );
    sections.push(latestHuman.body);
  }

  sections.push("");
  sections.push(
    "Investigate the code as needed (read-only) and call finish() with your follow-up comment as the summary.",
  );
  return sections.join("\n");
}
