import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type { CheckRunDetail, GitHubClient } from "../adapters/github.ts";
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
import { countCiAttemptsSince, setTerminalState } from "../state/queries.ts";

const CI_FIX_TASK_INSTRUCTIONS = `Your PR's CI is failing. Read the failing check output below, figure out the cause, fix it locally, commit, and call finish.

Rules:
- Read before you write. Look at the failing test or build output and the code it points at.
- Make the smallest fix that addresses the failure. Don't refactor unrelated code.
- If the test itself looks wrong (testing behavior your change broke for legitimate reasons), say so in finish() instead of "fixing" the test to match — voice.md example 12 covers this.
- If you can't figure out why CI is failing, call finish() with a summary explaining what you tried. Escalation will happen automatically.
- Run the relevant test or build command locally before committing to confirm your fix.
- Commit your changes before calling finish.`;

export interface CiFailureHandlerDeps {
  db: DB;
  linear: LinearAdapter;
  github: GitHubClient;
  glm: GLMClient;
  cloudflare: CloudflareClient | null;
  reposDir: string;
  workspacesDir: string;
  agentLoopMaxIterations: number;
  agentLoopTimeoutMs: number;
  maxCiAttempts: number;
}

export interface CiFailureHandlerArgs {
  issue: AssignedIssue;
  repo: string;
  prNumber: number;
  branch: string;
  headSha: string;
}

export interface CiFailureHandlerResult {
  status: "fix_pushed" | "no_changes" | "agent_failed" | "max_attempts";
  attempts: number;
  summary: string | null;
}

export async function runCiFailureHandler(
  deps: CiFailureHandlerDeps,
  args: CiFailureHandlerArgs,
): Promise<CiFailureHandlerResult> {
  // Count prior fix attempts on this PR within the rolling window.
  const attemptsSoFar = countCiAttemptsSince(deps.db, {
    ticketLinearId: args.issue.id,
    sinceHoursAgo: 24,
  });

  if (attemptsSoFar >= deps.maxCiAttempts) {
    log.warn("max ci attempts reached", {
      issue: args.issue.identifier,
      attempts: attemptsSoFar,
    });
    await escalate(deps, args, attemptsSoFar);
    return { status: "max_attempts", attempts: attemptsSoFar, summary: null };
  }

  const [owner, name] = args.repo.split("/") as [string, string];
  const failingChecks = await deps.github.getFailingCheckDetails(
    owner,
    name,
    args.headSha,
  );

  if (failingChecks.length === 0) {
    log.info("no failing checks found at head; skipping", {
      issue: args.issue.identifier,
      headSha: args.headSha,
    });
    return { status: "no_changes", attempts: attemptsSoFar, summary: null };
  }

  // Re-create worktree if missing (process restart, machine reboot, etc.)
  const worktreePath = resolve(deps.workspacesDir, args.issue.identifier);
  const viewer = await deps.github.getViewer();
  const authorEmail = `${viewer.login}@users.noreply.github.com`;

  if (!existsSync(worktreePath)) {
    log.info("worktree missing, recreating from bare clone", {
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
      baseBranch: args.branch, // start from the existing branch tip
      authorName: viewer.login,
      authorEmail,
    });
  }

  const executor = createWorkspaceExecutor(worktreePath);
  const system = composeSystemPrompt({ taskInstructions: CI_FIX_TASK_INSTRUCTIONS });
  const projectSection = formatProjectContext(
    loadProjectContext(worktreePath),
    loadSkillIndex(worktreePath),
  );
  const failureMessage = renderCiFailureForAgent(args, failingChecks);
  const taskMessage = projectSection
    ? `${projectSection}\n\n---\n\n${failureMessage}`
    : failureMessage;

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

  log.info("ci fix agent loop done", {
    issue: args.issue.identifier,
    status: loopResult.status,
    iterations: loopResult.iterations,
  });

  // We need to check whether the LATEST commit is past args.headSha — but
  // `hasCommitsAhead` against base only tells us there are PR commits at
  // all (which there will be even if the agent did nothing). Better: check
  // whether HEAD moved past the failing SHA.
  const movedPast = await headIsPast(worktreePath, args.headSha);

  if (loopResult.status !== "finished" || !movedPast) {
    if (!movedPast) {
      log.warn("ci fix produced no new commits past failing SHA", {
        issue: args.issue.identifier,
        previousHead: args.headSha,
      });
    }
    if (loopResult.status !== "finished") {
      // agent timed out or hit the cap — let the next tick decide if we're
      // at MAX_CI_ATTEMPTS yet.
    }
    return {
      status: "agent_failed",
      attempts: attemptsSoFar + 1,
      summary: loopResult.summary,
    };
  }

  // Push the fix.
  const freshUrl = await deps.github.cloneUrl(owner, name);
  await pushBranch({
    worktreePath,
    freshTokenUrl: freshUrl,
    branch: args.branch,
  });

  return {
    status: "fix_pushed",
    attempts: attemptsSoFar + 1,
    summary: loopResult.summary,
  };
}

function renderCiFailureForAgent(
  args: CiFailureHandlerArgs,
  failures: readonly CheckRunDetail[],
): string {
  const sections: string[] = [];
  sections.push(`Repo: ${args.repo}`);
  sections.push(`PR: #${args.prNumber}`);
  sections.push(`Branch: ${args.branch}`);
  sections.push(`Failing head SHA: ${args.headSha}`);
  sections.push("");
  sections.push(`Failing checks (${failures.length}):`);
  for (const f of failures) {
    sections.push("");
    sections.push(`  --- ${f.name} (${f.conclusion}) ---`);
    if (f.outputTitle) sections.push(`  title: ${f.outputTitle}`);
    if (f.outputSummary) {
      sections.push(`  summary:\n${indent(f.outputSummary, 4)}`);
    }
    if (f.outputText) {
      const truncated =
        f.outputText.length > 4000
          ? f.outputText.slice(0, 4000) + "\n... (truncated)"
          : f.outputText;
      sections.push(`  output:\n${indent(truncated, 4)}`);
    }
    sections.push(`  details: ${f.htmlUrl || f.detailsUrl}`);
  }
  sections.push("");
  sections.push(
    "Fix the failure(s), commit, then call finish(). If you can't, call finish() with what you tried.",
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

async function headIsPast(
  worktreePath: string,
  failingSha: string,
): Promise<boolean> {
  // We use a simple heuristic: HEAD commit is different from the failing SHA.
  // (Could be more rigorous with `git merge-base --is-ancestor`, but the
  // failing SHA should always be an ancestor of any new commit on the branch.)
  const { gitRun } = await import("../git.ts");
  const r = await gitRun(["rev-parse", "HEAD"], { cwd: worktreePath });
  if (r.exitCode !== 0) return false;
  const head = r.stdout.trim();
  return head !== failingSha;
}

async function escalate(
  deps: CiFailureHandlerDeps,
  args: CiFailureHandlerArgs,
  attempts: number,
): Promise<void> {
  const body = `reassigning this back — ci has failed ${attempts} times and i'm going in circles. PR is at https://github.com/${args.repo}/pull/${args.prNumber}. happy to keep going if you can point me at the right fix, but bouncing for now so i don't waste more cycles.`;
  try {
    await deps.linear.postComment(args.issue.id, body);
  } catch (err) {
    log.warn("could not post escalation comment", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (args.issue.creatorId) {
    try {
      await deps.linear.reassign(args.issue.id, args.issue.creatorId);
    } catch (err) {
      log.warn("could not reassign", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  setTerminalState(deps.db, args.issue.id, "escalated");
}
