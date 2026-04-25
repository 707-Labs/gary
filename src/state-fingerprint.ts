import { createHash } from "node:crypto";
import type { AggregateCi } from "./adapters/github.ts";

export interface DerivedPrState {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  isDraft: boolean;
  headSha: string;
  ciStatus: AggregateCi;
}

export interface DerivedClassification {
  classification: "CODE" | "ANSWER" | "BOUNCE";
}

export interface DerivedState {
  issueId: string;
  issueIdentifier: string;
  issueUpdatedAt: string;
  classification: DerivedClassification | null;
  pr: DerivedPrState | null;
}

/**
 * Stable, deterministic 16-hex-char hash of the inputs that affect any
 * action's decision for a given ticket. If state changes (new commit, new
 * comment surfaced via updatedAt, classification gained, PR status moved),
 * the fingerprint changes and Gary is free to act again on that ticket.
 *
 * Action type is part of the SQLite cache key (see hasActedOn) so the
 * fingerprint itself doesn't need it.
 */
export function fingerprintDerivedState(state: DerivedState): string {
  const canonical = JSON.stringify({
    issueId: state.issueId,
    issueUpdatedAt: state.issueUpdatedAt,
    classification: state.classification?.classification ?? null,
    pr: state.pr
      ? {
          number: state.pr.number,
          state: state.pr.state,
          merged: state.pr.merged,
          isDraft: state.pr.isDraft,
          headSha: state.pr.headSha,
          ciStatus: state.pr.ciStatus,
        }
      : null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
