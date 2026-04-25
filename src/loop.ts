import type { CloudflareClient } from "./adapters/cloudflare.ts";
import type { GitHubClient, PullRequestRef } from "./adapters/github.ts";
import type { LinearAdapter } from "./adapters/linear.ts";
import type { GLMClient } from "./adapters/glm.ts";
import { escalate } from "./escalate.ts";
import {
  classifyTicket,
  decideClassifyOutcome,
  generateClassificationComment,
} from "./handlers/classifier.ts";
import { runAnswerHandler } from "./handlers/answer.ts";
import { runBounceHandler } from "./handlers/bounce.ts";
import { runCiFailureHandler } from "./handlers/ci-failure.ts";
import { runCodeHandler } from "./handlers/code.ts";
import { runPickupHandler } from "./handlers/pickup.ts";
import { runPrReviewHandler } from "./handlers/pr-review.ts";
import { analyzeMentions } from "./mention.ts";
import { log } from "./logger.ts";
import {
  type CandidateAction,
  pickActionForMention,
  pickActionForTicket,
  pickHighestPriority,
} from "./priority.ts";
import { AllProvidersExhaustedError } from "./providers.ts";
import {
  computeHumanInputSignature,
  computePrCommentSignature,
  type DerivedPrState,
  type DerivedState,
  fingerprintDerivedState,
  PR_COMMENT_SIGNATURE_EMPTY,
} from "./state-fingerprint.ts";
import type { DB } from "./state/db.ts";
import {
  countActionsSince,
  getPrForTicket,
  getRespondedPrCommentIds,
  getRevisitMark,
  getTicket,
  hasActedOn,
  recordActionEnd,
  recordActionStart,
  recordEvent,
  setClassification,
  setRevisitMark,
  upsertTicket,
} from "./state/queries.ts";

export interface LoopDeps {
  db: DB;
  linear: LinearAdapter;
  github: GitHubClient;
  glm: GLMClient;
  cloudflare: CloudflareClient | null;
  allowedRepos: readonly string[];
  /**
   * Linear user ids permitted to summon Gary via @mention. Empty array
   * disables the @mention pipeline.
   */
  allowlistedMentionUserIds: readonly string[];
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
  // Every configured provider has its long-window cap armed. Skip the
  // tick entirely so we don't burn fetch + dispatch on calls that will
  // immediately throw AllProvidersExhausted. Cheap optimization;
  // correctness is upheld by the dispatch catch below.
  if (deps.glm.chain.allArmed()) {
    const until = deps.glm.chain.earliestReset();
    log.info("all providers armed; skipping tick", {
      until: until?.toISOString(),
    });
    recordEvent(deps.db, {
      eventType: "rate_limit_skip",
      payload: { until: until?.toISOString() ?? null },
    });
    return { candidatesConsidered: 0, actionTaken: null };
  }

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

    const lastRespondedHumanSignature = getRevisitMark(deps.db, issue.id);
    const candidate = pickActionForTicket({
      issue,
      state,
      lastRespondedHumanSignature,
    });
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

