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
import { ENGINEERING_ACCEPTANCE_POLICY_V2, engineeringAcceptancePolicySha256 } from './engineering-policy.ts';
import type { EngineeringLedgerRebootReference } from './engineering-budget-reboot.ts';

export interface EngineeringContinuationConfig {
  version: 1 | 2;
  original: EngineeringBudgetBinding;
  predecessorJournalPath: string;
  predecessorTaskId: string;
  receiptPath: string;
  ledgerRebootAttestation?: EngineeringLedgerRebootReference;
  /** Exactly one further task after the known second task blocked before model
   * setup. This does not reopen that task or recursively roll over grants. */
  afterBlockedContinuation?: { receiptPath: string; receiptSha256: string; claimSha256: string; taskId: string };
  /** Explicit next admission after settled run03; its receipt binds v1 and v2. */
  afterSettledContinuation?: { receiptPath: string; receiptSha256: string; claimSha256: string; taskId: string; preservationSha256: string };
  /** Exact opt-in actual-dollar policy; neither a new allocation nor authority. */
  budgetPolicySha256?: string;
}
export interface EngineeringContinuationBinding extends EngineeringBudgetBinding {
  root: string;
  workspacesRoot: string;
  continuation: EngineeringContinuationConfig;
}
export interface EngineeringContinuationBaseline {
  readonly allocationId: string;
  readonly campaignId: string;
  readonly baselineAttemptCount: 3 | 6;
  readonly baselineChargedMicros: 114776 | 232012;
  readonly budgetPolicySha256?: string;
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
const RUN_ONE='gary-native-engineering-20261010-01', RUN_TWO='gary-native-engineering-20261010-02', RUN_THREE='gary-native-engineering-20261010-03', RUN_FOUR='gary-native-engineering-20261010-04';
const FOUR_COUNT = 6, FOUR_CHARGED = 232_012;
const count = (o: EngineeringContinuationBinding) => o.continuation.version === 2 ? FOUR_COUNT : BASE_COUNT;
const charged = (o: EngineeringContinuationBinding) => o.continuation.version === 2 ? FOUR_CHARGED : BASE_CHARGED;
const envelope = (o: EngineeringContinuationBinding) => o.continuation.version === 2
  ? { workRequests: ENGINEERING_ACCEPTANCE_POLICY_V2.work.maxRequests, reviewRequests: ENGINEERING_ACCEPTANCE_POLICY_V2.review.maxRequests, allAuxiliaryCountAsWork: true, budgetPolicySha256: engineeringAcceptancePolicySha256(2) }
  : { workRequests: 3, reviewRequests: 1, allAuxiliaryCountAsWork: true };
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
  if (![1,2].includes(o.continuation.version) || Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k))
      || o.runId !== o.grantId || p.runId === o.runId || p.grantId === o.grantId
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(o.runId)
      || o.allocationId !== p.allocationId || o.campaignId !== p.campaignId
      || o.ledgerPath !== p.ledgerPath || o.aggregatePath !== p.aggregatePath
      || !/^[a-f0-9]{40}$/.test(o.sourceRevision) || ![o.runtimeConfigSha256,o.authoritySha256].every(h => /^[a-f0-9]{64}$/.test(h))
      || o.auditDir !== join(o.root, 'budget-admission') || o.continuation.receiptPath !== join(o.auditDir, 'continuation.json')
      || o.continuation.predecessorJournalPath !== join(dirname(p.auditDir), 'engineering.sqlite')
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(o.continuation.predecessorTaskId)) fail('binding');
  const c=o.continuation;
  if (c.version === 1 && (c.afterSettledContinuation || c.budgetPolicySha256 || o.runId === RUN_FOUR)) fail('settled_continuation_version');
  if (c.version === 2) {
    const after=c.afterSettledContinuation;
    if (!after || c.afterBlockedContinuation || c.budgetPolicySha256 !== engineeringAcceptancePolicySha256(2)
        || Object.keys(c).length !== 7 + (c.ledgerRebootAttestation ? 1 : 0)
        || Object.keys(after).length!==5 || !['receiptPath','receiptSha256','claimSha256','taskId','preservationSha256'].every(k=>Object.hasOwn(after,k))
        || p.runId!==RUN_ONE || p.grantId!==RUN_ONE || o.runId!==RUN_FOUR
        || o.root!==join(dirname(dirname(p.auditDir)),'engineering-v4')
        || after.receiptPath!==join(dirname(dirname(p.auditDir)),'engineering-v3','budget-admission','continuation.json')
        || ![after.receiptSha256,after.claimSha256,after.preservationSha256].every(h=>/^[a-f0-9]{64}$/.test(h))
        || after.taskId!=='engineering-eebc7874-e224-45f8-8e8b-9c01aed15ef9') fail('settled_continuation_binding');
  }
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
function settledPrefix(db: Database, allocationId: string) {
  const attempts = db.query('SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id LIMIT 6').all(allocationId) as Record<string, unknown>[];
  const charges=[36_388,37_438,40_950,36_601,38_937,41_698];
  if (attempts.length !== FOUR_COUNT || attempts.some((a,i) => a.id !== 147+i || a.state !== 'settled'
      || a.provider !== 'deepseek' || a.model !== 'deepseek-v4-pro' || a.max_tokens !== 8192
      || a.reserved_micros !== 1_416_561 || a.charged_micros !== charges[i])) fail('settled_baseline_attempts');
  const receipts=attempts.map(a=>db.query('SELECT * FROM spend_receipts WHERE attempt_id=?').get(a.id as number) as Record<string,unknown>|null);
  if (receipts.some(r=>!r || r.reason !== 'accepted' || typeof r.details_json !== 'string')) fail('settled_baseline_receipts');
  return {attempts,receipts};
}
const currentPrefix = (db: Database, o: EngineeringContinuationBinding) => o.continuation.version === 2 ? settledPrefix(db,o.allocationId) : prefix(db,o.allocationId);
function withReadDb<T>(path: string, fn: (db: Database) => T): T {
  identity(path); const db = new Database(path, { readonly: true, strict: true, create: false });
  try { return db.transaction(() => fn(db))(); } finally { db.close(); }
}
function journalDigest(db: Database): string {
  const schema=db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as {type:string;name:string}[];
  const rows=schema.filter(s=>s.type==='table').map(s=>[s.name,db.query('SELECT * FROM "'+s.name.replaceAll('"','""')+'"').all().map(r=>JSON.stringify(r)).sort()]);
  return digest({schema,rows});
}
/** Exact logical snapshot convention used by the reviewed rollback helper.
 * The resulting pin can be computed from its retained engineeringStore JSON;
 * it does not bless a newly observed predecessor as the historical baseline. */
