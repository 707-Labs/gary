import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type {
  GitHubClient,
  PullRequestComment,
  PullRequestDetail,
} from "../adapters/github.ts";
import type { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, LinearAdapter } from "../adapters/linear.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import { createWorkspaceExecutor } from "../executors/factory.ts";
import {
  createWorktree,
  ensureBareClone,
  pushBranch,
} from "../git.ts";
import { log } from "../logger.ts";
import {
  formatProjectContext,
  loadProjectContext,
  loadSkillIndex,
} from "../skills.ts";
import type { DB } from "../state/db.ts";
import { markPrCommentsResponded } from "../state/queries.ts";

const PR_REVIEW_TASK_INSTRUCTIONS = `A reviewer has left comments on your open PR. Your job: read the comments, decide whether each is a question/discussion or a concrete change request, then respond.

Cover every item — when a single review body raises multiple distinct asks (numbered list, multiple paragraphs, "and another thing"), treat each as a separate item with its own disposition. Don't silently drop the vague ones.

For each item, the disposition is exactly one of:
- ADDRESS NOW: concrete enough to implement, you're confident it's right, change is small.
- DEFER: legitimate but out of scope or larger than this PR. Acknowledge it explicitly and propose filing a follow-up ticket.
- ASK: too vague to action without guessing. Quote the specific phrase and ask what good looks like (e.g. "you mentioned caching — should that live in the worker, the D1 layer, or the SvelteKit load? what's the staleness budget?"). Don't pick the lowest-hanging interpretation and silently move on.

Default posture is REPLY-ONLY:
- Read the comment in context (use get_pr to see the PR + diff, read_file to inspect referenced code).
- If it's a question, a discussion, or an ambiguous suggestion, write a reply explaining your thinking. No code changes.
- Voice example 3 in voice.md is the right tone — short, plain, no marketing.

PUSH a fix only when ALL of these hold:
- The reviewer's request is concrete and pointed (e.g. "this should use X instead of Y", "extract this into a helper", "this throws on null").
- You can implement it locally and the change is small (a few lines, one or two files).
- You're confident the request is right; you're not just deferring to authority.

If you push:
- Make the smallest change that addresses the comment.
- Run typecheck/tests locally before committing.
- Commit with a message that references the comment ("address review: <short>").
- Your finish() summary should be a brief PR comment that points to the new commit and notes what you did. Don't restate the diff — the commit message has it.

If you reply without pushing:
- Your finish() summary IS the reply that gets posted on the PR. Address the reviewer by name. Be specific about what you considered and why.
- If the reply covers multiple items, structure it so each one is identifiable — the reviewer should be able to scan and confirm nothing was dropped.

If you can't decide, REPLY asking for clarification. Don't push speculative fixes.`;

