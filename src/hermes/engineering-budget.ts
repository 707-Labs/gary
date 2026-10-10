/** Operator-only aggregate hold FIRST, then immutable local SQLite enrollment. No HTTP.
 * All coordinators must honor <aggregate>.admission.lock. Its stable directory is
 * never stolen automatically: after a crash, an operator must verify the former
 * process is dead and inspect the claim/audits before removing that lock.
 * JSON and SQLite are separate durable operations, not a global transaction.
 * Any post-hold failure retains the hold; later unrelated state changes require
 * manual reconciliation rather than implicitly widening a recovery permission.
 */
import { constants, closeSync, fchmodSync, fchownSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { openSpendLedger, type SpendStatus } from '../spend.ts';

class JsonNumber { constructor(readonly literal:string){} }
type Json = null|boolean|string|JsonNumber|Json[]|{[key:string]:Json};
type RecordJson = {[key:string]:Json};
function fail(code:string):never {throw new Error('engineering_budget_admission:'+code);}
const record=(v:Json|undefined):v is RecordJson=>!!v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof JsonNumber);
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const CAP=5_650_000_000n, UNKNOWN_FLOOR=4_444_468_350n;
const COMMONFIELD_EARMARK=3_000_000_000n;
export const ENGINEERING_ACCEPTANCE_CAP_MICROS=5_650_000;

/** Small JSON reader preserves every numeric lexeme and rejects duplicate keys. */
function parseExact(text:string):Json {
  let at=0;
  const ws=()=>{while(/[ \t\n\r]/.test(text[at]??'')&&at<text.length)at++;};
  const string=():string=>{const start=at++;while(at<text.length){if(text[at]==='\\'){at+=2;continue;}if(text[at++]==='"')return JSON.parse(text.slice(start,at));}return fail('invalid_json');};
  const value=():Json=>{
    ws();const c=text[at];
    if(c==='"')return string();
    if(c==='{'){at++;ws();const out:RecordJson=Object.create(null);if(text[at]==='}'){at++;return out;}
      for(;;){ws();if(text[at]!=='"')fail('invalid_json');const key=string();if(Object.hasOwn(out,key))fail('duplicate_json_key');ws();if(text[at++]!==':')fail('invalid_json');out[key]=value();ws();const sep=text[at++];if(sep==='}')return out;if(sep!==',')fail('invalid_json');}}
    if(c==='['){at++;ws();const out:Json[]=[];if(text[at]===']'){at++;return out;}for(;;){out.push(value());ws();const sep=text[at++];if(sep===']')return out;if(sep!==',')fail('invalid_json');}}
    for(const [literal,result] of [['true',true],['false',false],['null',null]] as const)if(text.startsWith(literal,at)){at+=literal.length;return result;}
    const number=text.slice(at).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);if(!number)fail('invalid_json');at+=number[0].length;return new JsonNumber(number[0]);
  };
  const result=value();ws();if(at!==text.length)fail('invalid_json');return result;
}
function encode(value:Json,depth=0):string {
  if(value instanceof JsonNumber)return value.literal;
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  const pad='  '.repeat(depth),next=pad+'  ';
  if(Array.isArray(value))return value.length?'[\n'+value.map(v=>next+encode(v,depth+1)).join(',\n')+'\n'+pad+']':'[]';
  const entries=Object.entries(value);return entries.length?'{\n'+entries.map(([k,v])=>next+JSON.stringify(k)+': '+encode(v,depth+1)).join(',\n')+'\n'+pad+'}':'{}';
}
export function usdToNano(value:string):bigint {
  const match=value.length<=32?value.match(/^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/):null;if(!match)fail('invalid_usd_precision');
  return BigInt(match[1]!)*1_000_000_000n+BigInt((match[2]??'').padEnd(9,'0'));
}
export function nanoToUsd(value:bigint):string {if(value<0n)fail('negative_usd');return `${value/1_000_000_000n}.${String(value%1_000_000_000n).padStart(9,'0')}`;}
const money=(v:Json|undefined)=>v instanceof JsonNumber?usdToNano(v.literal):fail('money_must_be_json_number');
const number=(value:bigint)=>new JsonNumber(nanoToUsd(value));

