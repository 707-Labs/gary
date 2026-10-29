import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../../src/spend.ts';
import { reconcileEngineeringAcceptanceHold, ACCEPTANCE_RECONCILED_REASON } from '../../src/hermes/engineering-acceptance-reconciliation.ts';
import { reconciledHoldRetirement, aggregateJson, assertReconciliationEvidence, reconciliationAuditDir } from '../../src/hermes/engineering-standing-funding.ts';

const roots: string[] = []; afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const HOLD = 'hermes-engineering-acceptance:run-01';
function fixture(charged = 624_900) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'acceptance-reconcile-'))); roots.push(root); chmodSync(root, 0o700);
  const aggregatePath = join(root, 'aggregate.json'), ledgerPath = join(root, 'spend.sqlite'), journalPath = join(root, 'engineering.sqlite');
  const aggregate = { schemaVersion: 2, totalCeilingUsd: 100, runtimePoolUsd: 60, other90HoldUsd: 30, bufferHoldUsd: 10,
    runtimeCommittedOrHeldUsd: 50, runtimeUnallocatedUsd: 10, totalCommittedOrHeldUsd: 90, runtimeUnknownHoldsUsd: 4.5, runtimeAuthorizationRetiredUsd: 0,
    runtimeAllocations: [
      { id: 'history', amountUsd: 39.35, retainedAmountUsd: 39.35, retiredUnusedAuthorizationUsd: 0, retainedUnknownCostsUsd: 4.5, admission: { kind: 'classifier_canary', commonfieldEarmarkMicros: 3000000 } },
      { id: HOLD, amountUsd: 5.65, state: 'held_for_engineering_acceptance', retainedAmountUsd: 5.65, retiredUnusedAuthorizationUsd: 0, retainedUnknownCostsUsd: 0,
        admission: { kind: 'hermes_engineering_acceptance', campaignId: 'run-01-campaign', allocationId: 'run-01-allocation' }, rule: 'One acceptance.' },
      { id: 'dm', amountUsd: 5, state: 'held_for_dm_conversation', retainedAmountUsd: 5, retiredUnusedAuthorizationUsd: 0, retainedUnknownCostsUsd: 0 }],
    bookkeepingUpdatedAt: '2026-10-12T00:00:00Z' };
  writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2) + '\n', { mode: 0o600 });
  const ledger = new SpendLedger(ledgerPath); ledger.createCampaign('run-01-campaign', 5.65); ledger.enrollTicket('run-01-campaign', 'run-01-allocation', 5.65); ledger.close();
  const db = new Database(ledgerPath);
  db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('run-01-allocation','deepseek','deepseek-v4-pro',8192,1416561,?,'settled')").run(charged);
  db.close();
  const journal = new Database(journalPath);
  journal.exec("CREATE TABLE engineering_tasks(task_id TEXT,state TEXT,cleanup_confirmed INTEGER); INSERT INTO engineering_tasks VALUES('t','completed',1);"); journal.close();
  const options = (apply: boolean) => ({ aggregatePath, ledgerPath, holdId: HOLD, auditDir: join(root, 'audit'), journalPaths: [journalPath],
    continuationFiles: [], apply, now: () => new Date('2026-10-29T00:00:00Z') });
  return { root, aggregatePath, ledgerPath, journalPath, options };
}
const ticket = (path: string) => { const db = new Database(path, { readonly: true }); try { return db.query("SELECT state,terminal_reason FROM spend_tickets WHERE ticket_id='run-01-allocation'").get(); } finally { db.close(); } };

test('dry run computes the settlement and writes nothing', () => {
  const f = fixture(), before = readFileSync(f.aggregatePath);
  const r = reconcileEngineeringAcceptanceHold(f.options(false));
  expect(r).toMatchObject({ applied: false, chargedMicros: 624_900, retiredMicros: 5_025_100, amountMicros: 5_650_000,
    runtimeHeldUsd: '44.9749', runtimeUnallocatedUsd: '15.0251', runtimeAuthorizationRetiredUsd: '5.0251' });
  expect(readFileSync(f.aggregatePath)).toEqual(before); expect(existsSync(join(f.root, 'audit'))).toBe(false);
  expect(ticket(f.ledgerPath)).toEqual({ state: 'active', terminal_reason: null });
});

