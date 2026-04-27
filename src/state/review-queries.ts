import type { DB } from "./db.ts";

export type ReviewVerdict = "approve" | "changes_needed" | "failed";

export interface ReviewPassInput {
  issueLinearId: string;
  fingerprint: string;
  round: number;
  verdict: ReviewVerdict;
  findingCount: number;
  advisoryCount: number;
  providerUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  escalated: boolean;
}

export function recordReviewPass(db: DB, input: ReviewPassInput): void {
  db.query(
    `INSERT INTO review_passes (
       issue_id, fingerprint, round, verdict,
       finding_count, advisory_count, provider_used,
       input_tokens, output_tokens, duration_ms, escalated
     ) VALUES (
       $issue, $fp, $round, $verdict,
       $findings, $advisories, $provider,
       $inTok, $outTok, $dur, $esc
     )`,
  ).run({
    issue: input.issueLinearId,
    fp: input.fingerprint,
    round: input.round,
    verdict: input.verdict,
    findings: input.findingCount,
    advisories: input.advisoryCount,
    provider: input.providerUsed,
    inTok: input.inputTokens,
    outTok: input.outputTokens,
    dur: input.durationMs,
    esc: input.escalated ? 1 : 0,
  });
}

/**
 * Mark the most recent review_passes row for `(issueLinearId, fingerprint,
 * round)` as escalated. The row is written by `recordReviewPass` before the
 * orchestrator decides whether to escalate; this update flips the bit after
 * the decision so calibration queries can find escalating rounds.
 */
export function markReviewPassEscalated(
  db: DB,
  args: { issueLinearId: string; fingerprint: string; round: number },
): void {
  db.query(
    `UPDATE review_passes SET escalated = 1
     WHERE issue_id = $issue AND fingerprint = $fp AND round = $round`,
  ).run({
    issue: args.issueLinearId,
    fp: args.fingerprint,
    round: args.round,
  });
}
