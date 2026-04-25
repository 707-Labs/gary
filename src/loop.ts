import type { CloudflareClient } from "./adapters/cloudflare.ts";
import type { GitHubClient, PullRequestRef } from "./adapters/github.ts";
import type { LinearAdapter } from "./adapters/linear.ts";
import type { GLMClient } from "./adapters/glm.ts";
import { escalate } from "./escalate.ts";
import {
  classifyTicket,
  generateClassificationComment,
} from "./handlers/classifier.ts";
import { runAnswerHandler } from "./handlers/answer.ts";
import { runBounceHandler } from "./handlers/bounce.ts";
import { runCiFailureHandler } from "./handlers/ci-failure.ts";
import { runCodeHandler } from "./handlers/code.ts";
import { log } from "./logger.ts";
import {
  type CandidateAction,
  pickActionForTicket,
  pickHighestPriority,
} from "./priority.ts";
import {
  computeHumanInputSignature,
  type DerivedPrState,
  type DerivedState,
  fingerprintDerivedState,
} from "./state-fingerprint.ts";
import type { DB } from "./state/db.ts";
import {
  countActionsSince,
  getPrForTicket,
  getTicket,
  hasActedOn,
  recordActionEnd,
  recordActionStart,
  recordEvent,
  setClassification,
  upsertTicket,
} from "./state/queries.ts";

export interface LoopDeps {
  db: DB;
  linear: LinearAdapter;
  github: GitHubClient;
  glm: GLMClient;
  cloudflare: CloudflareClient | null;
  allowedRepos: readonly string[];
  reposDir: string;
  workspacesDir: string;
  agentLoopMaxIterations: number;
  agentLoopTimeoutMs: number;
  maxCiAttempts: number;
  maxAttemptsPerTicket: number;
  circuitBreakerWindowHours: number;
}

export interface TickResult {
  candidatesConsidered: number;
  actionTaken: string | null;
}

/**
 * One iteration of the poll loop. Fetches assigned issues, derives state,
 * picks the highest-priority action, runs it, records to SQLite. Returns
 * info about what happened so callers can decide cadence.
 */
