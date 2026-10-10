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
import type { EngineeringLedgerRebootReference } from './engineering-budget-reboot.ts';

export interface EngineeringContinuationConfig {
  version: 1;
  original: EngineeringBudgetBinding;
  predecessorJournalPath: string;
  predecessorTaskId: string;
  receiptPath: string;
  ledgerRebootAttestation?: EngineeringLedgerRebootReference;
  /** Exactly one further task after the known second task blocked before model
   * setup. This does not reopen that task or recursively roll over grants. */
  afterBlockedContinuation?: { receiptPath: string; receiptSha256: string; claimSha256: string; taskId: string };
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
const RUN_ONE='gary-native-engineering-20261010-01', RUN_TWO='gary-native-engineering-20261010-02', RUN_THREE='gary-native-engineering-20261010-03';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown) => sha(JSON.stringify(v));
function fail(code: string): never { throw new Error('engineering_continuation:' + code); }
function canonical(path: string, privateParent = true): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) fail('path');
  const s = lstatSync(dirname(path));
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & (privateParent ? 0o077 : 0o022)) !== 0) fail('parent_metadata');
}
function identity(path: string, privateFile = false) {
  // The existing canonical ledger is readable (0644/0755), while journals and
  // sidecars retain their private parent requirement. Never relax write paths.
  canonical(path, privateFile); const s = lstatSync(path);
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
  const after=o.continuation.afterBlockedContinuation;
  if (after && (Object.keys(after).length!==4 || !['receiptPath','receiptSha256','claimSha256','taskId'].every(k=>Object.hasOwn(after,k))
      || p.runId!==RUN_ONE || p.grantId!==RUN_ONE || o.runId!==RUN_THREE
      || o.root!==join(dirname(dirname(p.auditDir)),'engineering-v3')
      || after.receiptPath!==join(dirname(dirname(p.auditDir)),'engineering-v2','budget-admission','continuation.json')
      || ![after.receiptSha256,after.claimSha256].every(h=>/^[a-f0-9]{64}$/.test(h))
      || after.taskId!=='engineering-438c8176-7f19-495d-9a8b-4056a141e1c8')) fail('blocked_continuation_binding');
  if (o.runId===RUN_THREE && !after) fail('blocked_continuation_required');
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
function journalDigest(db: Database): string {
  const schema=db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as {type:string;name:string}[];
  const rows=schema.filter(s=>s.type==='table').map(s=>[s.name,db.query('SELECT * FROM "'+s.name.replaceAll('"','""')+'"').all().map(r=>JSON.stringify(r)).sort()]);
  return digest({schema,rows});
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
    return journalDigest(db);
  });
  if (digest(identity(path, true)) !== digest(file)) fail('predecessor_replaced');
  return { identity: file, logicalSha256: result };
}
function blockedContinuation(o: EngineeringContinuationBinding) {
  const after=o.continuation.afterBlockedContinuation!;
  const receiptBytes=read(after.receiptPath),oldClaimPath=join(o.continuation.original.auditDir,RUN_ONE+'.continuation-claim.json'),claimBytes=read(oldClaimPath);
  if (sha(receiptBytes)!==after.receiptSha256 || sha(claimBytes)!==after.claimSha256) fail('blocked_continuation_receipts');
  const receipt=JSON.parse(receiptBytes.toString()),previous=receipt.binding as EngineeringContinuationBinding;
  if (!previous || previous.continuation?.afterBlockedContinuation || previous.runId!==RUN_TWO || previous.grantId!==RUN_TWO
      || previous.root!==dirname(dirname(after.receiptPath)) || previous.auditDir!==dirname(after.receiptPath)
      || previous.continuation.receiptPath!==after.receiptPath
      || fingerprintJson(previous.continuation.original).sha256!==fingerprintJson(o.continuation.original).sha256
      || previous.continuation.predecessorJournalPath!==o.continuation.predecessorJournalPath
      || previous.continuation.predecessorTaskId!==o.continuation.predecessorTaskId
      || fingerprintJson(previous.continuation.ledgerRebootAttestation??null).sha256!==fingerprintJson(o.continuation.ledgerRebootAttestation??null).sha256
      || previous.ledgerPath!==o.ledgerPath || previous.aggregatePath!==o.aggregatePath
      || previous.campaignId!==o.campaignId || previous.allocationId!==o.allocationId
      || o.workspacesRoot!==join(dirname(previous.workspacesRoot),'engineering-v3')) fail('blocked_continuation_chain');
  for (const root of [o.root,o.workspacesRoot]) for (const old of [previous.root,previous.workspacesRoot]) {
    if (inside(root,old)||inside(old,root)) fail('blocked_continuation_overlap');
  }
  // Its receipt remains valid after later usage by 03; requireUnused is solely
  // a fresh-admission gate, never an ongoing cumulative-budget health check.
  assertEngineeringContinuationBudget(previous).assertCurrent();
  // A reviewed second rollout may advance the repository base. Its own pinned
  // config is the authority for that base; never infer it from attempt 01.
  const configBytes=read(join(previous.root,'config.json'));
  if (sha(configBytes)!==previous.runtimeConfigSha256) fail('blocked_continuation_config');
  const config=JSON.parse(configBytes.toString());
  if (config.grantId!==previous.grantId || config.allocationId!==o.allocationId || config.campaignId!==o.campaignId
      || config.sourceRevision!==previous.sourceRevision || config.root!==previous.root || config.workspacesRoot!==previous.workspacesRoot
      || typeof config.repository!=='string' || !/^707-Labs\/[A-Za-z0-9._-]+$/.test(config.repository)
      || typeof config.baseCommit!=='string' || !/^[a-f0-9]{40}$/.test(config.baseCommit)) fail('blocked_continuation_config');
  const path=join(previous.root,'engineering.sqlite'),file=identity(path,true);
  const originalSpec=withReadDb(o.continuation.predecessorJournalPath,db=> {
    const row=db.query('SELECT spec_json FROM engineering_tasks WHERE task_id=?').get(o.continuation.predecessorTaskId) as {spec_json:string};
    return JSON.parse(row.spec_json);
  });
  const logicalSha256=withReadDb(path,db=>{
    if (db.query("SELECT 1 FROM sqlite_master WHERE name LIKE 'engineering_model_%' LIMIT 1").get()) fail('blocked_continuation_model_state');
    const tasks=db.query('SELECT * FROM engineering_tasks').all() as Record<string,unknown>[];
    const task=tasks[0];
    if (tasks.length!==1 || !task || task.task_id!==after.taskId || task.state!=='blocked' || task.cleanup_confirmed!==1
        || typeof task.owner_epoch!=='string' || typeof task.session_id!=='string') fail('blocked_continuation_task');
    const spec=JSON.parse(task.spec_json as string);
    if (fingerprintJson(spec).sha256!==task.spec_hash || spec.taskId!==task.task_id || spec.requestId!==task.request_id
        || spec.grantId!==RUN_TWO || spec.allocationId!==o.allocationId
        || ['repository','repositoryId'].some(k=>spec[k]!==originalSpec[k])
        || spec.repository!==config.repository || spec.baseCommit!==config.baseCommit
        || fingerprintJson(spec.scope).sha256!==fingerprintJson(originalSpec.scope).sha256
        || task.scope_key!==fingerprintJson([spec.scope.teamId,spec.scope.surface,spec.scope.audienceId,spec.scope.projectId]).sha256) fail('blocked_continuation_spec');
    const cleanup=db.query('SELECT * FROM engineering_cleanup_proofs').all() as Record<string,unknown>[];
    if (cleanup.length!==1 || cleanup[0]!.task_id!==task.task_id || cleanup[0]!.session_id!==task.session_id
        || cleanup[0]!.owner_epoch!==task.owner_epoch) fail('blocked_continuation_cleanup');
    const runs=db.query('SELECT * FROM engineering_runtime_runs').all() as Record<string,unknown>[];
    if (runs.length!==1 || runs[0]!.task_id!==task.task_id || runs[0]!.policy_hash!==spec.policyHash || runs[0]!.launch_state!=='closed'
        || db.query('SELECT 1 FROM engineering_runtime_leases LIMIT 1').get()) fail('blocked_continuation_runtime');
    const ingress=db.query('SELECT * FROM engineering_ingress_requests').all() as Record<string,unknown>[];
    if (ingress.length!==1 || ingress[0]!.task_id!==task.task_id || ingress[0]!.request_id!==task.request_id
        || ingress[0]!.allocation_id!==o.allocationId || ingress[0]!.stage!=='blocked') fail('blocked_continuation_ingress');
    const final=JSON.parse(ingress[0]!.final_json as string);
    if (final.taskId!==task.task_id || final.requestId!==task.request_id || final.phase!=='final' || final.status!=='blocked') fail('blocked_continuation_ingress');
    return journalDigest(db);
  });
  if (digest(identity(path,true))!==digest(file) || !read(after.receiptPath).equals(receiptBytes) || !read(oldClaimPath).equals(claimBytes)
      || !read(join(previous.root,'config.json')).equals(configBytes)) fail('blocked_continuation_changed');
  return {receiptSha256:after.receiptSha256,claimSha256:after.claimSha256,journalIdentity:file,logicalSha256,taskId:after.taskId};
}
function snapshot(o: EngineeringContinuationBinding, prospective = false) {
  const ready = originalAdmission(o);
  if (ready.status.capMicros !== CAP) fail('allocation_binding');
  const ledgerIdentity = identity(o.ledgerPath), journalIdentity = prospective ? null : identity(join(o.root, 'engineering.sqlite'), true);
  const base = withReadDb(o.ledgerPath, db => prefix(db, o.allocationId));
  return { baseline: base, ledgerIdentity, journalIdentity, predecessor: predecessor(o, base), holdId: ready.holdId,
    ...(o.continuation.afterBlockedContinuation ? {afterBlockedContinuation:blockedContinuation(o)} : {}) };
}
function originalAdmission(o: EngineeringContinuationBinding) {
  const reboot=o.continuation.ledgerRebootAttestation;
  return assertEngineeringBudgetAdmission(o.continuation.original, reboot ? {ledgerRebootAttestation:reboot} : {});
}
function claimPath(o: EngineeringContinuationBinding) {
  const after=o.continuation.afterBlockedContinuation;
  return after ? join(dirname(after.receiptPath),RUN_TWO+'.continuation-claim.json')
    : join(o.continuation.original.auditDir,o.continuation.original.runId+'.continuation-claim.json');
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
/** Read-only preparation before a prospective v2 directory or journal exists.
 * It verifies all predecessor evidence but never asserts an uncreated identity. */
export function previewEngineeringContinuation(input: EngineeringContinuationBinding) {
  const o = binding(input, true), evidence = snapshot(o, true);
  const ready = originalAdmission(o);
  if (ready.status.unknownAttempts !== 0 || ready.status.attemptCount !== BASE_COUNT || ready.status.chargedMicros !== BASE_CHARGED) fail('new_attempts_already_exist');
  if (existsSync(claimPath(o)) || existsSync(o.continuation.receiptPath)) fail('continuation_already_claimed');
  return Object.freeze({ applied:false,canRun:false,baselineAttemptCount:BASE_COUNT,baselineChargedMicros:BASE_CHARGED,
    remainingMicros:CAP-BASE_CHARGED,baselineSha256:digest(evidence.baseline),predecessorSha256:digest(evidence.predecessor),
    ledgerIdentity:evidence.ledgerIdentity,claimPath:claimPath(o),receiptPath:o.continuation.receiptPath,
    ...(evidence.afterBlockedContinuation ? {blockedContinuationSha256:digest(evidence.afterBlockedContinuation)} : {}) });
}
/** Invoke only under the operator's existing exclusive admission/resource locks.
 * Both preview and apply reconcile the existing hold; neither enrolls or spends. */
export function admitEngineeringContinuation(options: EngineeringContinuationBinding & { apply?: boolean; onClaimed?: () => void }) {
  const { apply, onClaimed, ...input } = options, o = binding(input), evidence = snapshot(o);
  const ready = originalAdmission(o);
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
    if (digest(snapshot(o)) !== digest(evidence) || originalAdmission(o).status.attemptCount !== BASE_COUNT) fail('claim_state_changed');
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
  if (options.requireUnused && originalAdmission(o).status.attemptCount !== BASE_COUNT) fail('continuation_already_used');
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
