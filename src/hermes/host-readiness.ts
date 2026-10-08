/** A host canary is ready only after native completion AND real checked publication. */
import { createHash } from 'node:crypto';
import type { CodePublicationReceipt } from '../handlers/code.ts';
import type { DB } from '../state/db.ts';
import type { SpendLedger } from '../spend.ts';
import type { CodeActionAdmission } from './canonical-admission.ts';
import type { HermesActivationBinding } from './activation.ts';

export interface HostReadiness { ready: boolean; hermesCanarySucceeded: boolean; receiptId: string }
export interface CanaryReadinessOptions {
  db: DB; ledger: SpendLedger; activation: HermesActivationBinding; issueId: string; repo: string;
}
interface Publication { actionId: string; fingerprint: string; ownerEpoch: string; receipt: CodePublicationReceipt }
const NOT_READY: HostReadiness = Object.freeze({ ready: false, hermesCanarySucceeded: false, receiptId: 'pending' });

export function createCanaryReadiness(options: CanaryReadinessOptions) {
  let publication: Publication | undefined;
  function recordPublication(action: CodeActionAdmission, receipt: CodePublicationReceipt): void {
    action.assertActive();
    if (action.ledger !== options.ledger || action.ticketId !== options.issueId || action.repo !== options.repo
        || receipt.issueId !== options.issueId || receipt.repo !== options.repo) throw new Error('publication_readiness_binding_mismatch');
    publication = { actionId: action.actionId, fingerprint: action.fingerprint, ownerEpoch: action.ownerEpoch, receipt: structuredClone(receipt) };
  }
  function check(): HostReadiness {
    try {
      if (!publication) return NOT_READY;
      const { actionId, fingerprint, ownerEpoch, receipt } = publication;
      const native = options.activation.getHealthEvidence().find(e => e.actionId === actionId && e.ownerEpoch === ownerEpoch
        && e.ticketId === options.issueId && e.runtime === 'hermes' && e.terminalStatus === 'finished' && e.traceClosed);
      if (!native) return NOT_READY;
      const row = options.db.query<{ id: number; state_fingerprint: string; owner_epoch: string; provider: string; model: string }, [string, string]>(
        `SELECT a.id,a.state_fingerprint,a.provider,a.model,o.owner_epoch FROM actions a
         JOIN hermes_action_owners o ON o.action_id=a.id
         WHERE a.id=? AND a.ticket_linear_id=? AND a.action_type='start_coding'
           AND a.completed_at IS NOT NULL AND a.success=1 AND a.outcome='pr_opened'`).get(actionId, options.issueId);
      const latest = options.db.query<{ id: number }, [string]>("SELECT id FROM actions WHERE ticket_linear_id=? AND action_type='start_coding' ORDER BY id DESC LIMIT 1").get(options.issueId);
      const active = options.db.query<{ n: number }, []>('SELECT count(*) AS n FROM actions WHERE completed_at IS NULL').get();
      if (!row || row.state_fingerprint !== fingerprint || row.owner_epoch !== ownerEpoch || String(latest?.id) !== actionId || active?.n !== 0
          || row.provider !== 'deepseek' || row.model !== 'deepseek-v4-pro') return NOT_READY;
      const allocation = options.ledger.status(options.issueId);
      if (!allocation || allocation.state !== 'closed' || allocation.terminalReason !== 'pr_opened'
          || !allocation.draftPr || allocation.unknownAttempts !== 0 || allocation.attemptCount < 1) return NOT_READY;
      const { requiredCheck, review, publication: published } = receipt;
      const head = published.remoteHeadSha;
      if (!receipt.admittedRuntime || !receipt.draft || !requiredCheck.passed || requiredCheck.exitCode !== 0 || requiredCheck.timedOut
          || requiredCheck.command !== 'bun run check' || review.verdict !== 'approve'
          || receipt.postRebaseCheck === 'incomplete' || !head || !/^[a-f0-9]{40}$/.test(head)) return NOT_READY;
      // Observations are not an isolation claim: any missing/changed/dirty snapshot
      // blocks notification instead of equating an old review with the new head.
      if ([requiredCheck.afterCheck, review.afterApproval, published.beforePush, published.afterPush]
        .some(observation => observation.headSha !== head || observation.worktreeClean !== true)) return NOT_READY;
      const pr = options.db.query<{ repo: string; pr_number: number; branch: string; closed_at: string | null; merged: number }, [string, string, number]>(
        'SELECT repo,pr_number,branch,closed_at,merged FROM prs WHERE ticket_linear_id=? AND repo=? AND pr_number=?')
        .get(options.issueId, options.repo, receipt.prNumber);
      if (!pr || pr.branch !== receipt.branch || pr.closed_at !== null || pr.merged !== 0) return NOT_READY;
      const evidence = { actionId, fingerprint, ownerEpoch, nativeRequestId: native.requestId, head, repo: pr.repo, prNumber: pr.pr_number };
      return { ready: true, hermesCanarySucceeded: true,
        receiptId: 'sha256:' + createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
    } catch { return NOT_READY; }
  }
  return Object.freeze({ recordPublication, check });
}
