import type { LinearAdapter } from "./adapters/linear.ts";
import type { AssignedIssue } from "./adapters/linear.ts";
import { log } from "./logger.ts";
import type { DB } from "./state/db.ts";
import { setTerminalState } from "./state/queries.ts";

export type EscalationReason =
  | "circuit_breaker"
  | "low_classifier_confidence"
  | "iteration_cap"
  | "timeout"
  | "no_finish"
  | "agent_error"
  | "max_ci_attempts"
  | "scope_too_big"
  | "unknown";

const DEFAULT_MESSAGES: Record<EscalationReason, string> = {
  circuit_breaker:
    "i've been spinning on this without making progress — bouncing it back so a human can take a look. happy to take another swing once someone's mapped out the right approach.",
  low_classifier_confidence:
    "i wasn't sure how to classify this. kicking it back to you. if you can give it a once-over and reassign with more context i'll take another swing.",
  iteration_cap:
    "i hit the iteration cap on this one before getting to a clean stopping point. bouncing it back so a human can take a look.",
  timeout:
    "i ran out of time on this one. bouncing it back — happy to take another swing if someone can point me at the right approach.",
  no_finish:
    "the model returned without calling finish, which usually means it lost the thread. bouncing — i'd want a human to look before i try again.",
  agent_error:
    "ran into an error i couldn't recover from. bouncing back to you.",
  max_ci_attempts:
    "ci has failed too many times in a row and i'm going in circles. bouncing for now so i don't waste more cycles.",
  scope_too_big:
    "this is bigger than i thought when i picked it up. bouncing — i'd want a human to decide on the approach before i keep going.",
  unknown: "something went wrong. bouncing back.",
};

export interface EscalateDeps {
  db: DB;
  linear: LinearAdapter;
}

export interface EscalateArgs {
  issue: AssignedIssue;
  reason: EscalationReason;
  /** Optional override for the comment body. Otherwise uses the canned voice
   * line for this reason. */
  customBody?: string;
}

export async function escalate(
  deps: EscalateDeps,
  args: EscalateArgs,
): Promise<void> {
  const body = args.customBody ?? DEFAULT_MESSAGES[args.reason];
  try {
    await deps.linear.postComment(args.issue.id, body);
  } catch (err) {
    log.warn("could not post escalation comment", {
      issue: args.issue.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (args.issue.creatorId) {
    try {
      await deps.linear.reassign(args.issue.id, args.issue.creatorId);
    } catch (err) {
      log.warn("could not reassign on escalation", {
        issue: args.issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await deps.linear.unassign(args.issue.id);
      } catch {
        // best-effort — Gary may end up still assigned
      }
    }
  } else {
    try {
      await deps.linear.unassign(args.issue.id);
    } catch {
      // best-effort
    }
  }
  setTerminalState(deps.db, args.issue.id, "escalated");
  log.info("ticket escalated", {
    issue: args.issue.identifier,
    reason: args.reason,
  });
}