  // @mention pipeline — only when an allowlist is configured, since the
  // default empty allowlist means no one can summon Gary.
  if (deps.allowlistedMentionUserIds.length > 0) {
    await collectMentionCandidates(deps, issues, candidates);
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
    if (err instanceof AllProvidersExhaustedError) {
      // Every provider rate-limited mid-action. Per-provider gates are
      // already armed by `GLMClient.runWithFallback`; the next tick's
      // `chain.allArmed()` check will short-circuit until one clears.
      // Record the action as a non-bouncing failure so it retries with
      // the same fingerprint.
      log.warn("action paused; all providers armed", {
        action: action.type,
        issue: action.issue.identifier,
        earliestReset: err.earliestReset?.toISOString() ?? null,
      });
      recordEvent(deps.db, {
        eventType: "rate_limit_skip",
        payload: { until: err.earliestReset?.toISOString() ?? null },
      });
      recordActionEnd(deps.db, {
        id: actionId,
        success: false,
        errorMessage: `all providers armed; earliest reset ${err.earliestReset?.toISOString() ?? "unknown"}`,
      });
      return { candidatesConsidered: candidates.length, actionTaken: null };
    }
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

/**
 * Fetch tickets where Gary is @mentioned (subscriber but not assignee), run
 * the mention analyzer, and add pickup/answer candidates to the shared list.
 * Idempotence is via the same action-cache fingerprint pattern as assigned
 * tickets — humanInputSignature already includes non-Gary comments, so a
 * new mention bumps the fingerprint and a stale one doesn't.
 */
async function collectMentionCandidates(
  deps: LoopDeps,
  assignedIssues: readonly { id: string }[],
  candidates: CandidateAction[],
): Promise<void> {
  // Telemetry counters for the mention_scan event. Surfaced so a silently-
  // broken pipeline (e.g. the GraphQL type bug we hit) is visible in the
  // events table without needing a probe to diagnose.
  const stats = {
    scanned: 0,
    mentionOnly: 0,
    pickup: 0,
    mention: 0,
    fetchCommentsErrors: 0,
    fetchMentionedError: false as boolean,
  };

  let mentioned: Awaited<ReturnType<LinearAdapter["fetchMentionedIssues"]>>;
  try {
    mentioned = await deps.linear.fetchMentionedIssues();
    stats.scanned = mentioned.length;
  } catch (err) {
    stats.fetchMentionedError = true;
    log.warn("could not fetch mentioned issues; skipping mention pipeline", {
      error: err instanceof Error ? err.message : String(err),
    });
    recordEvent(deps.db, { eventType: "mention_scan", payload: stats });
    return;
  }

  const assignedIds = new Set(assignedIssues.map((i) => i.id));
  const mentionOnly = mentioned.filter((i) => !assignedIds.has(i.id));
  stats.mentionOnly = mentionOnly.length;

  for (const issue of mentionOnly) {
    upsertTicket(deps.db, { linearId: issue.id, identifier: issue.identifier });
    const ticketRow = getTicket(deps.db, issue.id);
    if (ticketRow?.terminal_state) continue;

    let comments: Awaited<ReturnType<LinearAdapter["fetchComments"]>>;
    try {
      comments = await deps.linear.fetchComments(issue.id);
    } catch (err) {
      stats.fetchCommentsErrors++;
      log.warn("could not fetch comments for mentioned ticket", {
        issue: issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const analysis = analyzeMentions({
      comments: comments.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        userId: c.userId,
      })),
      garyUserId: deps.linear.linearUserId,
      allowlistedUserIds: deps.allowlistedMentionUserIds,
    });
    if (analysis.kind === "none") continue;
    if (analysis.kind === "pickup") stats.pickup++;
    else if (analysis.kind === "mention") stats.mention++;

    const humanInputSignature = computeHumanInputSignature({
      description: issue.description,
      comments: comments.map((c) => ({
        id: c.id,
        userId: c.userId,
        createdAt: c.createdAt,
      })),
      garyUserId: deps.linear.linearUserId,
    });
    const state: DerivedState = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueUpdatedAt: issue.updatedAt,
      humanInputSignature,
      classification: null,
      pr: null,
    };

    const candidate = pickActionForMention({ issue, state, mention: analysis });
    if (!candidate) continue;
    const fp = fingerprintDerivedState(state);
    if (
      hasActedOn(deps.db, {
        ticketLinearId: issue.id,
        stateFingerprint: fp,
        actionType: candidate.type,
      })
    ) {
      continue;
    }
    candidates.push(candidate);
  }

  recordEvent(deps.db, { eventType: "mention_scan", payload: stats });
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
    case "respond_to_pr_review":
      await runRespondToPrReview(deps, action);
      return;
    case "revisit_code":
      await runRevisitCode(deps, action);
      return;
    case "pickup_ticket":
      await runPickupHandler(
        { linear: deps.linear },
        { issue: action.issue },
      );
      return;
    case "answer_mention":
      await runAnswerMention(deps, action);
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

async function runRespondToPrReview(
  deps: LoopDeps,
  action: CandidateAction,
): Promise<void> {
  const issue = action.issue;
  if (!action.state.pr) {
    throw new Error("respond_to_pr_review dispatched without a PR");
  }
  const prRow = getPrForTicket(deps.db, issue.id);
  if (!prRow) {
    throw new Error(
      `respond_to_pr_review: no PR row for ticket ${issue.identifier}`,
    );
  }
  await runPrReviewHandler(
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
    {
      issue,
      repo: prRow.repo,
      prGithubId: prRow.github_id,
      prNumber: prRow.pr_number,
      branch: prRow.branch,
    },
  );
}

// Source of truth: voice.md example 17. Keep in sync.
const ANSWER_MENTION_ACK = `on it — taking a look at the code, back in a min`;

async function runAnswerMention(
  deps: LoopDeps,
  action: CandidateAction,
): Promise<void> {
  // Post a brief ack so the asker knows Gary saw the @mention. The full
  // answer follows when the agent loop finishes; the ack closes the
  // perceived-silence gap while the agent investigates.
  try {
    await deps.linear.postComment(action.issue.id, ANSWER_MENTION_ACK);
  } catch (err) {
    log.warn("could not post answer_mention ack", {
      issue: action.issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await runWriteAnswer(deps, action);
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
  // Mark this signature as the last input Gary acted on. Subsequent comments
  // bump the signature and revisit_code fires; without comments it stays
  // stable and revisit_code is dormant.
  setRevisitMark(deps.db, issue.id, action.state.humanInputSignature);
}

async function runRevisitCode(
  deps: LoopDeps,
  action: CandidateAction,
): Promise<void> {
  // Reuses the answer handler — read-only investigation + Linear comment.
  // Push-on-unambiguous-ask is deferred (mirrors pr-review's reply-default).
  await runWriteAnswer(deps, action);
  setRevisitMark(deps.db, action.issue.id, action.state.humanInputSignature);
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

  const outcome = decideClassifyOutcome(classification);
  if (outcome.kind === "low_confidence") {
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
  if (outcome.kind === "scope_too_big") {
    log.info("scope=L on CODE; auto-bouncing", {
      issue: issue.identifier,
      confidence: classification.confidence,
    });
    await escalate(
      { db: deps.db, linear: deps.linear },
      {
        issue,
        reason: "scope_too_big",
        customBody: `${classification.reasoning.trim()}\n\nbouncing — this is bigger than i should take on without a clearer scope. happy to pick it up if it gets chunked into smaller pieces.`,
      },
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

  // Compute the pending-comment signature so the priority logic knows whether
  // there are reviewer comments Gary still owes a response to. Skip this for
  // closed/merged PRs — no respond_to_pr_review action will fire anyway.
  let prCommentSignature = PR_COMMENT_SIGNATURE_EMPTY;
  if (pr.state === "open" && !pr.merged) {
    try {
      const comments = await deps.github.getPullRequestComments(
        owner,
        name,
        pr.number,
      );
      const respondedIds = getRespondedPrCommentIds(deps.db, row.github_id);
      prCommentSignature = computePrCommentSignature({
        comments,
        alreadyRespondedIds: respondedIds,
      });
    } catch (err) {
      log.warn("could not fetch PR comments; skipping review-response check", {
        repo: row.repo,
        number: row.pr_number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    isDraft: pr.isDraft,
    headSha: pr.headSha,
    ciStatus,
    prCommentSignature,
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