test('apply changes exactly one entry, conserves totals, closes the ticket, releases the lock and is idempotent', () => {
  const f = fixture(), before = JSON.parse(readFileSync(f.aggregatePath, 'utf8'));
  const r = reconcileEngineeringAcceptanceHold(f.options(true));
  expect(r).toMatchObject({ applied: true, ticketState: 'closed' });
  const after = JSON.parse(readFileSync(f.aggregatePath, 'utf8'));
  expect(after.runtimeAllocations[0]).toEqual(before.runtimeAllocations[0]); expect(after.runtimeAllocations[2]).toEqual(before.runtimeAllocations[2]);
  expect(after.runtimeAllocations[1]).toMatchObject({ state: 'reconciled_retained_charge', originalState: 'held_for_engineering_acceptance',
    amountUsd: 5.65, retainedAmountUsd: 0.6249, retiredUnusedAuthorizationUsd: 5.0251, rule: 'One acceptance.' });
  expect(after.runtimeAllocations[1].retainedAmountUsd + after.runtimeAllocations[1].retiredUnusedAuthorizationUsd).toBeCloseTo(5.65, 9);
  expect([after.runtimeCommittedOrHeldUsd, after.runtimeUnallocatedUsd, after.totalCommittedOrHeldUsd, after.runtimeAuthorizationRetiredUsd, after.runtimeUnknownHoldsUsd])
    .toEqual([44.9749, 15.0251, 84.9749, 5.0251, 4.5]);
  expect(ticket(f.ledgerPath)).toEqual({ state: 'closed', terminal_reason: ACCEPTANCE_RECONCILED_REASON });
  expect(existsSync(f.aggregatePath + '.admission.lock')).toBe(false);
  expect(readdirSync(join(f.root, 'audit')).sort()).toEqual(['before', 'after', 'evidence', 'intent'].map(n => 'hermes-engineering-acceptance_run-01-reconciliation.' + n + '.json').sort());
  const settled = readFileSync(f.aggregatePath);
  expect(reconcileEngineeringAcceptanceHold(f.options(true))).toMatchObject({ applied: true, alreadyReconciled: true });
  expect(readFileSync(f.aggregatePath)).toEqual(settled);
  // The standing guard recognises exactly this transition and nothing else.
  const v = aggregateJson.parse(JSON.stringify(before.runtimeAllocations[1])), w = aggregateJson.parse(readFileSync(f.aggregatePath, 'utf8'));
  const entry = (w as any).runtimeAllocations[1];
  expect(reconciledHoldRetirement(v, entry)).toBe(5_025_100_000n);
  expect(reconciledHoldRetirement(v, { ...entry, rule: 'Changed.' })).toBeNull();
  expect(reconciledHoldRetirement(v, { ...entry, retainedAmountUsd: aggregateJson.number('0.5') })).toBeNull();
});

test('refuses unsettled attempts, in-flight journals, extra tickets, a held lock and non-acceptance holds without writing', () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    ['unsettled', f => { const db = new Database(f.ledgerPath); db.exec("UPDATE spend_attempts SET state='unknown'"); db.close(); }, 'unsettled_attempt'],
    ['journal', f => { const db = new Database(f.journalPath); db.exec("INSERT INTO engineering_tasks VALUES('x','running',0)"); db.close(); }, 'journal_in_flight'],
    ['ticket', f => { const db = new Database(f.ledgerPath); db.exec("INSERT INTO spend_tickets(ticket_id,campaign_id,cap_micros,draft_pr) VALUES('run-01-second','run-01-campaign',1,0)"); db.close(); }, 'ledger_binding'],
    ['lock', f => { mkdirSync(f.aggregatePath + '.admission.lock', { mode: 0o700 }); }, 'admission_lock_held'],
  ];
  for (const [, mutate, error] of cases) {
    const f = fixture(); mutate(f); const before = readFileSync(f.aggregatePath);
    expect(() => reconcileEngineeringAcceptanceHold(f.options(true))).toThrow(error);
    expect(readFileSync(f.aggregatePath)).toEqual(before);
  }
  const f = fixture();
  expect(() => reconcileEngineeringAcceptanceHold({ ...f.options(true), holdId: 'dm' })).toThrow();
  expect(ticket(f.ledgerPath)).toEqual({ state: 'active', terminal_reason: null });
});

