/** Operator-only settlement of one engineering-acceptance aggregate hold.
 *
 * The hold keeps exactly its settled ledger charge and retires the rest as unused
 * authorization. Order: verify everything read-only, take the shared
 * `<aggregate>.admission.lock`, write immutable audit records, close the spend
 * ticket (so no continuation authority can spend again), recheck the charges,
 * then atomically replace the aggregate with one entry changed and totals moved.
 * A crash leaves the lock and audits in place; a rerun resumes only the same
 * transition. No HTTP, no enrollment, no refund of any request reservation. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aggregateJson as J, RECONCILED_STATE, reconciledHoldRetirement, type AggregateRecord, type AggregateJson } from './engineering-standing-funding.ts';
import { openSpendLedger } from '../spend.ts';

export const ACCEPTANCE_RECONCILED_REASON = 'acceptance_hold_reconciled';
function fail(code: string): never { throw new Error('engineering_acceptance_reconciliation:' + code); }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export interface AcceptanceReconciliationOptions {
  aggregatePath: string; ledgerPath: string; holdId: string;
  /** Private (0700) directory for this operation's immutable audit records. */
  auditDir: string;
  /** Every engineering journal that ever ran against this allocation (v1..vN). */
  journalPaths: readonly string[];
  /** Continuation authority/claim files to record as evidence (hashed, never edited). */
  continuationFiles: readonly string[];
  apply: boolean; now: () => Date;
}
export interface AcceptanceReconciliationResult {
  applied: boolean; alreadyReconciled: boolean; holdId: string; campaignId: string; allocationId: string;
  amountMicros: number; chargedMicros: number; retiredMicros: number;
  aggregateBeforeSha256: string; aggregateAfterSha256: string; evidenceSha256: string;
  ticketState: string; runtimeHeldUsd: string; runtimeUnallocatedUsd: string; runtimeAuthorizationRetiredUsd: string;
}

function readAggregate(path: string) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o022)) fail('aggregate_metadata');
  const bytes = readFileSync(path), parsed = J.parse(bytes.toString('utf8'));
  if (!J.isRecord(parsed)) fail('aggregate_not_object');
  const pool = J.money(parsed.runtimePoolUsd); J.totals(parsed, pool);
  return { bytes, hash: sha(bytes), parsed, pool, mode: st.mode & 0o777, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
}

/** Read-only proof of the ledger and journals for this hold's allocation. */
function evidence(o: AcceptanceReconciliationOptions, campaignId: string, allocationId: string) {
  const db = new Database(o.ledgerPath, { readonly: true, create: false, strict: true });
  try {
    db.exec('BEGIN');
    const campaign = db.query('SELECT * FROM spend_campaigns WHERE id=?').get(campaignId) as Record<string, unknown> | null;
    const tickets = db.query('SELECT * FROM spend_tickets WHERE campaign_id=? ORDER BY ticket_id').all(campaignId) as Record<string, unknown>[];
    if (!campaign || tickets.length !== 1 || tickets[0]!.ticket_id !== allocationId) fail('ledger_binding');
    const attempts = db.query('SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id').all(allocationId) as Record<string, unknown>[];
    if (attempts.some(a => a.state !== 'settled')) fail('unsettled_attempt');
    const receipts = db.query('SELECT r.* FROM spend_receipts r JOIN spend_attempts a ON a.id=r.attempt_id WHERE a.ticket_id=? ORDER BY r.attempt_id').all(allocationId);
    if (hasTable(db, 'standing_engineering_conversation_leases')
        && db.query('SELECT 1 FROM standing_engineering_conversation_leases WHERE ticket_id=? AND end_attempt_id IS NULL').get(allocationId)) fail('open_lease');
    const ticket = tickets[0]!;
    if (!(ticket.state === 'active' && ticket.terminal_reason === null)
        && !(ticket.state === 'closed' && ticket.terminal_reason === ACCEPTANCE_RECONCILED_REASON)) fail('ticket_state');
    const charged = attempts.reduce((n, a) => n + Number(a.charged_micros), 0);
    const journals = o.journalPaths.map(path => {
      const j = new Database(path, { readonly: true, create: false });
      try {
        const open = hasTable(j, 'engineering_tasks')
          ? (j.query("SELECT COUNT(*) n FROM engineering_tasks WHERE state NOT IN ('completed','blocked','paused') OR cleanup_confirmed<>1").get() as { n: number }).n : 0;
        const ingress = hasTable(j, 'engineering_ingress_requests')
          ? (j.query("SELECT COUNT(*) n FROM engineering_ingress_requests WHERE stage NOT IN ('completed','blocked','paused')").get() as { n: number }).n : 0;
        const runs = hasTable(j, 'engineering_runtime_runs')
          ? (j.query("SELECT COUNT(*) n FROM engineering_runtime_runs WHERE launch_state<>'closed'").get() as { n: number }).n : 0;
        if (open || ingress || runs) fail('journal_in_flight:' + path);
        return { path, terminal: true };
      } finally { j.close(); }
    });
    const continuation = o.continuationFiles.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    db.exec('COMMIT');
    // The ticket's terminal state is excluded so the proof is stable across the close step.
    const proof = { campaign, ticket: { ...ticket, state: undefined, terminal_reason: undefined }, attempts, receipts, chargedMicros: charged, journals, continuation };
    return { proof, proofHash: sha(JSON.stringify(proof)), charged, ticketState: String(ticket.state) };
  } finally { db.close(); }
}

