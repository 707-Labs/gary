import { createHash } from "node:crypto";
import type { AggregateCi } from "./adapters/github.ts";

export interface DerivedPrState {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  isDraft: boolean;
  headSha: string;
  ciStatus: AggregateCi;
  /**
   * Hash of (non-Gary, not-yet-responded) PR comment ids. Empty hash means
   * there's nothing for Gary to respond to. See `computePrCommentSignature`.
   * Stable across Gary's own PR comments and pushes.
   */
  prCommentSignature: string;
  /**
   * ISO timestamp the PR was opened. Carried for staleness checks
   * (nudge_reviewer). Intentionally NOT included in the fingerprint canonical
   * — it never changes for a given PR, so adding it would only bloat the hash
   * without changing cache behavior.
   */
  openedAt: string;
}

export interface DerivedClassification {
  classification: "CODE" | "ANSWER" | "BOUNCE";
  /**
   * Optional so older tests don't have to set it. Live state always
   * populates this from the classifier; readers without scope info default
   * to "M" (the historical flat behavior).
   */
  scope?: "S" | "M" | "L";
  /**
   * Conventional-commit type from the classifier (feat/fix/refactor/...).
   * Used to prefix the branch name. Optional — pre-feature rows and
   * classifier outputs that omit it fall back to the unprefixed branch.
   * Not part of the fingerprint canonical.
   */
  changeType?: string;
}

export interface DerivedState {
  issueId: string;
  issueIdentifier: string;
  /**
   * Linear's `updatedAt` for the issue. Bumped on ANY change including Gary's
   * own writes — kept here for logging only, NOT included in the fingerprint.
   * Use `humanInputSignature` for idempotence.
   */
  issueUpdatedAt: string;
  /**
   * Hash of (description + non-Gary comment ids), so Gary's own answers
   * don't invalidate the action cache. See `computeHumanInputSignature`.
   */
  humanInputSignature: string;
  classification: DerivedClassification | null;
  pr: DerivedPrState | null;
}

/**
 * Stable, deterministic 16-hex-char hash of the inputs that affect any
 * action's decision for a given ticket.
 *
 * Replaces the old `issueUpdatedAt`-based hash, which looped on ANSWER
 * tickets — Gary's own comment bumped updatedAt and the cache missed.
 *
 * Action type is part of the SQLite cache key (see hasActedOn) so the
 * fingerprint itself doesn't need it.
 */
export function fingerprintDerivedState(state: DerivedState): string {
  const canonical = JSON.stringify({
    issueId: state.issueId,
    humanInputSignature: state.humanInputSignature,
    classification: state.classification?.classification ?? null,
    pr: state.pr
      ? {
          number: state.pr.number,
          state: state.pr.state,
          merged: state.pr.merged,
          isDraft: state.pr.isDraft,
          headSha: state.pr.headSha,
          ciStatus: state.pr.ciStatus,
          prCommentSignature: state.pr.prCommentSignature,
        }
      : null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export interface CommentMeta {
  id: string;
  userId: string | null;
  createdAt: string;
}

/**
 * Hash of inputs that come from humans, not Gary. Used to make the action
 * cache fingerprint stable across Gary's own writes (which would otherwise
 * loop on ANSWER tickets).
 *
 * Inputs:
 * - description (full text, since edits should re-trigger)
 * - non-Gary comment ids (sorted, so order-independent)
 *
 * Comments authored by Gary (matched on userId) are excluded entirely. Null
 * userId is preserved as a non-Gary comment — anonymous webhook posts etc.
 */
export function computeHumanInputSignature(args: {
  description: string | null;
  comments: readonly CommentMeta[];
  garyUserId: string;
}): string {
  const ids = args.comments
    .filter((c) => c.userId !== args.garyUserId)
    .map((c) => c.id)
    .sort();
  const canonical = JSON.stringify({
    description: args.description ?? null,
    commentIds: ids,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Bot logins whose PR comments Gary treats as review feedback. Everything
 * else with authorType !== "User" stays filtered (Gary himself, linear[bot]
 * linkbacks, dependabot, etc.). Gemini's review comments were previously
 * invisible to the pr-review pipeline — a human had to relay them.
 */
export const RESPONDABLE_BOT_LOGINS: ReadonlySet<string> = new Set([
  "gemini-code-assist[bot]",
]);

/**
 * Shared filter for "is this a PR comment Gary owes a response to, by
 * author?". Used by BOTH the pr-review handler and
 * `computePrCommentSignature` — if the two ever disagree, the handler
 * either loops (responds to comments the signature can't see clearing)
 * or goes dead (signature flags comments the handler filters out).
 */
export function isRespondablePrCommentAuthor(c: {
  authorLogin: string | null;
  authorType: string;
}): boolean {
  if (c.authorType === "User") return true;
  return c.authorLogin !== null && RESPONDABLE_BOT_LOGINS.has(c.authorLogin);
}

/**
 * Hash of PR comments that Gary still owes a response to. Filters out:
 *   - bots (Gary, linear[bot] linkbacks, dependabot, etc.) — Gary responds
 *     to humans plus the review bots in `RESPONDABLE_BOT_LOGINS`
 *   - comments Gary has already responded to (tracked in
 *     `pr_comment_responses`)
 *
 * Returns the special token "empty" when there's nothing pending — the
 * caller checks against this to decide whether to emit a respond_to_pr_review
 * candidate. Using a fixed token (vs the natural empty-list hash) makes the
 * "nothing to do" check obvious at call sites and in logs.
 */
export const PR_COMMENT_SIGNATURE_EMPTY = "empty";

export function computePrCommentSignature(args: {
  comments: readonly {
    id: number;
    authorLogin: string | null;
    authorType: string;
  }[];
  alreadyRespondedIds: readonly number[];
}): string {
  const responded = new Set(args.alreadyRespondedIds);
  const pending = args.comments
    .filter((c) => isRespondablePrCommentAuthor(c))
    .filter((c) => !responded.has(c.id))
    .map((c) => c.id)
    .sort((a, b) => a - b);
  if (pending.length === 0) return PR_COMMENT_SIGNATURE_EMPTY;
  const canonical = JSON.stringify({ pending });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
