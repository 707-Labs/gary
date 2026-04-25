import type { LinearAdapter } from "../adapters/linear.ts";
import type { AssignedIssue } from "../adapters/linear.ts";
import { log } from "../logger.ts";
import type { DB } from "../state/db.ts";
import { setTerminalState } from "../state/queries.ts";

export interface BounceHandlerDeps {
  db: DB;
  linear: LinearAdapter;
}

export interface BounceHandlerArgs {
  issue: AssignedIssue;
}

/**
 * The classifier-time comment already explained the bounce (per voice.md
 * example 4). This handler just performs the side-effects: reassign the
 * ticket back to the reporter and remove Gary as assignee. We mark the
 * ticket terminal_state='bounced' so we never act on it again.
 */
export async function runBounceHandler(
  deps: BounceHandlerDeps,
  args: BounceHandlerArgs,
): Promise<{ status: "bounced" }> {
  if (args.issue.creatorId) {
    try {
      await deps.linear.reassign(args.issue.id, args.issue.creatorId);
    } catch (err) {
      log.warn("could not reassign on bounce", {
        issue: args.issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to unassigning so Gary at least drops the ticket.
      try {
        await deps.linear.unassign(args.issue.id);
      } catch (err2) {
        log.warn("could not unassign on bounce", {
          issue: args.issue.identifier,
          error: err2 instanceof Error ? err2.message : String(err2),
        });
      }
    }
  } else {
    await deps.linear.unassign(args.issue.id);
  }
  setTerminalState(deps.db, args.issue.id, "bounced");
  log.info("ticket bounced", { issue: args.issue.identifier });
  return { status: "bounced" };
}