interface Snapshot {bytes:Buffer;hash:string;stat:Stats;}
function canonical(path:string):string {
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(dirname(path))!==dirname(path))fail('noncanonical_or_symlink_path');
  const parent=lstatSync(dirname(path));if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o022)!==0)fail('unsafe_parent_metadata');
  return path;
}
function safeFile(path:string):Snapshot {
  canonical(path);const before=lstatSync(path);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o022)!==0)fail('unsafe_file_metadata');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd);if(stat.dev!==before.dev||stat.ino!==before.ino)fail('file_replaced');
    if(stat.size>4_194_304)fail('file_too_large');const bytes=readFileSync(fd),after=fstatSync(fd);
    if(bytes.length!==stat.size||['dev','ino','size','uid','gid','mode','mtimeMs','ctimeMs'].some(k=>stat[k as keyof Stats]!==after[k as keyof Stats]))fail('file_changed');
    return {bytes,hash:sha(bytes),stat};} finally {closeSync(fd);}
}
function same(a:Snapshot,b:Snapshot):boolean {return a.hash===b.hash&&['dev','ino','size','uid','gid','mode','mtimeMs','ctimeMs'].every(k=>a.stat[k as keyof Stats]===b.stat[k as keyof Stats]);}
function syncDir(path:string):void {const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeNew(path:string,bytes:string,mode=0o600):void {
  canonical(path);const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,mode);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}syncDir(dirname(path));
}
function writeOnce(path:string,bytes:string):void {
  try {writeNew(path,bytes);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(safeFile(path).bytes.toString()!==bytes)fail('audit_record_conflict');}
}
function totals(budget:RecordJson) {
  if(!(budget.schemaVersion instanceof JsonNumber)||budget.schemaVersion.literal!=='2'||!Array.isArray(budget.runtimeAllocations))fail('unsupported_aggregate_schema');
  if(money(budget.totalCeilingUsd)!==100_000_000_000n||money(budget.runtimePoolUsd)!==60_000_000_000n
    ||money(budget.other90HoldUsd)!==30_000_000_000n||money(budget.bufferHoldUsd)!==10_000_000_000n)fail('aggregate_cap_mismatch');
  let held=0n,unknown=0n,retired=0n;const ids=new Set<string>();let earmarkObserved=false;
  for(const allocation of budget.runtimeAllocations){if(!record(allocation)||typeof allocation.id!=='string'||ids.has(allocation.id))fail('invalid_aggregate_allocation');ids.add(allocation.id);
    if(record(allocation.admission)&&Object.hasOwn(allocation.admission,'commonfieldEarmarkMicros')){
      const earmark=allocation.admission.commonfieldEarmarkMicros;
      if(!(earmark instanceof JsonNumber)||earmark.literal!=='3000000')fail('commonfield_earmark_mismatch');
      if(allocation.admission.kind==='classifier_canary')earmarkObserved=true;
    }
    const retained=money(allocation.retainedAmountUsd),u=money(allocation.retainedUnknownCostsUsd),r=money(allocation.retiredUnusedAuthorizationUsd);
    if(u>retained||retained+r!==money(allocation.amountUsd))fail('allocation_reconciliation_mismatch');held+=retained;unknown+=u;retired+=r;}
  const remaining=60_000_000_000n-held;if(remaining<0n||money(budget.runtimeCommittedOrHeldUsd)!==held||money(budget.runtimeUnallocatedUsd)!==remaining
    ||money(budget.totalCommittedOrHeldUsd)!==held+40_000_000_000n||money(budget.runtimeUnknownHoldsUsd)!==unknown
    ||money(budget.runtimeAuthorizationRetiredUsd)!==retired||unknown<UNKNOWN_FLOOR)fail('aggregate_totals_mismatch');
  if(!earmarkObserved||remaining<COMMONFIELD_EARMARK)fail('commonfield_earmark_mismatch');
  return {held,unknown,retired,remaining};
}
interface LedgerState {priorHash:string;campaign:{id:string;cap_micros:number}|null;ticket:{ticket_id:string;campaign_id:string;cap_micros:number;draft_pr:number;state:string}|null;otherTickets:number;codingPolicy:boolean;candidateAttempts:number;status:SpendStatus|null;}
function ledgerState(path:string,campaignId:string,allocationId:string):LedgerState {
  safeFile(path);for(const suffix of ['-wal','-shm'])try{safeFile(path+suffix);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const db=new Database(path,{readonly:true,strict:true});
  try {
    // One read transaction: a concurrent legitimate request cannot produce a torn historical digest.
    db.exec('BEGIN');
    const campaign=db.query<NonNullable<LedgerState['campaign']>,[string]>('SELECT id,cap_micros FROM spend_campaigns WHERE id=?').get(campaignId);
    const ticket=db.query<NonNullable<LedgerState['ticket']>,[string]>('SELECT ticket_id,campaign_id,cap_micros,draft_pr,state FROM spend_tickets WHERE ticket_id=?').get(allocationId);
    const prior={campaigns:db.query('SELECT * FROM spend_campaigns WHERE id<>? ORDER BY id').all(campaignId),
      tickets:db.query('SELECT * FROM spend_tickets WHERE ticket_id<>? ORDER BY ticket_id').all(allocationId),
      attempts:db.query('SELECT * FROM spend_attempts WHERE ticket_id<>? ORDER BY id').all(allocationId),
      receipts:db.query('SELECT r.* FROM spend_receipts r LEFT JOIN spend_attempts a ON a.id=r.attempt_id WHERE a.ticket_id IS NULL OR a.ticket_id<>? ORDER BY r.attempt_id').all(allocationId),
      codingPolicies:db.query('SELECT * FROM spend_coding_policies WHERE ticket_id<>? ORDER BY ticket_id').all(allocationId),
      schema:db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()};
    const usage=db.query<{charged:number;attempts:number;unknowns:number},[string]>("SELECT COALESCE(SUM(charged_micros),0) AS charged,COUNT(*) AS attempts,COALESCE(SUM(CASE WHEN state!='settled' THEN 1 ELSE 0 END),0) AS unknowns FROM spend_attempts WHERE ticket_id=?").get(allocationId)!;
    const campaignCharged=db.query<{charged:number},[string]>('SELECT COALESCE(SUM(a.charged_micros),0) AS charged FROM spend_attempts a JOIN spend_tickets t ON t.ticket_id=a.ticket_id WHERE t.campaign_id=?').get(campaignId)!.charged;
    const terminal=db.query<{terminal_reason:string|null},[string]>('SELECT terminal_reason FROM spend_tickets WHERE ticket_id=?').get(allocationId);
    return {priorHash:sha(JSON.stringify(prior)),campaign,ticket,
      otherTickets:db.query<{n:number},[string,string]>('SELECT COUNT(*) AS n FROM spend_tickets WHERE campaign_id=? AND ticket_id<>?').get(campaignId,allocationId)!.n,
      codingPolicy:db.query('SELECT * FROM spend_coding_policies WHERE ticket_id=?').get(allocationId)!==null,
      candidateAttempts:usage.attempts,
      status:ticket&&campaign?{ticketId:allocationId,campaignId:ticket.campaign_id,state:ticket.state as SpendStatus['state'],terminalReason:terminal!.terminal_reason,
        draftPr:ticket.draft_pr===1,capMicros:ticket.cap_micros,chargedMicros:usage.charged,remainingMicros:ticket.cap_micros-usage.charged,
        attemptCount:usage.attempts,unknownAttempts:usage.unknowns,campaignCapMicros:campaign.cap_micros,campaignChargedMicros:campaignCharged}:null};
  } finally{db.close();}
}
export interface EngineeringBudgetBinding {
  aggregatePath:string;ledgerPath:string;auditDir:string;runId:string;grantId:string;campaignId:string;allocationId:string;
  sourceRevision:string;runtimeConfigSha256:string;authoritySha256:string;
}
export interface EngineeringAcceptanceAdmissionOptions extends EngineeringBudgetBinding {
  expectedAggregateSha256:string;apply?:boolean;resumePartial?:boolean;
  /** Offline failure/race injection; never exposed as CLI options. */
  onStage?:(stage:'locked'|'audit_prepared'|'hold_durable'|'campaign_created'|'allocation_enrolled')=>void;
}
function validateBinding(o:EngineeringBudgetBinding):void {
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(o.runId)||![o.grantId,o.campaignId,o.allocationId].every(id=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))
    ||o.campaignId===o.allocationId||!/^[a-f0-9]{40}$/.test(o.sourceRevision)
    ||![o.runtimeConfigSha256,o.authoritySha256].every(hash=>/^[a-f0-9]{64}$/.test(hash)))fail('invalid_admission_binding');
  canonical(o.aggregatePath);canonical(o.ledgerPath);canonical(o.auditDir);
}
function admissionBinding(o:EngineeringBudgetBinding) {
  return {kind:'hermes_engineering_acceptance',runId:o.runId,grantId:o.grantId,campaignId:o.campaignId,allocationId:o.allocationId,
    ledgerPath:o.ledgerPath,capUsdExact:'5.650000000',draftPr:false,codingReviewReserve:false,publication:'patch_only',
    sourceRevision:o.sourceRevision,runtimeConfigSha256:o.runtimeConfigSha256,authoritySha256:o.authoritySha256,commonfieldEarmarkMicros:3000000};
}
function boundMatches(record:RecordJson,bound:ReturnType<typeof admissionBinding>):boolean {
  return Object.entries(bound).every(([key,value])=>typeof value==='number'
    ? record[key] instanceof JsonNumber&&(record[key] as JsonNumber).literal===String(value):record[key]===value);
}
function addEngineeringHold(budget:RecordJson,bound:ReturnType<typeof admissionBinding>,holdId:string,auditPath:string,hash:string,timestamp:string):string {
  const current=totals(budget);if(current.remaining-COMMONFIELD_EARMARK<CAP)fail('aggregate_headroom_insufficient');
  (budget.runtimeAllocations as Json[]).push({id:holdId,amountUsd:number(CAP),state:'held_for_engineering_acceptance',retainedAmountUsd:number(CAP),
    retiredUnusedAuthorizationUsd:number(0n),retainedUnknownCostsUsd:number(0n),
    admission:{...bound,commonfieldEarmarkMicros:new JsonNumber('3000000'),aggregateBeforeSha256:hash,auditRecord:auditPath},
    rule:'One native engineering patch-only acceptance. Every work, auxiliary and independent review request counts within this fixed cap. Hold retained on partial failure; no publication, refill, old allocation reuse or request-ledger reset.'});
  budget.runtimeCommittedOrHeldUsd=number(current.held+CAP);budget.runtimeUnallocatedUsd=number(current.remaining-CAP);
  budget.totalCommittedOrHeldUsd=number(current.held+CAP+40_000_000_000n);budget.bookkeepingUpdatedAt=timestamp;totals(budget);
  return encode(budget)+'\n';
}
function assertPrivateAuditDirectory(path:string):void {
  canonical(path);const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)fail('unsafe_audit_directory');
}
function assertLedgerIdentity(intent:RecordJson,ledgerIdentity:Stats):void {
  if(!record(intent.ledgerMetadata)||['dev','ino','uid','gid','mode'].some(k=>!((intent.ledgerMetadata as RecordJson)[k] instanceof JsonNumber)
    ||((intent.ledgerMetadata as RecordJson)[k] as JsonNumber).literal!==String(ledgerIdentity[k as keyof Stats])))fail('recovery_ledger_identity_changed');
}
function assertHold(hold:Json|undefined,bound:ReturnType<typeof admissionBinding>,auditPath:string):asserts hold is RecordJson {
  if(!record(hold)||!record(hold.admission)||!boundMatches(hold.admission,bound)||money(hold.retainedAmountUsd)!==CAP||money(hold.amountUsd)!==CAP
    ||money(hold.retainedUnknownCostsUsd)!==0n||money(hold.retiredUnusedAuthorizationUsd)!==0n||hold.state!=='held_for_engineering_acceptance'
    ||hold.admission.auditRecord!==auditPath||typeof hold.admission.aggregateBeforeSha256!=='string')fail('existing_hold_binding_mismatch');
}
function assertLedgerBinding(prior:LedgerState,campaignId:string):asserts prior is LedgerState&{status:SpendStatus} {
  const status=prior.status;
  if(!status||prior.ticket?.campaign_id!==campaignId||status.campaignId!==campaignId||status.capMicros!==ENGINEERING_ACCEPTANCE_CAP_MICROS||status.campaignCapMicros!==ENGINEERING_ACCEPTANCE_CAP_MICROS
    ||status.draftPr||status.state!=='active'||status.terminalReason!==null||prior.otherTickets!==0||prior.codingPolicy
    ||!Number.isSafeInteger(status.chargedMicros)||status.chargedMicros<0||status.chargedMicros>status.capMicros
    ||status.campaignChargedMicros!==status.chargedMicros)fail('existing_ledger_binding_mismatch');
}