export function engineeringContinuationJournalPreservationSha256(db: Database): string {
  const file=identity(db.filename,true);
  const schema=db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").values() as [string,string,string,string|null][];
  const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
  const tables:Record<string,unknown>={};
  for(const [kind,name,,sql] of schema){
    if(kind!=='table')continue;
    const info=db.query('PRAGMA table_info('+quote(name)+')').all() as {name:string;pk:number}[];
    const columns=info.map(r=>r.name),primary=info.filter(r=>r.pk>0).sort((a,b)=>a.pk-b.pk).map(r=>r.name);
    const rows=db.query('SELECT '+columns.map(quote).join(',')+' FROM '+quote(name)+' ORDER BY '+(primary.length?primary:columns).map(quote).join(',')).values();
    if(rows.length>1_000_000)fail('preservation_rows');
    const hash=createHash('sha256');
    for(const row of rows){
      const values=row.map(v=>{
        if(v instanceof Uint8Array)return {blob:Buffer.from(v).toString('base64')};
        // Historical engineering columns contain only integral numeric values.
        // Refuse lossy SQLite integers or floats whose JSON spelling differs.
        if(typeof v==='number'&&!Number.isSafeInteger(v))fail('preservation_number');
        if(v!==null&&!['string','number'].includes(typeof v))fail('preservation_type');
        return v;
      });
      const ascii=JSON.stringify(values).replace(/[\u007f-\uffff]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0'));
      hash.update(ascii+'\n');
    }
    tables[name]={schema:sql,columns,count:rows.length,sha256:hash.digest('hex')};
  }
  return fingerprintJson({identity:{dev:file.dev,ino:file.ino},tables,nonTableSchema:schema.filter(r=>r[0]!=='table')}).sha256;
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
/** Verify the completed, charged third attempt without reopening its owner or
 * dropping any of the original and blocked-second continuation evidence. */
function settledContinuation(o: EngineeringContinuationBinding, base: ReturnType<typeof settledPrefix>) {
  const after=o.continuation.afterSettledContinuation!;
  const receiptBytes=read(after.receiptPath);
  if (sha(receiptBytes)!==after.receiptSha256) fail('settled_continuation_receipts');
  const receipt=JSON.parse(receiptBytes.toString()), previous=receipt.binding as EngineeringContinuationBinding;
  if (!previous || previous.continuation?.version!==1 || !previous.continuation.afterBlockedContinuation
      || previous.continuation.afterSettledContinuation || previous.runId!==RUN_THREE || previous.grantId!==RUN_THREE
      || previous.root!==dirname(dirname(after.receiptPath)) || previous.auditDir!==dirname(after.receiptPath)
      || previous.continuation.receiptPath!==after.receiptPath
      || fingerprintJson(previous.continuation.original).sha256!==fingerprintJson(o.continuation.original).sha256
      || previous.continuation.predecessorJournalPath!==o.continuation.predecessorJournalPath
      || previous.continuation.predecessorTaskId!==o.continuation.predecessorTaskId
      || fingerprintJson(previous.continuation.ledgerRebootAttestation??null).sha256!==fingerprintJson(o.continuation.ledgerRebootAttestation??null).sha256
      || previous.ledgerPath!==o.ledgerPath || previous.aggregatePath!==o.aggregatePath
      || previous.campaignId!==o.campaignId || previous.allocationId!==o.allocationId
      || o.workspacesRoot!==join(dirname(previous.workspacesRoot),'engineering-v4')) fail('settled_continuation_chain');
  for (const root of [o.root,o.workspacesRoot]) for (const old of [previous.root,previous.workspacesRoot]) {
    if (inside(root,old)||inside(old,root)) fail('settled_continuation_overlap');
  }
  const oldClaimPath=claimPath(previous),claimBytes=read(oldClaimPath);
  if (sha(claimBytes)!==after.claimSha256) fail('settled_continuation_receipts');
  // Recursively revalidates both historical continuations, including immutable
  // claims, original admission/hold, ledger identity and predecessor journals.
  assertEngineeringContinuationBudget(previous).assertCurrent();
  const second=JSON.parse(read(previous.continuation.afterBlockedContinuation.receiptPath).toString()).binding as EngineeringContinuationBinding;
  for (const root of [o.root,o.workspacesRoot]) for (const old of [second.root,second.workspacesRoot]) {
    if (inside(root,old)||inside(old,root)) fail('settled_continuation_overlap');
  }
  const configPath=join(previous.root,'config.json'),authorityPath=join(previous.root,'authority.json');
  const configBytes=read(configPath),authorityBytes=read(authorityPath);
  if (sha(configBytes)!==previous.runtimeConfigSha256 || sha(authorityBytes)!==previous.authoritySha256) fail('settled_continuation_config');
  const config=JSON.parse(configBytes.toString()),authority=JSON.parse(authorityBytes.toString());
  if (config.grantId!==previous.grantId || config.allocationId!==o.allocationId || config.campaignId!==o.campaignId
      || config.sourceRevision!==previous.sourceRevision || config.root!==previous.root || config.workspacesRoot!==previous.workspacesRoot
      || config.capMicros!==CAP || config.publication!=='patch_only'
      || fingerprintJson(config.budget?.continuation??null).sha256!==fingerprintJson(previous.continuation).sha256
      || typeof config.repository!=='string' || !/^707-Labs\/[A-Za-z0-9._-]+$/.test(config.repository)
      || typeof config.baseCommit!=='string' || !/^[a-f0-9]{40}$/.test(config.baseCommit)
      || authority.grantId!==previous.grantId || authority.capMicros!==CAP || authority.mergeAllowed!==false || authority.deploymentAllowed!==false
      || authority.continuationDecision?.path!==join(previous.root,'continuation-authority.json')
      || !/^[a-f0-9]{64}$/.test(authority.continuationDecision.sha256)) fail('settled_continuation_config');
  const decisionBytes=read(authority.continuationDecision.path);
  if (sha(decisionBytes)!==authority.continuationDecision.sha256) fail('settled_continuation_authority');
  const decision=JSON.parse(decisionBytes.toString());
  if (decision.kind!=='trusted_delegated_continuation_03_decision' || decision.sourceThreadId!==authority.sourceThreadId
      || decision.continuationGrantId!==RUN_THREE || decision.originalGrantId!==RUN_ONE || decision.consumedContinuationGrantId!==RUN_TWO
      || decision.campaignId!==o.campaignId || decision.allocationId!==o.allocationId || decision.cumulativeCapMicros!==CAP
      || decision.priorSettledSpendMicros!==BASE_CHARGED || decision.newAggregateHold!==false || decision.preserveUnknownHolds!==true
      || decision.replayConsumedPhases!==false || decision.publication!=='patch_only'
      || decision.originalApprovalSha256!==o.continuation.original.authoritySha256) fail('settled_continuation_authority');
  const path=join(previous.root,'engineering.sqlite'),file=identity(path,true);
  const originalSpec=withReadDb(o.continuation.predecessorJournalPath,db=>{
    const row=db.query('SELECT spec_json FROM engineering_tasks WHERE task_id=?').get(o.continuation.predecessorTaskId) as {spec_json:string};
    return JSON.parse(row.spec_json);
  });
  const logicalSha256=withReadDb(path,db=>{
    if(engineeringContinuationJournalPreservationSha256(db)!==after.preservationSha256) fail('settled_continuation_preservation');
    const tasks=db.query('SELECT * FROM engineering_tasks').all() as Record<string,unknown>[],task=tasks[0];
    if (tasks.length!==1 || !task || task.task_id!==after.taskId || task.state!=='blocked' || task.cleanup_confirmed!==1
        || typeof task.owner_epoch!=='string' || typeof task.session_id!=='string') fail('settled_continuation_task');
    const spec=JSON.parse(task.spec_json as string);
    if (fingerprintJson(spec).sha256!==task.spec_hash || spec.taskId!==task.task_id || spec.requestId!==task.request_id
        || spec.grantId!==RUN_THREE || spec.allocationId!==o.allocationId
        || ['repository','repositoryId'].some(k=>spec[k]!==originalSpec[k])
        || spec.repository!==config.repository || spec.baseCommit!==config.baseCommit
        || fingerprintJson(spec.scope).sha256!==fingerprintJson(originalSpec.scope).sha256
        || task.scope_key!==fingerprintJson([spec.scope.teamId,spec.scope.surface,spec.scope.audienceId,spec.scope.projectId]).sha256) fail('settled_continuation_spec');
    const cleanup=db.query('SELECT * FROM engineering_cleanup_proofs').all() as Record<string,unknown>[];
    if (cleanup.length!==1 || cleanup[0]!.task_id!==task.task_id || cleanup[0]!.session_id!==task.session_id
        || cleanup[0]!.owner_epoch!==task.owner_epoch) fail('settled_continuation_cleanup');
    const runs=db.query('SELECT * FROM engineering_runtime_runs').all() as Record<string,unknown>[];
    if (runs.length!==1 || runs[0]!.task_id!==task.task_id || runs[0]!.policy_hash!==spec.policyHash || runs[0]!.launch_state!=='closed') fail('settled_continuation_runtime');
    // A retained lease reference is historical evidence, not a held lock. Fresh
    // physical absence/resource-lock admission remains the operator's duty.
    const leases=db.query('SELECT * FROM engineering_runtime_leases').all() as Record<string,unknown>[];
    if (leases.length!==1 || leases.some(r=>{
      const reference=JSON.parse(r.reference_json as string);
      return r.task_id!==task.task_id || r.session_id!==task.session_id || r.owner_epoch!==task.owner_epoch
        || fingerprintJson(reference).sha256!==r.reference_hash
        || fingerprintJson(reference.binding).sha256!==fingerprintJson({taskId:task.task_id,sessionId:task.session_id,ownerEpoch:task.owner_epoch}).sha256;
    })) fail('settled_continuation_lease');
    const ingress=db.query('SELECT * FROM engineering_ingress_requests').all() as Record<string,unknown>[];
    if (ingress.length!==1 || ingress[0]!.task_id!==task.task_id || ingress[0]!.request_id!==task.request_id
        || ingress[0]!.allocation_id!==o.allocationId || ingress[0]!.stage!=='blocked') fail('settled_continuation_ingress');
    const final=JSON.parse(ingress[0]!.final_json as string);
    if (final.taskId!==task.task_id || final.requestId!==task.request_id || final.phase!=='final' || final.status!=='blocked') fail('settled_continuation_ingress');
    const owners=db.query('SELECT * FROM engineering_model_owners').all() as Record<string,unknown>[];
    if (owners.length!==1 || owners[0]!.allocation_id!==o.allocationId || owners[0]!.task_id!==task.task_id
        || owners[0]!.session_id!==task.session_id || owners[0]!.owner_epoch!==task.owner_epoch || owners[0]!.policy_hash!==spec.policyHash) fail('settled_continuation_model_owner');
    const baselines=db.query('SELECT * FROM engineering_model_baselines').all() as Record<string,unknown>[];
    if (baselines.length!==1 || baselines[0]!.allocation_id!==o.allocationId || baselines[0]!.receipt_hash!==after.receiptSha256
        || baselines[0]!.attempt_count!==BASE_COUNT || baselines[0]!.charged_micros!==BASE_CHARGED) fail('settled_continuation_model_baseline');
    const requests=db.query('SELECT * FROM engineering_model_requests ORDER BY rowid').all() as Record<string,unknown>[];
    if (requests.length!==3 || requests.some((r,i)=>r.allocation_id!==o.allocationId || r.state!=='settled' || r.role!=='work'
        || r.max_tokens!==8192 || r.ledger_attempt!==base.attempts[i+3]!.id
        || r.receipt_hash!==fingerprintJson({...base.attempts[i+3]!,reason:base.receipts[i+3]!.reason,details_json:base.receipts[i+3]!.details_json}).sha256
        || ![r.request_hash,r.response_hash].every(h=>typeof h==='string' && /^[a-f0-9]{64}$/.test(h)))) fail('settled_continuation_model_requests');
    return journalDigest(db);
  });
  if (digest(identity(path,true))!==digest(file) || !read(after.receiptPath).equals(receiptBytes) || !read(oldClaimPath).equals(claimBytes)
      || !read(configPath).equals(configBytes) || !read(authorityPath).equals(authorityBytes)
      || !read(authority.continuationDecision.path).equals(decisionBytes)) fail('settled_continuation_changed');
  return {receiptSha256:after.receiptSha256,claimSha256:after.claimSha256,configSha256:sha(configBytes),authoritySha256:sha(authorityBytes),
    decisionSha256:sha(decisionBytes),preservationSha256:after.preservationSha256,journalIdentity:file,logicalSha256,taskId:after.taskId};
}
function snapshot(o: EngineeringContinuationBinding, prospective = false) {
  const ready = originalAdmission(o);
  if (ready.status.capMicros !== CAP) fail('allocation_binding');
  const ledgerIdentity = identity(o.ledgerPath), journalIdentity = prospective ? null : identity(join(o.root, 'engineering.sqlite'), true);
  const base = withReadDb(o.ledgerPath, db => currentPrefix(db, o));
  return { baseline: base, ledgerIdentity, journalIdentity, predecessor: predecessor(o, {attempts:base.attempts.slice(0,3),receipts:base.receipts.slice(0,3)}), holdId: ready.holdId,
    ...(o.continuation.afterBlockedContinuation ? {afterBlockedContinuation:blockedContinuation(o)} : {}),
    ...(o.continuation.version===2 ? {afterSettledContinuation:settledContinuation(o,base)} : {}) };
}
function originalAdmission(o: EngineeringContinuationBinding) {
  const reboot=o.continuation.ledgerRebootAttestation;
  return assertEngineeringBudgetAdmission(o.continuation.original, reboot ? {ledgerRebootAttestation:reboot} : {});
}
function claimPath(o: EngineeringContinuationBinding) {
  if (o.continuation.version===2) return join(dirname(o.continuation.afterSettledContinuation!.receiptPath),RUN_THREE+'.continuation-claim.json');
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
  if (ready.status.unknownAttempts !== 0 || ready.status.attemptCount !== count(o) || ready.status.chargedMicros !== charged(o)) fail('new_attempts_already_exist');
  if (existsSync(claimPath(o)) || existsSync(o.continuation.receiptPath)) fail('continuation_already_claimed');
  return Object.freeze({ applied:false,canRun:false,baselineAttemptCount:count(o),baselineChargedMicros:charged(o),
    remainingMicros:CAP-charged(o),baselineSha256:digest(evidence.baseline),predecessorSha256:digest(evidence.predecessor),
    ledgerIdentity:evidence.ledgerIdentity,claimPath:claimPath(o),receiptPath:o.continuation.receiptPath,
    ...(evidence.afterBlockedContinuation ? {blockedContinuationSha256:digest(evidence.afterBlockedContinuation)} : {}),
    ...(evidence.afterSettledContinuation ? {settledContinuationSha256:digest(evidence.afterSettledContinuation)} : {}) });
}
/** Invoke only under the operator's existing exclusive admission/resource locks.
 * Both preview and apply reconcile the existing hold; neither enrolls or spends. */
export function admitEngineeringContinuation(options: EngineeringContinuationBinding & { apply?: boolean; onClaimed?: () => void }) {
  const { apply, onClaimed, ...input } = options, o = binding(input), evidence = snapshot(o);
  const ready = originalAdmission(o);
  if (ready.status.unknownAttempts !== 0 || ready.status.attemptCount !== count(o) || ready.status.chargedMicros !== charged(o)) fail('new_attempts_already_exist');
  withReadDb(join(o.root, 'engineering.sqlite'), db => {
    for (const row of db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
      if (db.query('SELECT 1 FROM "' + row.name.replaceAll('"', '""') + '" LIMIT 1').get()) fail('new_journal_not_empty');
    }
  });
  const receipt = { version: o.continuation.version, kind: 'engineering_budget_continuation', binding: o, evidence,
    capMicros: CAP, baselineAttemptCount: count(o), baselineChargedMicros: charged(o),
    remainingMicros: CAP - charged(o), newTaskEnvelope: envelope(o),
    rule: 'Existing cumulative cap and hold only; predecessor remains closed; every new reservation preserves review headroom.' };
  const bytes = encode(receipt), receiptSha256 = sha(bytes), path = claimPath(o);
  if (existsSync(path) || existsSync(o.continuation.receiptPath)) fail('continuation_already_claimed');
  if (apply) {
    writeNew(path, encode({ version: o.continuation.version, kind: 'engineering_continuation_claim', receiptPath: o.continuation.receiptPath, receiptSha256,
      allocationId: o.allocationId, ledgerIdentity: evidence.ledgerIdentity, journalIdentity: evidence.journalIdentity }));
    onClaimed?.();
    if (digest(snapshot(o)) !== digest(evidence) || originalAdmission(o).status.attemptCount !== count(o)) fail('claim_state_changed');
    writeNew(o.continuation.receiptPath, bytes);
    assertEngineeringContinuationBudget(o, { requireUnused: true });
  }
  return Object.freeze({ applied: !!apply, canRun: !!apply, receiptPath: o.continuation.receiptPath, receiptSha256,
    claimPath: path, baselineAttemptCount: count(o), baselineChargedMicros: charged(o), remainingMicros: CAP - charged(o) });
}
/** Read-only. A receipt is evidence, not fresh user authority or an owner lease. */
export function assertEngineeringContinuationBudget(input: EngineeringContinuationBinding, options: { requireUnused?: boolean } = {}): EngineeringContinuationBaseline {
  const o = binding(input), claimBytes = read(claimPath(o)), receiptBytes = read(o.continuation.receiptPath);
  const claim = JSON.parse(claimBytes.toString()), receipt = JSON.parse(receiptBytes.toString()), receiptSha256 = sha(receiptBytes);
  if (claim.version !== o.continuation.version || claim.kind !== 'engineering_continuation_claim' || claim.receiptPath !== o.continuation.receiptPath || claim.receiptSha256 !== receiptSha256
      || claim.allocationId !== o.allocationId || receipt.version !== o.continuation.version || receipt.kind !== 'engineering_budget_continuation'
      || digest(receipt.binding) !== digest(o) || receipt.capMicros !== CAP || receipt.baselineAttemptCount !== count(o)
      || receipt.baselineChargedMicros !== charged(o) || receipt.remainingMicros !== CAP - charged(o)
      || digest(receipt.newTaskEnvelope) !== digest(envelope(o))
      || digest(claim.ledgerIdentity) !== digest(receipt.evidence.ledgerIdentity) || digest(claim.journalIdentity) !== digest(receipt.evidence.journalIdentity)) fail('receipt_binding');
  const assertCurrent = () => {
    if (!read(claimPath(o)).equals(claimBytes) || !read(o.continuation.receiptPath).equals(receiptBytes)
        || digest(snapshot(o)) !== digest(receipt.evidence)) fail('evidence_changed');
  };
  assertCurrent();
  if (options.requireUnused && originalAdmission(o).status.attemptCount !== count(o)) fail('continuation_already_used');
  const baseline: EngineeringContinuationBaseline = Object.freeze({ allocationId:o.allocationId, campaignId:o.campaignId, baselineAttemptCount: count(o), baselineChargedMicros: charged(o), receiptSha256,
    ...(o.continuation.version===2 ? {budgetPolicySha256:o.continuation.budgetPolicySha256!} : {}),
    assertCurrent,
    assertPrefix(db: Database) {
      if (db.filename !== o.ledgerPath || digest(identity(db.filename)) !== digest(receipt.evidence.ledgerIdentity)
          || digest(currentPrefix(db, o)) !== digest(receipt.evidence.baseline)) fail('prefix_changed');
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
