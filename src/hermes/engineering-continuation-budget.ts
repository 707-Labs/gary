/** Explicit operator-only continuation of an existing engineering allocation.
 * No import-time I/O, enrollment, refund or mutation of predecessor records.
 * Apply writes an exclusive permanent claim and a separate immutable receipt.
 * A failed/partial apply is consumed; it is never replayed automatically. */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { assertEngineeringBudgetAdmission, type EngineeringBudgetBinding } from './engineering-budget.ts';
import { fingerprintJson } from './audit-trace.ts';

export interface EngineeringContinuationConfig {
  version: 1;
  original: EngineeringBudgetBinding;
  predecessorJournalPath: string;
  predecessorTaskId: string;
  receiptPath: string;
}
export interface EngineeringContinuationBinding extends EngineeringBudgetBinding {
  root: string;
  workspacesRoot: string;
  continuation: EngineeringContinuationConfig;
}
export interface EngineeringContinuationBaseline {
  readonly allocationId: string;
  readonly campaignId: string;
  readonly baselineAttemptCount: 3;
  readonly baselineChargedMicros: 114776;
  readonly receiptSha256: string;
  /** Read-only health guard; includes the original hold and immutable old task. */
  assertCurrent(): void;
  /** Verifies the exact canonical settled prefix, including complete receipts. */
  assertPrefix(db: Database): void;
  /** The new private journal is pinned; a replacement cannot reuse the claim. */
  assertJournal(db: Database): void;
}
const minted = new WeakSet<object>();
const CAP = 5_650_000, BASE_CHARGED = 114_776, BASE_COUNT = 3;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown) => sha(JSON.stringify(v));
function fail(code: string): never { throw new Error('engineering_continuation:' + code); }
function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) fail('path');
  const s = lstatSync(dirname(path));
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) fail('parent_metadata');
}
function identity(path: string, privateFile = false) {
  canonical(path); const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o022)
      || (privateFile && (s.mode & 0o777) !== 0o600) || realpathSync(path) !== path) fail('file_metadata');
  return { dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid, mode: s.mode, nlink: s.nlink };
}
function read(path: string): Buffer {
  const before = identity(path, true), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (s.dev !== before.dev || s.ino !== before.ino || s.size > 2 * 1024 * 1024) fail('file_changed');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== s.size || s.size !== after.size || s.ctimeMs !== after.ctimeMs || s.mtimeMs !== after.mtimeMs
        || digest(identity(path, true)) !== digest(before)) fail('file_changed');
    return bytes;
  } finally { closeSync(fd); }
}
function writeNew(path: string, bytes: Buffer): void {
  canonical(path); const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
const inside = (a: string, b: string) => { const r = relative(a, b); return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep); };
function binding(input: EngineeringContinuationBinding, prospective = false): EngineeringContinuationBinding {
  fingerprintJson(input); const o = structuredClone(input), p = o.continuation.original;
  const keys = ['aggregatePath','ledgerPath','auditDir','runId','grantId','campaignId','allocationId','sourceRevision','runtimeConfigSha256','authoritySha256'];
  if (o.continuation.version !== 1 || Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k))
      || o.runId !== o.grantId || p.runId === o.runId || p.grantId === o.grantId
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(o.runId)
      || o.allocationId !== p.allocationId || o.campaignId !== p.campaignId
      || o.ledgerPath !== p.ledgerPath || o.aggregatePath !== p.aggregatePath
      || !/^[a-f0-9]{40}$/.test(o.sourceRevision) || ![o.runtimeConfigSha256,o.authoritySha256].every(h => /^[a-f0-9]{64}$/.test(h))
      || o.auditDir !== join(o.root, 'budget-admission') || o.continuation.receiptPath !== join(o.auditDir, 'continuation.json')
      || o.continuation.predecessorJournalPath !== join(dirname(p.auditDir), 'engineering.sqlite')
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(o.continuation.predecessorTaskId)) fail('binding');
  for (const dir of [o.root, o.auditDir, o.workspacesRoot, p.auditDir]) {
    if (prospective && dir !== p.auditDir && !existsSync(dir)) {
      if (!isAbsolute(dir) || resolve(dir) !== dir) fail('path');
      let ancestor = dirname(dir); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || realpathSync(ancestor) !== ancestor || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) fail('prospective_parent');
      continue;
    }
    canonical(join(dir, 'placeholder')); const s = lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(dir) !== dir || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) fail('directory');
  }
  const roots = [o.root, o.workspacesRoot, dirname(p.auditDir)];
  if (roots.some((a, i) => roots.some((b, j) => i !== j && (inside(a, b) || inside(b, a))))) fail('root_overlap');
  return o;
}
function prefix(db: Database, allocationId: string) {
  const attempts = db.query('SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id LIMIT 3').all(allocationId) as Record<string, unknown>[];
  if (attempts.length !== BASE_COUNT || attempts.some(a => a.state !== 'settled' || a.provider !== 'deepseek' || a.model !== 'deepseek-v4-pro'
      || a.max_tokens !== 8192 || a.reserved_micros !== 1_416_561 || !Number.isSafeInteger(a.charged_micros) || Number(a.charged_micros) < 0)
      || attempts.reduce((n, a) => n + Number(a.charged_micros), 0) !== BASE_CHARGED) fail('baseline_attempts');
  const receipts = attempts.map(a => db.query('SELECT * FROM spend_receipts WHERE attempt_id=?').get(a.id as number) as Record<string, unknown> | null);
  if (receipts.some(r => !r || r.reason !== 'accepted' || typeof r.details_json !== 'string')) fail('baseline_receipts');
  return { attempts, receipts };
}
function withReadDb<T>(path: string, fn: (db: Database) => T): T {
  identity(path); const db = new Database(path, { readonly: true, strict: true, create: false });
  try { return db.transaction(() => fn(db))(); } finally { db.close(); }
}
function predecessor(o: EngineeringContinuationBinding, base: ReturnType<typeof prefix>) {
  const path = o.continuation.predecessorJournalPath, file = identity(path, true);
  const result = withReadDb(path, db => {
    const task = db.query('SELECT * FROM engineering_tasks WHERE task_id=?').get(o.continuation.predecessorTaskId) as Record<string, unknown> | null;
    if (!task || task.state !== 'blocked' || task.cleanup_confirmed !== 1 || typeof task.owner_epoch !== 'string' || typeof task.session_id !== 'string') fail('predecessor_not_cleanly_blocked');
    const spec = JSON.parse(task.spec_json as string);
    if (fingerprintJson(spec).sha256 !== task.spec_hash || spec.taskId !== task.task_id || spec.grantId !== o.continuation.original.grantId || spec.allocationId !== o.allocationId) fail('predecessor_spec');
    if (!db.query('SELECT 1 FROM engineering_cleanup_proofs WHERE task_id=? AND session_id=? AND owner_epoch=?').get(task.task_id as string, task.session_id, task.owner_epoch)) fail('predecessor_cleanup');
    const owner = db.query('SELECT * FROM engineering_model_owners WHERE allocation_id=?').get(o.allocationId) as Record<string, unknown> | null;
    if (!owner || owner.task_id !== task.task_id || owner.session_id !== task.session_id || owner.owner_epoch !== task.owner_epoch || owner.policy_hash !== spec.policyHash) fail('predecessor_model_owner');
    const requests = db.query('SELECT * FROM engineering_model_requests WHERE allocation_id=? ORDER BY rowid').all(o.allocationId) as Record<string, unknown>[];
    if (requests.length !== BASE_COUNT || requests.some((r, i) => r.state !== 'settled' || r.role !== 'work' || r.max_tokens !== 8192 || r.ledger_attempt !== base.attempts[i]!.id || r.receipt_hash !== fingerprintJson({...base.attempts[i]!, reason:base.receipts[i]!.reason, details_json:base.receipts[i]!.details_json}).sha256 || typeof r.response_hash !== 'string' || !/^[a-f0-9]{64}$/.test(r.response_hash))) fail('predecessor_model_requests');
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string }[];
    const rows = schema.filter(s => s.type === 'table').map(s => [s.name, db.query('SELECT * FROM "' + s.name.replaceAll('"', '""') + '"').all().map(r => JSON.stringify(r)).sort()]);
    return digest({ schema, rows });
  });
  if (digest(identity(path, true)) !== digest(file)) fail('predecessor_replaced');
  return { identity: file, logicalSha256: result };
}
function snapshot(o: EngineeringContinuationBinding, prospective = false) {
  const ready = assertEngineeringBudgetAdmission(o.continuation.original);
  if (ready.status.capMicros !== CAP) fail('allocation_binding');
  const ledgerIdentity = identity(o.ledgerPath), journalIdentity = prospective ? null : identity(join(o.root, 'engineering.sqlite'), true);
  const base = withReadDb(o.ledgerPath, db => prefix(db, o.allocationId));
  return { baseline: base, ledgerIdentity, journalIdentity, predecessor: predecessor(o, base), holdId: ready.holdId };
}
function claimPath(o: EngineeringContinuationBinding) { return join(o.continuation.original.auditDir, o.continuation.original.runId + '.continuation-claim.json'); }
function encode(value: unknown) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
/** Read-only preparation before a prospective v2 directory or journal exists.
 * It verifies all predecessor evidence but never asserts an uncreated identity. */
