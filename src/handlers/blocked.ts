import type {
  AssignedIssue,
  BlockerRef,
  LinearAdapter,
} from "../adapters/linear.ts";
import { log } from "../logger.ts";
import type { DB } from "../state/db.ts";
import { recordEvent } from "../state/queries.ts";

export interface BlockedHandlerDeps {
  db: DB;
  linear: LinearAdapter;
}

export interface BlockedHandlerArgs {
  issue: AssignedIssue;
}

// Source of truth: voice.md example 18. Keep in sync. Also the dedupe
// marker — renderHoldComment must keep this as its opening phrase.
const HOLD_MARKER = "holding off on the code here";

export function renderHoldComment(blockers: readonly BlockerRef[]): string {
  const list = blockers
    .map((b) => `${b.identifier} (${b.stateName})`)
    .join(" and ");
  const verb = blockers.length === 1 ? "hasn't" : "haven't";
  const start = blockers.length === 1 ? "once it lands" : "once they land";
  return (
    `${HOLD_MARKER} — this ticket is blocked by ${list}, which ${verb} shipped yet. ` +
    `i'll start ${start}. if the relation is stale and this isn't actually blocked, ` +
    `remove it in linear and i'll pick this up on the next poll.`
  );
}

/**
 * CODE ticket with an open "blocked by" relation: say why Gary isn't
 * starting, once, then hold. The action cache keeps this from re-firing on
 * an unchanged fingerprint; the comment scan below keeps fingerprint churn
 * (humans discussing the blocker on the ticket) from re-posting an
 * identical hold message.
 */
export async function runWaitForBlocker(
  deps: BlockedHandlerDeps,
  args: BlockedHandlerArgs,
): Promise<{ status: "waiting"; commented: boolean }> {
  const open = args.issue.blockedBy.filter((b) => b.isOpen);
  if (open.length === 0) {
    // Race: unblocked between fetch and dispatch. The next tick emits
    // start_coding; nothing useful to say here.
    return { status: "waiting", commented: false };
  }

  let alreadyExplained = false;
  try {
    const comments = await deps.linear.fetchComments(args.issue.id, 50);
    alreadyExplained = comments.some(
      (c) =>
        c.userId === deps.linear.linearUserId &&
        c.body.includes(HOLD_MARKER) &&
        open.every((b) => c.body.includes(b.identifier)),
    );
  } catch (err) {
    // Can't tell whether we already explained — post rather than go silent.
    log.warn("could not scan comments for prior hold notice", {
      issue: args.issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!alreadyExplained) {
    await deps.linear.postComment(args.issue.id, renderHoldComment(open));
  }
  recordEvent(deps.db, {
    eventType: "blocked_wait",
    ticketLinearId: args.issue.id,
    payload: {
      blockers: open.map((b) => b.identifier),
      commented: !alreadyExplained,
    },
  });
  log.info("waiting on blockers", {
    issue: args.issue.identifier,
    blockers: open.map((b) => b.identifier),
    commented: !alreadyExplained,
  });
  return { status: "waiting", commented: !alreadyExplained };
}