function transition(source: AggregateRecord, index: number, chargedMicros: number, retiredMicros: number,
  operation: { id: string; auditRecord: string; evidenceSha256: string }, timestamp: string): string {
  const pool = J.money(source.runtimePoolUsd), sums = J.totals(source, pool);
  const allocations = (source.runtimeAllocations as AggregateJson[]).slice(), entry = allocations[index] as AggregateRecord;
  const retired = BigInt(retiredMicros) * 1000n;
  const settled: AggregateRecord = { ...entry, state: RECONCILED_STATE, retainedAmountUsd: J.number(J.usdLexeme(BigInt(chargedMicros) * 1000n)),
    retiredUnusedAuthorizationUsd: J.number(J.usdLexeme(retired)), originalState: entry.state!,
    reconciliation: { id: operation.id, auditRecord: operation.auditRecord, evidenceSha256: operation.evidenceSha256,
      chargedMicros: J.number(String(chargedMicros)), retiredMicros: J.number(String(retiredMicros)), terminalReason: ACCEPTANCE_RECONCILED_REASON,
      semantics: 'Retains the settled ledger charge; retires only unused authorization. No request reservation refunded; the spend ticket is closed and all history is unchanged.' } };
  allocations[index] = settled;
  const next: AggregateRecord = { ...source, runtimeAllocations: allocations,
    runtimeCommittedOrHeldUsd: J.number(J.usdLexeme(sums.held - retired)), runtimeUnallocatedUsd: J.number(J.usdLexeme(sums.remaining + retired)),
    totalCommittedOrHeldUsd: J.number(J.usdLexeme(J.money(source.totalCommittedOrHeldUsd) - retired)),
    runtimeAuthorizationRetiredUsd: J.number(J.usdLexeme(sums.retired + retired)), bookkeepingUpdatedAt: timestamp };
  J.totals(next, pool);
  if (reconciledHoldRetirement(entry, settled) !== retired) fail('transition_shape');
  return J.encode(next) + '\n';
}

function writeNew(path: string, bytes: string | Buffer, mode = 0o600): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
}
function writeOnce(path: string, bytes: string): void {
  try { writeNew(path, bytes); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (readFileSync(path, 'utf8') !== bytes) fail('audit_record_conflict');
  }
}
function syncDir(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }

export function reconcileEngineeringAcceptanceHold(o: AcceptanceReconciliationOptions): AcceptanceReconciliationResult {
  const before = readAggregate(o.aggregatePath);
  const allocations = before.parsed.runtimeAllocations as AggregateJson[];
  const index = allocations.findIndex(v => J.isRecord(v) && v.id === o.holdId);
  if (index < 0 || allocations.findIndex((v, i) => i !== index && J.isRecord(v) && v.id === o.holdId) >= 0) fail('hold_not_found');
  const entry = allocations[index] as AggregateRecord;
  const admission = J.isRecord(entry.admission) ? entry.admission : fail('hold_admission');
  const campaignId = typeof admission.campaignId === 'string' ? admission.campaignId : fail('hold_admission');
  const allocationId = typeof admission.allocationId === 'string' ? admission.allocationId : fail('hold_admission');
  const operationId = o.holdId.replace(/[^A-Za-z0-9_.-]/g, '_') + '-reconciliation';
  const paths = Object.fromEntries(['before', 'after', 'evidence', 'intent'].map(n => [n, join(o.auditDir, operationId + '.' + n + '.json')])) as Record<string, string>;
  const amountMicros = Number(J.money(entry.amountUsd) / 1000n);
  const proof = evidence(o, campaignId, allocationId);
  if (proof.charged > amountMicros) fail('charge_exceeds_hold');
  const retiredMicros = amountMicros - proof.charged;
  const alreadyReconciled = entry.state === RECONCILED_STATE;
  let afterText: string, originalHash = before.hash;
  if (alreadyReconciled) {
    // Only this operation's own completed transition counts as done.
    const original = readFileSync(paths.before!), after = readFileSync(paths.after!);
    if (sha(after) !== before.hash || !J.isRecord(entry.reconciliation) || entry.reconciliation.id !== operationId) fail('reconciled_by_another_operation');
    originalHash = sha(original); afterText = after.toString('utf8');
  } else {
    if (entry.state !== 'held_for_engineering_acceptance' || J.money(entry.retainedAmountUsd) !== J.money(entry.amountUsd)
        || J.money(entry.retiredUnusedAuthorizationUsd) !== 0n || J.money(entry.retainedUnknownCostsUsd) !== 0n
        || Object.hasOwn(entry, 'originalState') || Object.hasOwn(entry, 'reconciliation')) fail('hold_not_unreconciled');
    let prepared: string | undefined;
    try { prepared = readFileSync(paths.after!, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const timestamp = prepared ? String((JSON.parse(prepared) as { bookkeepingUpdatedAt: string }).bookkeepingUpdatedAt) : o.now().toISOString();
    afterText = transition(before.parsed, index, proof.charged, retiredMicros, { id: operationId, auditRecord: paths.intent!, evidenceSha256: proof.proofHash }, timestamp);
    if (prepared !== undefined && prepared !== afterText) fail('prepared_audit_conflict');
  }
  const after = J.parse(afterText) as AggregateRecord, pool = J.money(after.runtimePoolUsd), sums = J.totals(after, pool);
  const result: AcceptanceReconciliationResult = { applied: false, alreadyReconciled, holdId: o.holdId, campaignId, allocationId, amountMicros,
    chargedMicros: proof.charged, retiredMicros, aggregateBeforeSha256: originalHash, aggregateAfterSha256: sha(afterText),
    evidenceSha256: proof.proofHash, ticketState: proof.ticketState,
    runtimeHeldUsd: J.usdLexeme(sums.held), runtimeUnallocatedUsd: J.usdLexeme(sums.remaining), runtimeAuthorizationRetiredUsd: J.usdLexeme(sums.retired) };
  if (!o.apply || (alreadyReconciled && proof.ticketState === 'closed')) return { ...result, applied: alreadyReconciled };

  const lockPath = o.aggregatePath + '.admission.lock', claim = JSON.stringify({ version: 1, pid: process.pid, claim: randomUUID(), operation: operationId }) + '\n';
  mkdirSync(lockPath, { mode: 0o700 }); const lockStat = lstatSync(lockPath); syncDir(dirname(lockPath));
  writeNew(join(lockPath, 'claim.json'), claim);
  try {
    try { mkdirSync(o.auditDir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const ad = lstatSync(o.auditDir);
    if (!ad.isDirectory() || ad.isSymbolicLink() || ad.uid !== process.getuid?.() || (ad.mode & 0o077)) fail('unsafe_audit_directory');
    if (!alreadyReconciled) {
      writeOnce(paths.before!, before.bytes.toString('utf8')); writeOnce(paths.after!, afterText);
      writeOnce(paths.evidence!, JSON.stringify(proof.proof, null, 2) + '\n');
      writeOnce(paths.intent!, JSON.stringify({ schemaVersion: 1, operation: operationId, holdId: o.holdId, campaignId, allocationId,
        aggregatePath: o.aggregatePath, ledgerPath: o.ledgerPath, beforeSha256: before.hash, afterSha256: sha(afterText),
        evidenceSha256: proof.proofHash, chargedMicros: proof.charged, retiredMicros, terminalReason: ACCEPTANCE_RECONCILED_REASON,
        order: 'audits, close spend ticket, recheck charges, replace aggregate' }, null, 2) + '\n');
      syncDir(o.auditDir);
    }
    // Fence first: a closed ticket can never reserve again, whatever continuation authority exists.
    const ledger = openSpendLedger(o.ledgerPath);
    try { ledger.markTerminal(allocationId, ACCEPTANCE_RECONCILED_REASON); } finally { ledger.close(); }
    const recheck = evidence(o, campaignId, allocationId);
    if (recheck.proofHash !== proof.proofHash || recheck.ticketState !== 'closed') fail('evidence_changed_after_close');
    if (!alreadyReconciled) {
      const current = readAggregate(o.aggregatePath);
      if (current.hash !== before.hash || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) fail('aggregate_changed_before_commit');
      const temporary = o.aggregatePath + '.' + randomUUID() + '.tmp';
      try { writeNew(temporary, afterText, before.mode); renameSync(temporary, o.aggregatePath); syncDir(dirname(o.aggregatePath)); }
      finally { try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
      if (readAggregate(o.aggregatePath).hash !== sha(afterText)) fail('aggregate_verification_failed');
    }
    return { ...result, applied: true, ticketState: 'closed' };
  } finally {
    const current = lstatSync(lockPath);
    if (current.dev !== lockStat.dev || current.ino !== lockStat.ino || readFileSync(join(lockPath, 'claim.json'), 'utf8') !== claim) fail('lock_identity_changed');
    unlinkSync(join(lockPath, 'claim.json')); rmdirSync(lockPath); syncDir(dirname(lockPath));
  }
}