export interface PrReviewHandlerDeps {
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

export interface PrReviewHandlerArgs {
  issue: AssignedIssue;
  repo: string;
  prGithubId: number;
  prNumber: number;
  branch: string;
}

export interface PrReviewHandlerResult {
  status: "replied" | "pushed_and_replied" | "skipped";
  pendingCommentCount: number;
  summary: string | null;
}

export async function runPrReviewHandler(
  deps: PrReviewHandlerDeps,
  args: PrReviewHandlerArgs,
): Promise<PrReviewHandlerResult> {
  const [owner, name] = args.repo.split("/") as [string, string];
  const viewer = await deps.github.getViewer();
  const garyLogin = viewer.login;

  // Re-fetch comments at handler time. The loop's signature is best-effort —
  // it's possible a new comment landed between candidate selection and now.
  // Filter to human authors only — Gary, linear[bot] linkbacks, and other
  // automation aren't review feedback he should respond to.
  const allComments = await deps.github.getPullRequestComments(
    owner,
    name,
    args.prNumber,
  );
  const pending = allComments.filter((c) => c.authorType === "User");
  if (pending.length === 0) {
    log.info("pr-review: nothing pending after handler-time fetch", {
      issue: args.issue.identifier,
      pr: args.prNumber,
    });
    return { status: "skipped", pendingCommentCount: 0, summary: null };
  }

  // Recreate worktree if missing.
  const worktreePath = resolve(deps.workspacesDir, args.issue.identifier);
  const authorEmail = `${garyLogin}@users.noreply.github.com`;
  if (!existsSync(worktreePath)) {
    log.info("worktree missing for pr-review; recreating", {
      worktreePath,
      branch: args.branch,
    });
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
      branch: args.branch,
      baseBranch: args.branch,
      authorName: garyLogin,
      authorEmail,
    });
  }

  const headBefore = await readHead(worktreePath);

  const executor = createWorkspaceExecutor(worktreePath);
  const system = composeSystemPrompt({ taskInstructions: PR_REVIEW_TASK_INSTRUCTIONS });
  const projectSection = formatProjectContext(
    loadProjectContext(worktreePath),
    loadSkillIndex(worktreePath),
  );

  let prDetail: PullRequestDetail | null = null;
  try {
    prDetail = await deps.github.getPullRequestDetail(owner, name, args.prNumber);
  } catch (err) {
    log.warn("could not fetch PR detail for review prompt", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const reviewMessage = renderReviewForAgent(args, prDetail, pending);
  const taskMessage = projectSection
    ? `${projectSection}\n\n---\n\n${reviewMessage}`
    : reviewMessage;

  const loopResult = await runAgentLoop({
    glm: deps.glm,
    executor,
    systemPrompt: system,
    task: taskMessage,
    maxIterations: deps.agentLoopMaxIterations,
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
    ...(deps.cloudflare ? { cloudflare: deps.cloudflare } : {}),
  });

  log.info("pr-review agent loop done", {
    issue: args.issue.identifier,
    pr: args.prNumber,
    status: loopResult.status,
    iterations: loopResult.iterations,
  });

  if (loopResult.status !== "finished" || !loopResult.summary) {
    // Throw so the loop records success=false; otherwise the action cache
    // pins this fingerprint as done and Gary never retries the same pending
    // comments. The retry happens on the next tick because hasActedOn filters
    // on success=1.
    throw new Error(
      `pr-review agent did not finish (status=${loopResult.status}, summary=${loopResult.summary ? "present" : "empty"})`,
    );
  }

  const headAfter = await readHead(worktreePath);
  const pushed = headBefore !== null && headAfter !== null && headAfter !== headBefore;

  if (pushed) {
    const freshUrl = await deps.github.cloneUrl(owner, name);
    await pushBranch({
      worktreePath,
      freshTokenUrl: freshUrl,
      branch: args.branch,
    });
  }

  // Always post the agent's reply on the PR.
  try {
    await deps.github.comment(owner, name, args.prNumber, loopResult.summary);
  } catch (err) {
    log.warn("could not post pr-review comment", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Mark every pending comment as responded so the next tick's signature
  // returns "empty" and we don't re-react to the same thread.
  markPrCommentsResponded(
    deps.db,
    args.prGithubId,
    pending.map((c) => c.id),
  );

  return {
    status: pushed ? "pushed_and_replied" : "replied",
    pendingCommentCount: pending.length,
    summary: loopResult.summary,
  };
}

function renderReviewForAgent(
  args: PrReviewHandlerArgs,
  pr: PullRequestDetail | null,
  pending: readonly PullRequestComment[],
): string {
  const sections: string[] = [];
  sections.push(`Repo: ${args.repo}`);
  sections.push(`PR: #${args.prNumber} (branch ${args.branch})`);
  if (pr) {
    sections.push(`Title: ${pr.title}`);
    if (pr.body) {
      sections.push("PR body:");
      sections.push(indent(truncate(pr.body, 1500), 2));
    }
  }
  sections.push("");
  sections.push(`Pending review comments (${pending.length}, oldest first):`);
  for (const c of pending) {
    sections.push("");
    const anchor =
      c.kind === "review" && c.path
        ? `${c.kind} on ${c.path}${c.line != null ? `:${c.line}` : ""}`
        : c.kind;
    sections.push(`  --- ${c.authorLogin ?? "?"} (${c.createdAt}, ${anchor}) ---`);
    sections.push(indent(truncate(c.body, 2000), 4));
    sections.push(`  ${c.htmlUrl}`);
  }
  sections.push("");
  sections.push(
    "Decide reply-only or push-and-reply per the rules above. Always finish() with the message you want posted on the PR.",
  );
  return sections.join("\n");
}

function indent(s: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n... (truncated)`;
}

async function readHead(worktreePath: string): Promise<string | null> {
  const { gitRun } = await import("../git.ts");
  const r = await gitRun(["rev-parse", "HEAD"], { cwd: worktreePath });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim();
}