/** Read-only readiness/admission guard. The operator must independently validate
 * the approval and runtime config whose exact hashes are bound here. This never
 * creates an allocation, releases a hold, or authorizes a model request by itself.
 * requireUnused belongs at first task admission; ongoing health must allow usage. */
export function assertEngineeringBudgetAdmission(binding:EngineeringBudgetBinding,options:{requireUnused?:boolean}={}) {
  const o={...binding};validateBinding(o);assertPrivateAuditDirectory(o.auditDir);
  const bound=admissionBinding(o),holdId='hermes-engineering-acceptance:'+o.runId,auditPath=join(o.auditDir,o.runId+'.intent.json');
  const current=safeFile(o.aggregatePath),budget=parseExact(current.bytes.toString());if(!record(budget))fail('aggregate_not_object');
  const sum=totals(budget),hold=(budget.runtimeAllocations as Json[]).find(a=>record(a)&&a.id===holdId);
  assertHold(hold,bound,auditPath);
  const intent=parseExact(safeFile(auditPath).bytes.toString()),enrolled=parseExact(safeFile(join(o.auditDir,o.runId+'.enrolled.json')).bytes.toString());
  if(!record(intent)||!boundMatches(intent,bound)||intent.aggregatePath!==o.aggregatePath
    ||!(intent.schemaVersion instanceof JsonNumber)||intent.schemaVersion.literal!=='1'
    ||typeof intent.beforeSha256!=='string'||typeof intent.afterSha256!=='string'||typeof intent.priorLedgerRowsSha256!=='string'
    ||!record(enrolled)||!(enrolled.schemaVersion instanceof JsonNumber)||enrolled.schemaVersion.literal!=='1'
    ||!boundMatches(enrolled,bound)||enrolled.holdId!==holdId||enrolled.aggregateBeforeSha256!==intent.beforeSha256
    ||enrolled.priorLedgerRowsSha256!==intent.priorLedgerRowsSha256||enrolled.enrollment!=='immutable_cap_5650000_micros_draft_false')fail('readiness_audit_mismatch');
  const before=safeFile(join(o.auditDir,o.runId+'.before.json')),after=safeFile(join(o.auditDir,o.runId+'.after.json'));
  if(before.hash!==intent.beforeSha256||after.hash!==intent.afterSha256||(hold.admission as RecordJson).aggregateBeforeSha256!==before.hash)fail('readiness_audit_mismatch');
  const old=parseExact(before.bytes.toString()),next=parseExact(after.bytes.toString());
  if(!record(old)||!record(next)||typeof next.bookkeepingUpdatedAt!=='string'
    ||addEngineeringHold(old,bound,holdId,auditPath,before.hash,next.bookkeepingUpdatedAt)!==after.bytes.toString())fail('recovery_transition_mismatch');
  const auditedHold=(next.runtimeAllocations as Json[]).find(a=>record(a)&&a.id===holdId);
  if(!auditedHold||encode(auditedHold)!==encode(hold))fail('existing_hold_binding_mismatch');
  const ledgerIdentity=safeFile(o.ledgerPath).stat;assertLedgerIdentity(intent,ledgerIdentity);
  const state=ledgerState(o.ledgerPath,o.campaignId,o.allocationId);assertLedgerBinding(state,o.campaignId);
  if(options.requireUnused&&state.status.attemptCount!==0)fail('allocation_already_used');
  return Object.freeze({holdId,capMicros:ENGINEERING_ACCEPTANCE_CAP_MICROS,aggregateCurrentSha256:current.hash,
    runtimeHeldUsd:nanoToUsd(sum.held),runtimeUnallocatedUsd:nanoToUsd(sum.remaining),runtimeUnearmarkedUsd:nanoToUsd(sum.remaining-COMMONFIELD_EARMARK),
    status:Object.freeze({...state.status})});
}
export function admitEngineeringAcceptance(options:EngineeringAcceptanceAdmissionOptions) {
  const o={...options};
  validateBinding(o);if(!/^[a-f0-9]{64}$/.test(o.expectedAggregateSha256))fail('invalid_admission_binding');
  const holdId='hermes-engineering-acceptance:'+o.runId,lockPath=o.aggregatePath+'.admission.lock',owner=JSON.stringify({version:1,pid:process.pid,claim:randomUUID(),runId:o.runId,campaignId:o.campaignId,allocationId:o.allocationId})+'\n';
  const bound=admissionBinding(o);
  let lockStat:Stats|undefined;
  if(o.apply){mkdirSync(lockPath,{mode:0o700});lockStat=lstatSync(lockPath);syncDir(dirname(lockPath));writeNew(join(lockPath,'claim.json'),owner);}
  try {
    if(o.apply)o.onStage?.('locked');
    const before=safeFile(o.aggregatePath),parsed=parseExact(before.bytes.toString('utf8'));if(!record(parsed))fail('aggregate_not_object');
    const sum=totals(parsed),allocations=parsed.runtimeAllocations as Json[];
    const prior=ledgerState(o.ledgerPath,o.campaignId,o.allocationId),ledgerIdentity=safeFile(o.ledgerPath).stat;
    const existing=allocations.find(a=>record(a)&&a.id===holdId);
    for(const a of allocations)if(record(a)&&a.id!==holdId&&record(a.admission)
      &&(a.admission.runId===o.runId||a.admission.campaignId===o.campaignId||a.admission.allocationId===o.allocationId
        ||a.admission.kind===bound.kind&&(a.admission.grantId===o.grantId||a.admission.authoritySha256===o.authoritySha256)))fail('admission_identity_already_bound');
    let afterText:string,originalHash:string,recovery=false;
    const auditPath=join(o.auditDir,o.runId+'.intent.json'),beforePath=join(o.auditDir,o.runId+'.before.json'),afterPath=join(o.auditDir,o.runId+'.after.json');
    const addHold=(budget:RecordJson,hash:string,timestamp:string)=>addEngineeringHold(budget,bound,holdId,auditPath,hash,timestamp);
    const readAudit=()=>{
      const intent=parseExact(safeFile(auditPath).bytes.toString());
      if(!record(intent)||!boundMatches(intent,bound)||intent.aggregatePath!==o.aggregatePath
        ||typeof intent.beforeSha256!=='string'||typeof intent.afterSha256!=='string'||intent.priorLedgerRowsSha256!==prior.priorHash)fail('recovery_audit_mismatch');
      const original=safeFile(beforePath),after=safeFile(afterPath);
      if(original.hash!==intent.beforeSha256||after.hash!==intent.afterSha256)fail('recovery_audit_mismatch');
      assertLedgerIdentity(intent,ledgerIdentity);
      const old=parseExact(original.bytes.toString()),next=parseExact(after.bytes.toString());
      if(!record(old)||!record(next)||typeof next.bookkeepingUpdatedAt!=='string'
        ||addHold(old,original.hash,next.bookkeepingUpdatedAt)!==after.bytes.toString())fail('recovery_transition_mismatch');
      return {original,after};
    };
    if(existing!==undefined){
      if(!o.resumePartial)fail('explicit_partial_recovery_required');
      if(!record(existing)||!record(existing.admission))fail('existing_hold_binding_mismatch');
      const admission=existing.admission;
      if(!boundMatches(admission,bound)||money(existing.retainedAmountUsd)!==CAP||money(existing.amountUsd)!==CAP
        ||money(existing.retainedUnknownCostsUsd)!==0n||existing.state!=='held_for_engineering_acceptance'||admission.auditRecord!==auditPath
        ||typeof admission.aggregateBeforeSha256!=='string')fail('existing_hold_binding_mismatch');
      originalHash=admission.aggregateBeforeSha256;
      if(o.expectedAggregateSha256!==originalHash&&o.expectedAggregateSha256!==before.hash)fail('aggregate_hash_mismatch');
      const audit=readAudit();
      if(audit.original.hash!==originalHash||audit.after.hash!==before.hash)fail('recovery_aggregate_changed');
      afterText=audit.after.bytes.toString();recovery=true;
      try{safeFile(join(o.auditDir,o.runId+'.enrolled.json'));if(!prior.campaign||!prior.ticket)fail('completed_enrollment_rows_missing');fail('admission_already_completed');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    } else {
      if(before.hash!==o.expectedAggregateSha256)fail('aggregate_hash_mismatch');
      if(prior.campaign||prior.ticket||prior.candidateAttempts!==0||prior.codingPolicy)fail('unbound_existing_ledger_ids');
      originalHash=before.hash;afterText=addHold(parsed,before.hash,new Date().toISOString());
      // A failure after preparing audit files but before replacing the aggregate may
      // resume only the exact same transition. Reuse the original timestamp/bytes.
      let prepared:Snapshot|undefined;
      try{prepared=safeFile(afterPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(prepared&&!o.resumePartial)fail('explicit_partial_recovery_required');
      if(o.resumePartial&&!prepared)fail('partial_admission_missing');
      if(prepared){const candidate=parseExact(prepared.bytes.toString()),old=parseExact(before.bytes.toString());
        if(!record(candidate)||!record(old)||typeof candidate.bookkeepingUpdatedAt!=='string'
          ||addHold(old,before.hash,candidate.bookkeepingUpdatedAt)!==prepared.bytes.toString())fail('prepared_audit_conflict');
        afterText=prepared.bytes.toString();}
      try{const audit=readAudit();if(audit.original.hash!==before.hash||audit.after.hash!==sha(afterText))fail('prepared_audit_conflict');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(prior.campaign&&prior.campaign.cap_micros!==5_650_000||prior.ticket&&(prior.ticket.campaign_id!==o.campaignId||prior.ticket.cap_micros!==5_650_000||prior.ticket.draft_pr!==0)
      ||prior.otherTickets!==0||prior.codingPolicy)fail('existing_ledger_binding_mismatch');
    if(prior.candidateAttempts!==0||prior.status&&prior.status.state!=='active')fail('allocation_already_used');
    const preview={runId:o.runId,holdId,campaignId:o.campaignId,allocationId:o.allocationId,aggregatePath:o.aggregatePath,ledgerPath:o.ledgerPath,
      capUsd:'5.650000000',aggregateBeforeSha256:originalHash,aggregateCurrentSha256:before.hash,aggregateAfterSha256:sha(afterText),recovery,
      runtimeHeldUsd:nanoToUsd(sum.held+(recovery?0n:CAP)),runtimeUnallocatedUsd:nanoToUsd(sum.remaining-(recovery?0n:CAP)),unknownHoldsUsd:nanoToUsd(sum.unknown),
      commonfieldEarmarkUsd:nanoToUsd(COMMONFIELD_EARMARK),runtimeUnearmarkedUsd:nanoToUsd(sum.remaining-(recovery?0n:CAP)-COMMONFIELD_EARMARK)};
    if(!o.apply)return {...preview,applied:false,canRun:false,status:null};
    try{mkdirSync(o.auditDir,{mode:0o700});syncDir(dirname(o.auditDir));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    assertPrivateAuditDirectory(o.auditDir);
    if(!recovery){
      writeOnce(beforePath,before.bytes.toString());writeOnce(afterPath,afterText);
      writeOnce(auditPath,JSON.stringify({schemaVersion:1,...bound,aggregatePath:o.aggregatePath,beforeSha256:before.hash,afterSha256:sha(afterText),
        priorLedgerRowsSha256:prior.priorHash,ledgerMetadata:{dev:ledgerIdentity.dev,ino:ledgerIdentity.ino,uid:ledgerIdentity.uid,gid:ledgerIdentity.gid,mode:ledgerIdentity.mode},sourceMetadata:{dev:before.stat.dev,ino:before.stat.ino,uid:before.stat.uid,gid:before.stat.gid,mode:before.stat.mode,size:before.stat.size},
        scope:'Aggregate hold first; JSON and SQLite are not one atomic transaction. No HTTP. All historical liabilities retained.'},null,2)+'\n');
      o.onStage?.('audit_prepared');
      if(!same(before,safeFile(o.aggregatePath)))fail('aggregate_changed_before_commit');
      const temporary=o.aggregatePath+'.'+randomUUID()+'.tmp';
      try{writeNew(temporary,afterText,before.stat.mode&0o777);const fd=openSync(temporary,constants.O_WRONLY|constants.O_NOFOLLOW);
        try{fchmodSync(fd,before.stat.mode&0o777);fchownSync(fd,before.stat.uid,before.stat.gid);fsyncSync(fd);}finally{closeSync(fd);}
        if(!same(before,safeFile(o.aggregatePath)))fail('aggregate_changed_before_commit');renameSync(temporary,o.aggregatePath);syncDir(dirname(o.aggregatePath));
      } finally {try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    }
    const durable=safeFile(o.aggregatePath);if(durable.hash!==sha(afterText))fail('aggregate_hold_verification_failed');
    o.onStage?.('hold_durable');
    const ledgerNow=safeFile(o.ledgerPath).stat;if(ledgerNow.dev!==ledgerIdentity.dev||ledgerNow.ino!==ledgerIdentity.ino)fail('ledger_replaced');
    if(ledgerState(o.ledgerPath,o.campaignId,o.allocationId).priorHash!==prior.priorHash)fail('historical_ledger_rows_changed');
    const ledger=openSpendLedger(o.ledgerPath);
    try {
      ledger.createCampaign(o.campaignId,5.65);o.onStage?.('campaign_created');
      ledger.enrollTicket(o.campaignId,o.allocationId,5.65,{draftPr:false});o.onStage?.('allocation_enrolled');
      const status=ledger.status(o.allocationId)!;
      if(status.campaignId!==o.campaignId||status.capMicros!==5_650_000||status.campaignCapMicros!==5_650_000||status.draftPr||ledger.hasCodingReviewReserve(o.allocationId)
        ||status.state!=='active'||status.attemptCount!==0)fail('enrollment_verification_failed');
      if(ledgerState(o.ledgerPath,o.campaignId,o.allocationId).priorHash!==prior.priorHash)fail('historical_ledger_rows_changed');
      writeOnce(join(o.auditDir,o.runId+'.enrolled.json'),JSON.stringify({schemaVersion:1,...bound,aggregateBeforeSha256:originalHash,
        holdId,priorLedgerRowsSha256:prior.priorHash,enrollment:'immutable_cap_5650000_micros_draft_false'},null,2)+'\n');
      return {...preview,applied:true,canRun:status.state==='active'&&status.attemptCount===0,status};
    } finally {ledger.close();}
  } finally {
    if(lockStat){const current=lstatSync(lockPath);if(current.dev!==lockStat.dev||current.ino!==lockStat.ino||safeFile(join(lockPath,'claim.json')).bytes.toString()!==owner)fail('lock_identity_changed');
      unlinkSync(join(lockPath,'claim.json'));rmdirSync(lockPath);syncDir(dirname(lockPath));}
  }
}
