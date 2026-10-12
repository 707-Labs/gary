/** Operator reconciliation only. History is retained; terminal tickets cannot
 * spend again. No model tool, startup recycling, budget increase or refill. */
import { Database } from 'bun:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fingerprintJson } from './audit-trace.ts';
import type { StandingEngineeringBudgetAuthority } from './engineering-standing-budget.ts';
export const STANDING_CHAT_TICKET = 'local:hermes-dm-20261008-tanner';
const hash = (value: unknown) => fingerprintJson(value).sha256;
const fail = (code: string): never => { throw new Error('engineering_standing_reconciliation:' + code); };
const money = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exists = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const attempts = (db: Database, ticket: string) => db.query('SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id').all(ticket) as any[];
const receipts = (db: Database, ticket: string) => db.query(`SELECT r.* FROM spend_receipts r JOIN spend_attempts x ON x.id=r.attempt_id WHERE x.ticket_id=? ORDER BY r.attempt_id`).all(ticket) as any[];
const attemptReceipts = (db: Database, id: number) => db.query('SELECT * FROM spend_receipts WHERE attempt_id=?').all(id) as any[];
function fileIdentity(path: string) {
  if (!isAbsolute(path) || realpathSync(path) !== path) fail('journal_path');
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.mode & 0o022) fail('journal_metadata');
  return {dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode & 0o777};
}
export function initializeStandingReconciliation(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS standing_engineering_releases(
    allocation_id TEXT PRIMARY KEY REFERENCES spend_tickets(ticket_id),pool_id TEXT NOT NULL,
    proof_json TEXT NOT NULL,proof_sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS standing_engineering_auxiliary_charges(
    pool_id TEXT NOT NULL,attempt_id INTEGER NOT NULL REFERENCES spend_attempts(id),proof_json TEXT NOT NULL,proof_sha256 TEXT NOT NULL,
    PRIMARY KEY(pool_id,attempt_id));
    CREATE TABLE IF NOT EXISTS standing_engineering_conversation_leases(
    lease_id TEXT PRIMARY KEY,pool_id TEXT NOT NULL,ticket_id TEXT NOT NULL,start_attempt_id INTEGER NOT NULL,
    end_attempt_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(end_attempt_id IS NULL OR end_attempt_id>=start_attempt_id));
    CREATE TABLE IF NOT EXISTS standing_engineering_conversation_tasks(
    allocation_id TEXT PRIMARY KEY REFERENCES spend_tickets(ticket_id),lease_id TEXT NOT NULL REFERENCES standing_engineering_conversation_leases(lease_id));`);
}
export function assertStandingReconciliationSchema(db: Database): void {
  if (!['standing_engineering_releases','standing_engineering_auxiliary_charges','standing_engineering_conversation_leases','standing_engineering_conversation_tasks'].every(t=>exists(db,t))) fail('not_initialized');
}
/** Pure read, including unresolved conversation reservations at their full cost. */
export function standingReconciliationAmounts(db: Database, a: StandingEngineeringBudgetAuthority): {released:number;auxiliary:number} {
  if (!exists(db,'standing_engineering_releases')) return {released:0,auxiliary:0};
  assertStandingReconciliationSchema(db);
  let released = 0;
  for (const row of db.query('SELECT * FROM standing_engineering_releases WHERE pool_id=?').all(a.poolId) as any[]) {
    const p = JSON.parse(row.proof_json), ticket = db.query('SELECT * FROM spend_tickets WHERE ticket_id=?').get(row.allocation_id) as any;
    const allocation = db.query('SELECT * FROM standing_engineering_allocations WHERE allocation_id=?').get(row.allocation_id) as any;
    const current = attempts(db,row.allocation_id);
    if (hash(p)!==row.proof_sha256 || p.kind!=='standing_terminal_reconciliation' || p.poolId!==a.poolId
      || p.allocationId!==row.allocation_id || p.authoritySha256!==a.authoritySha256 || !sha(p.operatorEvidenceSha256)
      || !ticket || ticket.state!=='closed' || ticket.terminal_reason!==p.terminalReason || ticket.campaign_id!==a.campaignId
      || !allocation || allocation.pool_id!==a.poolId || allocation.task_id!==p.taskId || allocation.cap_micros!==p.capMicros
      || p.capMicros!==a.taskCapMicros || !money(p.retainedMicros) || !money(p.releasedMicros)
      || p.retainedMicros+p.releasedMicros!==p.capMicros || hash(current)!==p.attemptSnapshotSha256
      || hash(receipts(db,row.allocation_id))!==p.receiptSnapshotSha256
      || current.some(x=>x.state!=='settled') || current.reduce((n,x)=>n+x.charged_micros,0)!==p.retainedMicros) fail('release_binding');
    released += p.releasedMicros;
  }
  for (const row of db.query('SELECT * FROM standing_engineering_auxiliary_charges WHERE pool_id=?').all(a.poolId) as any[]) {
    const p=JSON.parse(row.proof_json), attempt=db.query('SELECT * FROM spend_attempts WHERE id=?').get(row.attempt_id) as any;
    if (hash(p)!==row.proof_sha256 || p.kind!=='standing_auxiliary_charge' || p.poolId!==a.poolId
      || p.authoritySha256!==a.authoritySha256 || !sha(p.operatorEvidenceSha256) || !attempt || attempt.ticket_id!==STANDING_CHAT_TICKET
      || p.attemptId!==row.attempt_id || attempt.state!=='settled' || hash(attempt)!==p.attemptSnapshotSha256
      || hash(attemptReceipts(db,row.attempt_id))!==p.receiptSnapshotSha256) fail('auxiliary_binding');
  }
  const auxiliary=(db.query(`SELECT COALESCE(SUM(x.charged_micros),0) n FROM spend_attempts x WHERE
    EXISTS(SELECT 1 FROM standing_engineering_auxiliary_charges a WHERE a.pool_id=? AND a.attempt_id=x.id)
    OR EXISTS(SELECT 1 FROM standing_engineering_conversation_leases l WHERE l.pool_id=? AND l.ticket_id=x.ticket_id
      AND x.id>l.start_attempt_id AND (l.end_attempt_id IS NULL OR x.id<=l.end_attempt_id))`).get(a.poolId,a.poolId) as any).n;
  if (![released,auxiliary].every(money)) fail('amount');
  return {released,auxiliary};
}
export function retainStandingAuxiliaryCharges(db: Database, a: StandingEngineeringBudgetAuthority,
  ids: readonly number[], evidence: string): void {
  assertStandingReconciliationSchema(db);
  if (!sha(evidence) || !ids.length || ids.length>1024 || new Set(ids).size!==ids.length || ids.some(n=>!Number.isSafeInteger(n)||n<1)) fail('auxiliary_input');
  for (const id of ids) {
    const attempt=db.query('SELECT * FROM spend_attempts WHERE id=?').get(id) as any;
    if (!attempt || attempt.ticket_id!==STANDING_CHAT_TICKET || attempt.state!=='settled') fail('auxiliary_unresolved');
    const receipt=attemptReceipts(db,id);if(receipt.length!==1||receipt[0].reason!=='accepted')fail('auxiliary_receipt');
    const old=db.query('SELECT proof_json FROM standing_engineering_auxiliary_charges WHERE pool_id=? AND attempt_id=?').get(a.poolId,id) as any;
    if (old) { if(JSON.parse(old.proof_json).attemptSnapshotSha256!==hash(attempt))fail('auxiliary_changed');continue; }
    const p={version:1,kind:'standing_auxiliary_charge',poolId:a.poolId,attemptId:id,
      authoritySha256:a.authoritySha256,attemptSnapshotSha256:hash(attempt),receiptSnapshotSha256:hash(receipt),operatorEvidenceSha256:evidence};
    db.query('INSERT INTO standing_engineering_auxiliary_charges VALUES(?,?,?,?)').run(a.poolId,id,JSON.stringify(p),hash(p));
  }
}
/** Called inside the canonical ledger IMMEDIATE transaction, with a pinned
 * journal attached. Its writer lock keeps cleanup/spec observations stable. */
export function reconcileStandingTerminal(db: Database, a: StandingEngineeringBudgetAuthority,
  taskId: string, journalIdentity: unknown, evidence: string): any {
  assertStandingReconciliationSchema(db);
  if (!sha(evidence)) fail('operator_evidence');
  const allocation=db.query('SELECT * FROM standing_engineering_allocations WHERE pool_id=? AND task_id=?').get(a.poolId,taskId) as any;
  if (!allocation) fail('task_binding');
  const old=db.query('SELECT * FROM standing_engineering_releases WHERE allocation_id=?').get(allocation.allocation_id) as any;
  if (old) { standingReconciliationAmounts(db,a);return JSON.parse(old.proof_json); }
  const task=db.query('SELECT * FROM standing_terminal.engineering_tasks WHERE task_id=?').get(taskId) as any;
  if (!task || !['completed','blocked'].includes(task.state) || task.cleanup_confirmed!==1) fail('terminal_cleanup_required');
  const spec=JSON.parse(task.spec_json);
  if (hash(spec)!==task.spec_hash || spec.taskId!==taskId || spec.requestId!==allocation.request_id
      || spec.allocationId!==allocation.allocation_id) fail('terminal_binding');
  const cleanup=db.query('SELECT receipt_id FROM standing_terminal.engineering_cleanup_proofs WHERE task_id=? AND session_id=? AND owner_epoch=? ORDER BY receipt_id')
    .all(taskId,task.session_id,task.owner_epoch) as any[];
  const ingress=db.query('SELECT * FROM standing_terminal.engineering_ingress_requests WHERE request_id=?').get(allocation.request_id) as any;
  const final=ingress?.final_json?JSON.parse(ingress.final_json):null;
  if (!cleanup.length || !final || final.taskId!==taskId || final.requestId!==allocation.request_id
    || final.phase!=='final' || final.status!==task.state || ingress.stage!==task.state) fail('terminal_receipt_required');
  const ticket=db.query('SELECT * FROM spend_tickets WHERE ticket_id=?').get(allocation.allocation_id) as any;
  if (!ticket || !['active','exhausted','closed'].includes(ticket.state) || ticket.cap_micros!==a.taskCapMicros || ticket.campaign_id!==a.campaignId) fail('ticket_binding');
  const snapshot=attempts(db,allocation.allocation_id);
  if(snapshot.some(x=>x.state!=='settled'))fail('unresolved_attempts');
  if(exists(db,'engineering_model_requests'))fail('journal_alias');
  if(db.query("SELECT 1 FROM standing_terminal.sqlite_master WHERE name='engineering_model_requests'").get()
    && db.query("SELECT 1 FROM standing_terminal.engineering_model_requests WHERE allocation_id=? AND state<>'settled' LIMIT 1").get(allocation.allocation_id))fail('unresolved_model_requests');
  const receiptSnapshot=receipts(db,allocation.allocation_id);
  if(receiptSnapshot.length!==snapshot.length || receiptSnapshot.some(x=>x.reason!=='accepted'))fail('receipt_evidence');
  const retained=snapshot.reduce((n,x)=>n+x.charged_micros,0);
  if(!money(retained)||retained>ticket.cap_micros)fail('charges');
  const reason=ticket.terminal_reason??'standing_terminal_reconciled';
  if(!reason)fail('terminal_reason');
  const proof={version:1,kind:'standing_terminal_reconciliation',poolId:a.poolId,taskId,allocationId:allocation.allocation_id,
    authoritySha256:a.authoritySha256,capMicros:ticket.cap_micros,retainedMicros:retained,releasedMicros:ticket.cap_micros-retained,
    taskSpecSha256:task.spec_hash,cleanupReceiptIds:cleanup.map(x=>x.receipt_id),finalReceiptSha256:hash(final),journalIdentity,
    attemptSnapshotSha256:hash(snapshot),receiptSnapshotSha256:hash(receiptSnapshot),terminalReason:reason,operatorEvidenceSha256:evidence};
  db.query("UPDATE spend_tickets SET state='closed',terminal_reason=? WHERE ticket_id=? AND state IN ('active','exhausted')").run(reason,allocation.allocation_id);
  db.query('INSERT INTO standing_engineering_releases VALUES(?,?,?,?)').run(allocation.allocation_id,a.poolId,JSON.stringify(proof),hash(proof));
  standingReconciliationAmounts(db,a);return Object.freeze(proof);
}
export function withStandingTerminalJournal<T>(db: Database, path: string, ledgerPath: string, fn: (identity: unknown)=>T): T {
  if(path===ledgerPath)fail('journal_alias');const before=fileIdentity(path);
  db.query('ATTACH DATABASE ? AS standing_terminal').run(path);
  try { const result=fn(before);if(hash(fileIdentity(path))!==hash(before))fail('journal_changed');return result; }
  finally { db.exec('DETACH DATABASE standing_terminal'); }
}

/** Associated conversation charges count toward the immutable per-task cap too. */
export function standingTaskConversationCharge(db: Database, allocationId: string): number {
  if (!exists(db,'standing_engineering_conversation_tasks')) return 0;
  const row=db.query(`SELECT COALESCE(SUM(x.charged_micros),0) n FROM spend_attempts x
    WHERE EXISTS(SELECT 1 FROM standing_engineering_conversation_tasks t
      JOIN standing_engineering_conversation_leases l ON l.lease_id=t.lease_id
      WHERE t.allocation_id=? AND x.ticket_id=l.ticket_id AND x.id>l.start_attempt_id
      AND (l.end_attempt_id IS NULL OR x.id<=l.end_attempt_id))`).get(allocationId) as {n:number};
  if(!money(row.n))fail('task_conversation_amount');return row.n;
}