export function previewEngineeringContinuation(input: EngineeringContinuationBinding) {
  const o = binding(input, true), evidence = snapshot(o, true);
  const ready = assertEngineeringBudgetAdmission(o.continuation.original);
  if (ready.status.unknownAttempts !== 0 || ready.status.attemptCount !== BASE_COUNT || ready.status.chargedMicros !== BASE_CHARGED) fail('new_attempts_already_exist');
  if (existsSync(claimPath(o)) || existsSync(o.continuation.receiptPath)) fail('continuation_already_claimed');
  return Object.freeze({ applied:false,canRun:false,baselineAttemptCount:BASE_COUNT,baselineChargedMicros:BASE_CHARGED,
    remainingMicros:CAP-BASE_CHARGED,baselineSha256:digest(evidence.baseline),predecessorSha256:digest(evidence.predecessor),
    ledgerIdentity:evidence.ledgerIdentity,claimPath:claimPath(o),receiptPath:o.continuation.receiptPath });
}
/** Invoke only under the operator's existing exclusive admission/resource locks.
 * Both preview and apply reconcile the existing hold; neither enrolls or spends. */
export function admitEngineeringContinuation(options: EngineeringContinuationBinding & { apply?: boolean; onClaimed?: () => void }) {
  const { apply, onClaimed, ...input } = options, o = binding(input), evidence = snapshot(o);
  const ready = assertEngineeringBudgetAdmission(o.continuation.original);
  if (ready.status.unknownAttempts !== 0 || ready.status.attemptCount !== BASE_COUNT || ready.status.chargedMicros !== BASE_CHARGED) fail('new_attempts_already_exist');
  withReadDb(join(o.root, 'engineering.sqlite'), db => {
    for (const row of db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
      if (db.query('SELECT 1 FROM "' + row.name.replaceAll('"', '""') + '" LIMIT 1').get()) fail('new_journal_not_empty');
    }
  });
  const receipt = { version: 1, kind: 'engineering_budget_continuation', binding: o, evidence,
    capMicros: CAP, baselineAttemptCount: BASE_COUNT, baselineChargedMicros: BASE_CHARGED,
    remainingMicros: CAP - BASE_CHARGED, newTaskEnvelope: { workRequests: 3, reviewRequests: 1, allAuxiliaryCountAsWork: true },
    rule: 'Existing cumulative cap and hold only; predecessor remains closed; every new reservation preserves review headroom.' };
  const bytes = encode(receipt), receiptSha256 = sha(bytes), path = claimPath(o);
  if (existsSync(path) || existsSync(o.continuation.receiptPath)) fail('continuation_already_claimed');
  if (apply) {
    writeNew(path, encode({ version: 1, kind: 'engineering_continuation_claim', receiptPath: o.continuation.receiptPath, receiptSha256,
      allocationId: o.allocationId, ledgerIdentity: evidence.ledgerIdentity, journalIdentity: evidence.journalIdentity }));
    onClaimed?.();
    if (digest(snapshot(o)) !== digest(evidence) || assertEngineeringBudgetAdmission(o.continuation.original).status.attemptCount !== BASE_COUNT) fail('claim_state_changed');
    writeNew(o.continuation.receiptPath, bytes);
    assertEngineeringContinuationBudget(o, { requireUnused: true });
  }
  return Object.freeze({ applied: !!apply, canRun: !!apply, receiptPath: o.continuation.receiptPath, receiptSha256,
    claimPath: path, baselineAttemptCount: BASE_COUNT, baselineChargedMicros: BASE_CHARGED, remainingMicros: CAP - BASE_CHARGED });
}
/** Read-only. A receipt is evidence, not fresh user authority or an owner lease. */
export function assertEngineeringContinuationBudget(input: EngineeringContinuationBinding, options: { requireUnused?: boolean } = {}): EngineeringContinuationBaseline {
  const o = binding(input), claimBytes = read(claimPath(o)), receiptBytes = read(o.continuation.receiptPath);
  const claim = JSON.parse(claimBytes.toString()), receipt = JSON.parse(receiptBytes.toString()), receiptSha256 = sha(receiptBytes);
  if (claim.version !== 1 || claim.kind !== 'engineering_continuation_claim' || claim.receiptPath !== o.continuation.receiptPath || claim.receiptSha256 !== receiptSha256
      || claim.allocationId !== o.allocationId || receipt.version !== 1 || receipt.kind !== 'engineering_budget_continuation'
      || digest(receipt.binding) !== digest(o) || receipt.capMicros !== CAP || receipt.baselineAttemptCount !== BASE_COUNT
      || receipt.baselineChargedMicros !== BASE_CHARGED || receipt.remainingMicros !== CAP - BASE_CHARGED
      || digest(receipt.newTaskEnvelope) !== digest({ workRequests: 3, reviewRequests: 1, allAuxiliaryCountAsWork: true })
      || digest(claim.ledgerIdentity) !== digest(receipt.evidence.ledgerIdentity) || digest(claim.journalIdentity) !== digest(receipt.evidence.journalIdentity)) fail('receipt_binding');
  const assertCurrent = () => {
    if (!read(claimPath(o)).equals(claimBytes) || !read(o.continuation.receiptPath).equals(receiptBytes)
        || digest(snapshot(o)) !== digest(receipt.evidence)) fail('evidence_changed');
  };
  assertCurrent();
  if (options.requireUnused && assertEngineeringBudgetAdmission(o.continuation.original).status.attemptCount !== BASE_COUNT) fail('continuation_already_used');
  const baseline: EngineeringContinuationBaseline = Object.freeze({ allocationId:o.allocationId, campaignId:o.campaignId, baselineAttemptCount: 3, baselineChargedMicros: 114776, receiptSha256,
    assertCurrent,
    assertPrefix(db: Database) {
      if (db.filename !== o.ledgerPath || digest(identity(db.filename)) !== digest(receipt.evidence.ledgerIdentity)
          || digest(prefix(db, o.allocationId)) !== digest(receipt.evidence.baseline)) fail('prefix_changed');
    },
    assertJournal(db: Database) {
      if (db.filename !== join(o.root, 'engineering.sqlite') || digest(identity(db.filename, true)) !== digest(receipt.evidence.journalIdentity)) fail('journal_changed');
    } });
  minted.add(baseline); return baseline;
}
export function assertEngineeringContinuationBaseline(value: EngineeringContinuationBaseline, spendDb: Database, journalDb: Database, allocationId: string): void {
  if (!minted.has(value) || value.allocationId !== allocationId) fail('untrusted_baseline');
  value.assertCurrent(); value.assertPrefix(spendDb); value.assertJournal(journalDb);
}