export async function tick(deps: LoopDeps): Promise<TickResult> {
  const issues = await deps.linear.fetchAssignedIssues();
  recordEvent(deps.db, { eventType: "poll", payload: { count: issues.length } });

  const candidates: CandidateAction[] = [];
  for (const issue of issues) {
    upsertTicket(deps.db, { linearId: issue.id, identifier: issue.identifier });

    const ticketRow = getTicket(deps.db, issue.id);
    if (ticketRow?.terminal_state) {
      // We've already concluded this ticket. Don't act again.
      continue;
    }

    // Circuit breaker: if Gary has thrashed on this ticket too many times in
    // the rolling window, escalate and stop.
    const recentAttempts = countActionsSince(deps.db, {
      ticketLinearId: issue.id,
      sinceHoursAgo: deps.circuitBreakerWindowHours,
    });
    if (recentAttempts >= deps.maxAttemptsPerTicket) {
      log.warn("circuit breaker tripped", {
        issue: issue.identifier,
        attempts: recentAttempts,
        windowHours: deps.circuitBreakerWindowHours,
      });
      await escalate(
        { db: deps.db, linear: deps.linear },
        { issue, reason: "circuit_breaker" },
      );
      continue;
    }

    const classification = ticketRow?.classification
      ? { classification: ticketRow.classification }
      : null;

    const pr = await derivePr(deps, issue.id);

    // The fingerprint includes a hash of human-only inputs (description +
    // non-Gary comment ids) so that Gary's own comments don't invalidate the
    // action cache. Without this, ANSWER tickets loop until the circuit
    // breaker fires.
    let humanInputSignature: string;
    try {
      const commentMeta = await deps.linear.fetchCommentMeta(issue.id);
      humanInputSignature = computeHumanInputSignature({
        description: issue.description,
        comments: commentMeta,
        garyUserId: deps.linear.linearUserId,
      });
    } catch (err) {
      log.warn("could not fetch comment meta; falling back to updatedAt", {
        issue: issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      humanInputSignature = `fallback:${issue.updatedAt}`;
    }

    const state: DerivedState = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueUpdatedAt: issue.updatedAt,
      humanInputSignature,
      classification,
      pr,
    };

    const candidate = pickActionForTicket({ issue, state });
    if (!candidate) continue;
    const fp = fingerprintDerivedState(state);
    if (hasActedOn(deps.db, {
      ticketLinearId: issue.id,
      stateFingerprint: fp,
      actionType: candidate.type,
    })) {
      continue;
    }
    candidates.push(candidate);
  }

  const action = pickHighestPriority(candidates);
  if (!action) {
    return { candidatesConsidered: candidates.length, actionTaken: null };
  }

  const fp = fingerprintDerivedState(action.state);
  const actionId = recordActionStart(deps.db, {
    ticketLinearId: action.issue.id,
    stateFingerprint: fp,
    actionType: action.type,
  });
  recordEvent(deps.db, {
    eventType: "action_dispatched",
    ticketLinearId: action.issue.id,
    payload: { type: action.type, fingerprint: fp },
  });

  try {
    await dispatch(deps, action);
    recordActionEnd(deps.db, { id: actionId, success: true });
    return { candidatesConsidered: candidates.length, actionTaken: action.type };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("action failed", {
      action: action.type,
      issue: action.issue.identifier,
      error: message,
    });
    recordActionEnd(deps.db, {
      id: actionId,
      success: false,
      errorMessage: message,
    });
    return { candidatesConsidered: candidates.length, actionTaken: action.type };
  }
}

async function dispatch(deps: LoopDeps, action: CandidateAction): Promise<void> {
  switch (action.type) {
    case "classify":
      await runClassify(deps, action);
      return;
    case "start_coding":
      await runStartCoding(deps, action);
      return;
    case "fix_ci_failure":
      await runFixCiFailure(deps, action);
      return;
    case "write_answer":
      await runWriteAnswer(deps, action);
      return;
    case "bounce":
      await runBounceHandler(
        { db: deps.db, linear: deps.linear },
        { issue: action.issue },
      );
      return;
  }
}

async function runWriteAnswer(
  deps: LoopDeps,
  action: CandidateAction,
): Promise<void> {
  const issue = action.issue;
  const repo = deps.allowedRepos[0];
  if (!repo) throw new Error("no allowed repos configured");
  const comments = await deps.linear.fetchComments(issue.id);
  await runAnswerHandler(
    {
      linear: deps.linear,
      github: deps.github,
      glm: deps.glm,
      cloudflare: deps.cloudflare,
      reposDir: deps.reposDir,
      workspacesDir: deps.workspacesDir,
      agentLoopMaxIterations: deps.agentLoopMaxIterations,
      agentLoopTimeoutMs: deps.agentLoopTimeoutMs,
    },
    { issue, comments, repo },
  );
}

async function runFixCiFailure(
  deps: LoopDeps,
  action: CandidateAction,
): Promise<void> {
  const issue = action.issue;
  if (!action.state.pr) {
    throw new Error("fix_ci_failure dispatched without a PR");
  }
  const prRow = getPrForTicket(deps.db, issue.id);
  if (!prRow) {
    throw new Error(
      `fix_ci_failure: no PR row for ticket ${issue.identifier}`,
    );
  }
  await runCiFailureHandler(
    {
      db: deps.db,
      linear: deps.linear,
      github: deps.github,
      glm: deps.glm,
      cloudflare: deps.cloudflare,
      reposDir: deps.reposDir,
      workspacesDir: deps.workspacesDir,
      agentLoopMaxIterations: deps.agentLoopMaxIterations,
      agentLoopTimeoutMs: deps.agentLoopTimeoutMs,
      maxCiAttempts: deps.maxCiAttempts,
    },
    {
      issue,
      repo: prRow.repo,
      prNumber: prRow.pr_number,
      branch: prRow.branch,
      headSha: action.state.pr.headSha,
    },
  );
}

async function runStartCoding(
  deps: LoopDeps,
  action: CandidateAction,
): Promise<void> {
  const issue = action.issue;
  if (!deps.allowedRepos.includes(`${issue.teamKey === "ERT" ? "707-Labs/ertai" : ""}`)) {
    // Weekend 1 only handles Ertai. Map team → repo. If the team isn't
    // mapped, escalate.
    if (deps.allowedRepos.length === 1 && deps.allowedRepos[0]) {
      // Single allowed repo — assume that's the target.
    } else {
      throw new Error(
        `cannot map team ${issue.teamKey} to a repo; allowed repos: ${deps.allowedRepos.join(", ")}`,
      );
    }
  }
  const repo = deps.allowedRepos[0];
  if (!repo) {
    throw new Error("no allowed repos configured");
  }
  const comments = await deps.linear.fetchComments(issue.id);
  await runCodeHandler(
    {
      db: deps.db,
      linear: deps.linear,
      github: deps.github,
      glm: deps.glm,
      cloudflare: deps.cloudflare,
      reposDir: deps.reposDir,
      workspacesDir: deps.workspacesDir,
      agentLoopMaxIterations: deps.agentLoopMaxIterations,
      agentLoopTimeoutMs: deps.agentLoopTimeoutMs,
    },
    { issue, comments, repo },
  );
}

async function runClassify(
  deps: LoopDeps,
  action: CandidateAction,
): Promise<void> {
  const issue = action.issue;
  const comments = await deps.linear.fetchComments(issue.id);
  const classification = await classifyTicket(deps, { issue, comments });
  setClassification(deps.db, {
    linearId: issue.id,
    classification: classification.classification,
    confidence: classification.confidence,
    scope: classification.scope,
  });

  // Low-confidence escalation: spec §14 says < 0.5 should bounce.
  if (classification.confidence < 0.5) {
    log.warn("classification confidence too low; escalating", {
      issue: issue.identifier,
      confidence: classification.confidence,
    });
    await escalate(
      { db: deps.db, linear: deps.linear },
      { issue, reason: "low_classifier_confidence" },
    );
    return;
  }

  // Pickup acknowledgement: move to In Progress on first classification.
  try {
    await deps.linear.moveToInProgress(issue.id);
  } catch (err) {
    log.warn("could not move to in progress", {
      issue: issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const body = await generateClassificationComment(deps, {
    issue,
    classification,
  });
  await deps.linear.postComment(issue.id, body);
  log.info("classified and commented", {
    issue: issue.identifier,
    classification: classification.classification,
  });
}

async function derivePr(
  deps: LoopDeps,
  ticketLinearId: string,
): Promise<DerivedPrState | null> {
  const row = getPrForTicket(deps.db, ticketLinearId);
  if (!row) return null;
  if (!deps.allowedRepos.includes(row.repo)) return null;
  const [owner, name] = row.repo.split("/") as [string, string];
  let pr: PullRequestRef;
  try {
    pr = await deps.github.getPullRequest(owner, name, row.pr_number);
  } catch (err) {
    log.warn("could not fetch PR", {
      repo: row.repo,
      number: row.pr_number,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const ciStatus = await deps.github.aggregateCiStatus(owner, name, pr.headSha);
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    isDraft: pr.isDraft,
    headSha: pr.headSha,
    ciStatus,
  };
}

export interface RunLoopArgs extends LoopDeps {
  intervalMs: number;
  signal?: AbortSignal;
}

/** Runs the poll loop forever (until aborted). One tick per interval. */
export async function runLoop(args: RunLoopArgs): Promise<void> {
  log.info("loop starting", { intervalMs: args.intervalMs });
  while (!args.signal?.aborted) {
    try {
      const result = await tick(args);
      log.debug("tick complete", { ...result });
    } catch (err) {
      log.error("tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(args.intervalMs, args.signal);
  }
  log.info("loop stopping");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
