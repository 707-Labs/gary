/** Reuses Gary's action row as the durable fence; creates no queue or allocation. */
import { randomUUID } from 'node:crypto';
import type { DB } from '../state/db.ts';
import type { SpendLedger } from '../spend.ts';
import type { AssignedIssue } from '../adapters/linear.ts';

export interface CodeActionAdmission {
  actionId: string;
  ticketId: string;
  fingerprint: string;
  ownerEpoch: string;
  issue: AssignedIssue;
  provider: string;
  model: string;
  repo: string;
  ledger: SpendLedger;
  assertActive(): void;
}

export function bindCanonicalCodeAction(options: {
  db: DB; ledger: SpendLedger; actionId: number; fingerprint: string;
  issue: AssignedIssue; provider: string; model: string; repo: string;
}): { admission: CodeActionAdmission; close(): void } {
  options = {...options};
  let closed = false;
  const issue = Object.freeze(structuredClone(options.issue));
  const ownerEpoch = randomUUID();
  const assertActive = () => {
    if (closed || options.ledger.status(issue.id)?.state !== 'active') throw new Error('canonical_action_inactive');
    const row = options.db.query<{id:number;ticket_linear_id:string;state_fingerprint:string;action_type:string;completed_at:string|null;provider:string;model:string},[string]>(
      'SELECT id,ticket_linear_id,state_fingerprint,action_type,completed_at,provider,model FROM actions WHERE ticket_linear_id = ? ORDER BY id DESC LIMIT 1',
    ).get(issue.id);
    const owner = options.db.query<{owner_epoch:string},[number]>('SELECT owner_epoch FROM hermes_action_owners WHERE action_id = ?').get(options.actionId);
    if (!owner || owner.owner_epoch !== ownerEpoch || !row || row.id !== options.actionId || row.ticket_linear_id !== issue.id
      || row.state_fingerprint !== options.fingerprint || row.action_type !== 'start_coding'
      || row.completed_at !== null || row.provider !== options.provider || row.model !== options.model) {
      throw new Error('canonical_action_superseded');
    }
  };
  const claimed = options.db.query('INSERT OR IGNORE INTO hermes_action_owners (action_id, owner_epoch) VALUES (?, ?)').run(options.actionId,ownerEpoch);
  if (claimed.changes !== 1) throw new Error('canonical_action_already_claimed');
  assertActive();
  return { admission: Object.freeze({ actionId:String(options.actionId), ticketId:issue.id,
    fingerprint:options.fingerprint, ownerEpoch, issue, provider:options.provider, model:options.model, repo:options.repo,
    ledger:options.ledger, assertActive }), close() { closed = true; } };
}
