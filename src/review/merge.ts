import type { SubmittedReview } from "./tools.ts";
import type { ReviewRole } from "./roles.ts";

export interface RoleReview {
  role: ReviewRole;
  review: SubmittedReview;
}

export interface RoleFailure {
  role: ReviewRole;
  reason: string;
}

export interface MergedReview {
  review: SubmittedReview;
  /** Roles that produced a verdict, in the order they were requested. */
  succeeded: readonly ReviewRole[];
  /** Roles that crashed, timed out, or never submitted. */
  failed: readonly RoleFailure[];
}

/** Normalize a finding title for dedupe: case- and punctuation-insensitive. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Combine per-role reviews into the single verdict the rest of the handler
 * consumes.
 *
 * Semantics:
 * - **Verdict is pessimistic.** Any role returning `changes_needed` blocks.
 *   The roles have deliberately different mandates, so a disagreement means
 *   one of them saw something the other wasn't looking for — not that they
 *   split a coin flip.
 * - **Findings are deduped by normalized title**, keeping the first
 *   occurrence. Both roles can flag security, so overlap is expected and
 *   must not double-count into the fixup task.
 * - **Verification reports are concatenated with role headers**, never
 *   interleaved. The report is pasted verbatim into the PR body, so it has
 *   to stay attributable.
 *
 * Callers must not pass an empty `reviews` array — with every role failed
 * there is no verdict to merge, and the caller owns that path (retry, then
 * default-approve).
 */
export function mergeReviews(
  reviews: readonly RoleReview[],
  failed: readonly RoleFailure[] = [],
): MergedReview {
  if (reviews.length === 0) {
    throw new Error("mergeReviews requires at least one successful role review");
  }

  const seen = new Set<string>();
  const findings: SubmittedReview["findings"] = [];
  for (const { review } of reviews) {
    for (const f of review.findings) {
      const key = titleKey(f.title);
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }

  const advisoryNotes = [...new Set(reviews.flatMap((r) => r.review.advisoryNotes))];

  const reportSections: string[] = [];
  for (const { role, review } of reviews) {
    const body = review.verificationReport.trim();
    reportSections.push(
      `**${role} reviewer**\n\n${body.length > 0 ? body : "(approved without a written report)"}`,
    );
  }
  for (const f of failed) {
    reportSections.push(`**${f.role} reviewer**\n\n_pass unavailable (${f.reason})_`);
  }

  const verdict = reviews.some((r) => r.review.verdict === "changes_needed")
    ? "changes_needed"
    : "approve";

  return {
    review: {
      verdict,
      // An `approve` verdict must carry no findings — `submit_review`
      // enforces that per-role, and dedupe can't introduce any, but keep
      // the invariant explicit so a future merge rule can't violate it.
      findings: verdict === "changes_needed" ? findings : [],
      advisoryNotes,
      verificationReport: reportSections.join("\n\n"),
    },
    succeeded: reviews.map((r) => r.role),
    failed,
  };
}
