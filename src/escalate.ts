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
  | "review_rejected"
  | "unmapped_team"
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
  review_rejected:
    "the reviewer kept finding issues across multiple rounds. bouncing so a human can decide whether to retry, split, or fix directly.",
  unmapped_team:
    "i'm not wired up for this team's repo yet — bouncing back. ask tanner to add the team to GARY_REPO_MAP if you want me handling these.",
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
  // Move the board back to Todo — Gary is handing the ticket off, and an
  // In Progress ticket with no one working on it is a lie.
  try {
    await deps.linear.setStateByType(args.issue.id, args.issue.teamId, "unstarted");
  } catch (err) {
    log.warn("could not move escalated ticket back to todo", {
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

export interface SynthesizeReviewRejectedArgs {
  finalFindings: readonly { title: string; bugClass: string }[];
  rounds: number;
}

/**
 * Compose a Linear comment body for a review-rejected escalation.
 * Splices in the final round's finding titles so the bounce message
 * is specific instead of generic.
 */
export function synthesizeReviewRejectedBody(
  args: SynthesizeReviewRejectedArgs,
): string {
  const lines = [
    `took ${args.rounds} swings at this and the reviewer kept finding issues. bouncing so a human can decide whether to retry, split, or fix directly.`,
    "",
    "last round's blockers:",
  ];
  for (const f of args.finalFindings) {
    lines.push(`- ${f.title}`);
  }
  return lines.join("\n");
}
