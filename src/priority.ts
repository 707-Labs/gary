import type { AssignedIssue } from "./adapters/linear.ts";
import type { MentionAnalysis } from "./mention.ts";
import {
  type DerivedState,
  PR_COMMENT_SIGNATURE_EMPTY,
} from "./state-fingerprint.ts";

export type ActionType =
  | "fix_ci_failure"
  | "respond_to_pr_review"
  | "pickup_ticket"
  | "revisit_code"
  | "classify"
  | "start_coding"
  | "answer_mention"
  | "write_answer"
  | "bounce";

export interface CandidateAction {
  type: ActionType;
  priority: number; // lower = higher priority
  issue: AssignedIssue;
  state: DerivedState;
}

export interface PriorityInputs {
  issue: AssignedIssue;
  state: DerivedState;
  /**
   * The humanInputSignature recorded the last time Gary acted on this
   * ticket's content (start_coding or revisit_code). Compared against the
   * current signature to decide whether to emit revisit_code.
   *
   * `null` means "no mark exists yet" — revisit_code stays dormant in that
   * case to avoid re-engaging on stale state for tickets that pre-date
   * this feature.
   */
  lastRespondedHumanSignature?: string | null;
}

/**
 * Pick the single best candidate for a ticket given its derived state, or
 * null if no action applies. Mirrors the table in GARY_SPEC.md §6 with the
 * Weekend 2 rows omitted.
 */
export function pickActionForTicket(
  inputs: PriorityInputs,
): CandidateAction | null {
  const { issue, state } = inputs;

  // 1. fix_ci_failure — Gary has an open PR with CI red
  if (
    state.pr &&
    state.pr.state === "open" &&
    !state.pr.merged &&
    state.pr.ciStatus === "red"
  ) {
    return { type: "fix_ci_failure", priority: 1, issue, state };
  }

  // 2. respond_to_pr_review — open PR has reviewer comments Gary hasn't
  //    addressed yet. Lower priority than CI red so Gary fixes broken builds
  //    before chasing comment threads.
  if (
    state.pr &&
    state.pr.state === "open" &&
    !state.pr.merged &&
    state.pr.prCommentSignature !== PR_COMMENT_SIGNATURE_EMPTY
  ) {
    return { type: "respond_to_pr_review", priority: 2, issue, state };
  }

  // 2.5. revisit_code — CODE ticket has new human input on the Linear side
  //    since Gary last acted (start_coding or a previous revisit). Re-reads
  //    the comment thread and posts a follow-up answer. Read-only for now —
  //    push-on-unambiguous-ask is a v2 like pr-review.
  if (
    state.classification?.classification === "CODE" &&
    state.pr &&
    state.pr.state === "open" &&
    !state.pr.merged &&
    inputs.lastRespondedHumanSignature !== null &&
    inputs.lastRespondedHumanSignature !== undefined &&
    inputs.lastRespondedHumanSignature !== state.humanInputSignature
  ) {
    return { type: "revisit_code", priority: 2.5, issue, state };
  }

  // 3. classify — assigned to Gary, no classification yet
  if (state.classification === null) {
    return { type: "classify", priority: 3, issue, state };
  }

  // 4. start_coding — CODE classification, no PR yet
  if (state.classification.classification === "CODE" && state.pr === null) {
    return { type: "start_coding", priority: 4, issue, state };
  }

  // 5. write_answer — ANSWER classification, no comment yet (idempotence
  //    is handled by the action-cache layer; we always emit the candidate)
  if (state.classification.classification === "ANSWER") {
    return { type: "write_answer", priority: 5, issue, state };
  }

  // 6. bounce — BOUNCE classification, hasn't been bounced yet
  if (state.classification.classification === "BOUNCE") {
    return { type: "bounce", priority: 6, issue, state };
  }

  return null;
}

/**
 * Variant of pickActionForTicket for tickets where Gary is @mentioned but
 * NOT yet assigned. The decision space is much narrower:
 *   - explicit pickup phrase from an allowlisted user → self-assign
 *   - generic @mention from an allowlisted user → answer in-place
 *   - anything else → ignore (priority returns null)
 *
 * Once Gary self-assigns, the ticket flows through the normal
 * `pickActionForTicket` path on the next tick.
 */
export function pickActionForMention(inputs: {
  issue: AssignedIssue;
  state: DerivedState;
  mention: MentionAnalysis;
}): CandidateAction | null {
  const { issue, state, mention } = inputs;
  if (mention.kind === "pickup") {
    return { type: "pickup_ticket", priority: 1.5, issue, state };
  }
  if (mention.kind === "mention") {
    return { type: "answer_mention", priority: 2.5, issue, state };
  }
  return null;
}

/**
 * Across all tickets, pick the single highest-priority action. Returns null
 * if there's nothing to do this tick.
 */
export function pickHighestPriority(
  candidates: readonly CandidateAction[],
): CandidateAction | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.priority - b.priority)[0] ?? null;
}
