import type { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, LinearAdapter } from "../adapters/linear.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import { log } from "../logger.ts";

const NUDGE_TASK_INSTRUCTIONS = `Write a Linear comment nudging the reviewer about an open PR that's been sitting idle. Use voice.md example 14 as your structural template — match its tone and length exactly.

Output only the comment body. One short paragraph, lowercase-friendly, no preamble, no signature.

Required content:
- Address the reviewer by name if you have one (lowercase first name).
- Note how long the PR has been open in human-friendly terms ("3 days", "a week", not "72 hours").
- State that CI is green and there are no review comments outstanding.
- Ask whether they'd like Gary to close it or keep it open.
- End with "no rush" or equivalent — Gary's not pushing, just checking in.

Do not:
- Restate the ticket title or PR title.
- Apologize.
- Use exclamation points.
- Suggest specific reviewers other than the addressee.`;

export interface NudgeReviewerDeps {
  linear: LinearAdapter;
  glm: GLMClient;
}

export interface NudgeReviewerArgs {
  issue: AssignedIssue;
  prUrl: string;
  prNumber: number;
  /** ISO timestamp; used to render a human duration into the prompt. */
  prOpenedAt: string;
  /** Reporter / preferred reviewer name. Optional — handler still works without. */
  reviewerName: string | null;
  now?: number;
}

export interface NudgeReviewerResult {
  status: "nudged";
  body: string;
}

export async function runNudgeReviewer(
  deps: NudgeReviewerDeps,
  args: NudgeReviewerArgs,
): Promise<NudgeReviewerResult> {
  const now = args.now ?? Date.now();
  const opened = Date.parse(args.prOpenedAt);
  const ageHours = Number.isFinite(opened)
    ? Math.max(0, Math.round((now - opened) / (60 * 60 * 1000)))
    : 0;
  const ageHuman = formatAge(ageHours);

  const system = composeSystemPrompt({ taskInstructions: NUDGE_TASK_INSTRUCTIONS });
  const user = [
    `Ticket: ${args.issue.identifier} — ${args.issue.title}`,
    `PR: #${args.prNumber} (${args.prUrl})`,
    `Reviewer to address: ${args.reviewerName ?? "(unknown — write the comment without a name lead)"}`,
    `PR has been open for: ${ageHuman}`,
    "CI: green",
    "Review comments outstanding: none",
  ].join("\n");

  const body = (
    await deps.glm.complete({
      system,
      user,
      temperature: 0.4,
      maxTokens: 256,
    })
  ).trim();

  await deps.linear.postComment(args.issue.id, body);
  log.info("nudged stale PR", {
    issue: args.issue.identifier,
    pr: args.prNumber,
    ageHours,
  });
  return { status: "nudged", body };
}

export function formatAge(hours: number): string {
  if (hours < 24) return hours <= 1 ? "an hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  if (days === 1) return "a day";
  if (days < 7) return `${days} days`;
  if (days < 14) return "a week";
  if (days < 30) return `${Math.round(days / 7)} weeks`;
  const months = Math.round(days / 30);
  return months === 1 ? "a month" : `${months} months`;
}
