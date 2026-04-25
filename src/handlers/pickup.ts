import type { AssignedIssue, LinearAdapter } from "../adapters/linear.ts";
import { log } from "../logger.ts";

// Source of truth for this string is voice.md example 16. Keep them in sync.
const PICKUP_ACK = `picked it up — classifying now, i'll either open a PR or post an answer shortly`;

export interface PickupHandlerDeps {
  linear: LinearAdapter;
}

export interface PickupHandlerArgs {
  issue: AssignedIssue;
}

/**
 * Handle a pickup request: assign the ticket to Gary and post a brief
 * acknowledgement. The next tick treats the ticket as a normal assignment
 * and runs the classifier → CODE/ANSWER/BOUNCE flow.
 */
export async function runPickupHandler(
  deps: PickupHandlerDeps,
  args: PickupHandlerArgs,
): Promise<void> {
  await deps.linear.reassign(args.issue.id, deps.linear.linearUserId);
  log.info("self-assigned via pickup", { issue: args.issue.identifier });
  try {
    await deps.linear.postComment(args.issue.id, PICKUP_ACK);
  } catch (err) {
    log.warn("could not post pickup acknowledgement", {
      issue: args.issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