function settled() {
  const f = fixture(), original = JSON.parse(readFileSync(f.aggregatePath, 'utf8')).runtimeAllocations[1];
  const auditDir = reconciliationAuditDir(f.ledgerPath); mkdirSync(join(f.root, 'budget'), { mode: 0o700 });
  reconcileEngineeringAcceptanceHold({ ...f.options(true), auditDir });
  const read = () => (aggregateJson.parse(readFileSync(f.aggregatePath, 'utf8')) as any).runtimeAllocations[1];
  return { f, before: aggregateJson.parse(JSON.stringify(original)) as any, read, auditDir };
}
test('the standing guard accepts a settled hold only with matching ledger and audit evidence', () => {
  const s = settled(), check = (entry: any) => () => assertReconciliationEvidence(s.before, entry, s.f.ledgerPath);
  expect(check(s.read())).not.toThrow();
  for (const [retained, retired] of [['0', '5.65'], ['0.3', '5.35']]) {
    const e = s.read(); e.retainedAmountUsd = aggregateJson.number(retained); e.retiredUnusedAuthorizationUsd = aggregateJson.number(retired);
    expect(check(e)).toThrow('reconciliation_ledger');
  }
  const ledger = (sql: string) => { const db = new Database(s.f.ledgerPath); db.exec(sql); db.close(); };
  ledger("UPDATE spend_tickets SET terminal_reason='other' WHERE ticket_id='run-01-allocation'"); expect(check(s.read())).toThrow('reconciliation_ledger');
  ledger("UPDATE spend_tickets SET state='active',terminal_reason=NULL WHERE ticket_id='run-01-allocation'"); expect(check(s.read())).toThrow('reconciliation_ledger');
  ledger("UPDATE spend_tickets SET state='closed',terminal_reason='acceptance_hold_reconciled' WHERE ticket_id='run-01-allocation'"); expect(check(s.read())).not.toThrow();
  const intent = join(s.auditDir, 'hermes-engineering-acceptance_run-01-reconciliation.intent.json'), text = readFileSync(intent, 'utf8');
  writeFileSync(intent, text.replace('"chargedMicros": 624900', '"chargedMicros": 624901'), { mode: 0o600 }); expect(check(s.read())).toThrow('reconciliation_audit');
  rmSync(intent); expect(check(s.read())).toThrow();
  writeFileSync(intent, text, { mode: 0o600 }); expect(check(s.read())).not.toThrow();
  const afterPath = intent.replace('.intent.json', '.after.json'); writeFileSync(afterPath, readFileSync(afterPath, 'utf8') + ' ', { mode: 0o600 });
  expect(check(s.read())).toThrow('reconciliation_audit');
});
test('a rerun resumes a lock left by a crashed run of the same operation, never another one', () => {
  const f = fixture(), lock = f.aggregatePath + '.admission.lock';
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'claim.json'), JSON.stringify({ version: 1, pid: 999_999_999, claim: 'x', operation: 'other-operation' }) + '\n', { mode: 0o600 });
  expect(() => reconcileEngineeringAcceptanceHold(f.options(true))).toThrow('admission_lock_held');
  writeFileSync(join(lock, 'claim.json'), JSON.stringify({ version: 1, pid: process.pid, claim: 'x', operation: 'hermes-engineering-acceptance_run-01-reconciliation' }) + '\n', { mode: 0o600 });
  expect(() => reconcileEngineeringAcceptanceHold(f.options(true))).toThrow('admission_lock_held'); // owner still alive
  writeFileSync(join(lock, 'claim.json'), JSON.stringify({ version: 1, pid: 999_999_999, claim: 'x', operation: 'hermes-engineering-acceptance_run-01-reconciliation' }) + '\n', { mode: 0o600 });
  expect(reconcileEngineeringAcceptanceHold(f.options(true))).toMatchObject({ applied: true });
  expect(existsSync(lock)).toBe(false);
});
