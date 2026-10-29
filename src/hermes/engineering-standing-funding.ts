/** Read-only proof that a finite standing pool has distinct recorded funds.
 * This module never creates a hold, enrolls SQL, releases history or authorizes a
 * provider call. The trusted operator supplies the approval evidence hash. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { StandingEngineeringBudgetAuthority } from './engineering-standing-budget.ts';
import { ENGINEERING_STANDING_MIN_TASK_CAP_MICROS } from './engineering-policy.ts';
class JsonNumber { constructor(readonly literal:string){} }
type Json = null|boolean|string|JsonNumber|Json[]|{[key:string]:Json};
type RecordJson = {[key:string]:Json};
function fail(code:string):never {throw new Error('engineering_standing_funding:'+code);}
const record=(v:Json|undefined):v is RecordJson=>!!v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof JsonNumber);
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const UNKNOWN_FLOOR=4_444_468_350n;
const COMMONFIELD_EARMARK=3_000_000_000n;


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
function usdToNano(value:string):bigint {
  const match=value.length<=32?value.match(/^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/):null;if(!match)fail('invalid_usd_precision');
  return BigInt(match[1]!)*1_000_000_000n+BigInt((match[2]??'').padEnd(9,'0'));
}
const money=(v:Json|undefined)=>v instanceof JsonNumber?usdToNano(v.literal):fail('money_must_be_json_number');

interface Snapshot {bytes:Buffer;hash:string;stat:Stats;}
function canonical(path:string):string {
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(dirname(path))!==dirname(path))fail('noncanonical_or_symlink_path');
  const parent=lstatSync(dirname(path));if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o022)!==0)fail('unsafe_parent_metadata');
  return path;
}
function safeFile(path:string, privateFile=false):Snapshot {
  canonical(path);const before=lstatSync(path);
  if(privateFile && ((before.mode&0o077)!==0 || (lstatSync(dirname(path)).mode&0o077)!==0))fail('private_file_metadata');
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o022)!==0)fail('unsafe_file_metadata');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd);if(stat.dev!==before.dev||stat.ino!==before.ino)fail('file_replaced');
    if(stat.size>4_194_304)fail('file_too_large');const bytes=readFileSync(fd),after=fstatSync(fd);
    if(bytes.length!==stat.size||['dev','ino','size','uid','gid','mode','mtimeMs','ctimeMs'].some(k=>stat[k as keyof Stats]!==after[k as keyof Stats]))fail('file_changed');
    return {bytes,hash:sha(bytes),stat};} finally {closeSync(fd);}
}
function totals(budget:RecordJson,runtimeCap=60_000_000_000n) {
  if(!(budget.schemaVersion instanceof JsonNumber)||budget.schemaVersion.literal!=='2'||!Array.isArray(budget.runtimeAllocations))fail('unsupported_aggregate_schema');
  if(money(budget.totalCeilingUsd)!==runtimeCap+40_000_000_000n||money(budget.runtimePoolUsd)!==runtimeCap
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
  const remaining=runtimeCap-held;if(remaining<0n||money(budget.runtimeCommittedOrHeldUsd)!==held||money(budget.runtimeUnallocatedUsd)!==remaining
    ||money(budget.totalCommittedOrHeldUsd)!==held+40_000_000_000n||money(budget.runtimeUnknownHoldsUsd)!==unknown
    ||money(budget.runtimeAuthorizationRetiredUsd)!==retired||unknown<UNKNOWN_FLOOR)fail('aggregate_totals_mismatch');
  if(!earmarkObserved||remaining<COMMONFIELD_EARMARK)fail('commonfield_earmark_mismatch');
  return {held,unknown,retired,remaining};
}

const HASH=/^[a-f0-9]{64}$/;
function exact(v:Json|undefined,keys:string[]):asserts v is RecordJson {
  if(!record(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail('record_shape');
}
function matches(v:RecordJson,expected:Record<string,string|number|boolean>):boolean {
  return Object.entries(expected).every(([k,want])=>typeof want==='number'
    ? v[k] instanceof JsonNumber && (v[k] as JsonNumber).literal===String(want) : v[k]===want);
}
function readPinned(path:string,expected:string) {
  if(typeof expected!=='string'||expected.length!==64||!HASH.test(expected))fail('file_hash');const file=safeFile(path,true);if(file.hash!==expected)fail('file_hash');
  return parseExact(file.bytes.toString('utf8'));
}
function reference(v:Json|undefined):{path:string;sha256:string} {
  exact(v,['path','sha256']);if(typeof v.path!=='string'||typeof v.sha256!=='string'||v.sha256.length!==64||!HASH.test(v.sha256))fail('reference');
  return {path:v.path,sha256:v.sha256};
}
function parseAggregate(v:Json,runtimeCap:bigint):RecordJson {if(!record(v))fail('aggregate');totals(v,runtimeCap);return v;}
function micros(v:Json|undefined):number {
  if(!(v instanceof JsonNumber)||! /^(0|[1-9][0-9]*)$/.test(v.literal))fail('funding_envelope');
  const n=Number(v.literal);if(!Number.isSafeInteger(n)||n>1_000_000_000)fail('funding_envelope');return n;
}
export interface StandingEngineeringFundingOptions {
  authority:StandingEngineeringBudgetAuthority;
  fundingAuthorityPath:string;
  fundingHoldReceiptPath:string;
  aggregatePath:string;
  /** Canonical spend database selected by startup, never a worker-selected path. */
  ledgerPath:string;
}

/** Rechecks every approval/receipt byte and the current aggregate. Conservatively
 * retains every previously audited allocation verbatim, including unknown holds.
 * Legitimate reconciliation of those old holds needs a separately reviewed proof. */
export function createStandingEngineeringFundingGuard(input:StandingEngineeringFundingOptions):()=>void {
  const o=Object.freeze({...input,authority:Object.freeze({...input.authority})}),a=o.authority;
  if(a.version!==1||![a.poolId,a.campaignId].every(s=>typeof s==='string'&&s===s.trim()&&s.length<=128&&/^standing-engineering-[A-Za-z0-9_.:-]+$/.test(s))
    ||a.poolId===a.campaignId||!Number.isSafeInteger(a.capMicros)||a.capMicros>1_000_000_000
    ||!Number.isSafeInteger(a.taskCapMicros)||a.taskCapMicros<ENGINEERING_STANDING_MIN_TASK_CAP_MICROS||a.capMicros<a.taskCapMicros
    ||![a.authoritySha256,a.holdReceiptSha256].every(h=>typeof h==='string'&&h.length===64&&HASH.test(h)))fail('authority_binding');
  const bound={poolId:a.poolId,campaignId:a.campaignId,capMicros:a.capMicros,taskCapMicros:a.taskCapMicros,
    aggregatePath:o.aggregatePath,ledgerPath:o.ledgerPath};
  const holdId='standing-engineering:'+a.poolId,cap=BigInt(a.capMicros)*1000n;
  return function assertFunding() {
    canonical(o.aggregatePath);canonical(o.ledgerPath);
    // A relocation leaves this tombstone beside the old aggregate; its grant is closed.
    try {lstatSync(o.aggregatePath+'.admission.lock/transferred.json');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&(error as NodeJS.ErrnoException).code!=='ENOTDIR')throw error;return check();}
    return fail('aggregate_transferred');
  };
  function check() {
    const ledger=lstatSync(o.ledgerPath);
    if(!ledger.isFile()||ledger.isSymbolicLink()||ledger.nlink!==1||ledger.uid!==process.getuid?.()||(ledger.mode&0o022)!==0)fail('ledger_metadata');
    const authority=readPinned(o.fundingAuthorityPath,a.authoritySha256);
    exact(authority,['version','kind','approved','poolId','campaignId','capMicros','taskCapMicros','aggregatePath','ledgerPath','approvalEvidenceSha256','aggregateBeforeRuntimePoolMicros','additionalRuntimePoolMicros']);
    if(!matches(authority,{...bound,version:1,kind:'standing_engineering_funding',approved:true})
      ||typeof authority.approvalEvidenceSha256!=='string'||authority.approvalEvidenceSha256.length!==64||!HASH.test(authority.approvalEvidenceSha256))fail('authority_binding');
    const oldPoolMicros=micros(authority.aggregateBeforeRuntimePoolMicros),additionMicros=micros(authority.additionalRuntimePoolMicros);
    if(oldPoolMicros<60_000_000||oldPoolMicros+additionMicros>1_000_000_000)fail('funding_envelope');
    const oldPool=BigInt(oldPoolMicros)*1000n,newPool=BigInt(oldPoolMicros+additionMicros)*1000n;
    const receipt=readPinned(o.fundingHoldReceiptPath,a.holdReceiptSha256);
    const transferred=record(receipt)&&Object.hasOwn(receipt,'transfer');
    exact(receipt,['version','kind','poolId','campaignId','capMicros','taskCapMicros','authoritySha256','aggregatePath','ledgerPath','before','after','aggregateBeforeRuntimePoolMicros','additionalRuntimePoolMicros',
      ...(transferred?['transfer']:[])]);
    if(!matches(receipt,{...bound,version:1,kind:'standing_engineering_hold',authoritySha256:a.authoritySha256,
      aggregateBeforeRuntimePoolMicros:oldPoolMicros,additionalRuntimePoolMicros:additionMicros}))fail('hold_receipt_binding');
    const beforeRef=reference(receipt.before),afterRef=reference(receipt.after);
    const transferRef=transferred?reference(receipt.transfer):undefined;
    const paths=[o.aggregatePath,o.ledgerPath,o.fundingAuthorityPath,o.fundingHoldReceiptPath,beforeRef.path,afterRef.path,...(transferRef?[transferRef.path]:[])];
    if(new Set(paths).size!==paths.length)fail('aliased_proof_paths');
    const before=parseAggregate(readPinned(beforeRef.path,beforeRef.sha256),oldPool),after=parseAggregate(readPinned(afterRef.path,afterRef.sha256),newPool);
    // A relocated grant's `before` is not a raw snapshot: it is the frozen source
    // aggregate with exactly one earlier standing hold retired to fund this one.
    if(transferRef){
      if(additionMicros!==0)fail('transfer_binding');
      verifyTransfer(transferRef,before,beforeRef.sha256,{poolId:a.poolId,capMicros:a.capMicros,ledgerPath:o.ledgerPath,
        approvalEvidenceSha256:authority.approvalEvidenceSha256 as string},oldPool);
    }
    const old=totals(before,oldPool);if(old.remaining+(newPool-oldPool)-COMMONFIELD_EARMARK<cap)fail('unearmarked_funding_insufficient');
    const prior=before.runtimeAllocations as Json[],next=after.runtimeAllocations as Json[];
    if(next.length!==prior.length+1||prior.some((v,i)=>encode(v)!==encode(next[i]!)))fail('prior_holds_changed');
    if(prior.some(v=>record(v)&&(v.id===holdId||record(v.admission)&&(v.admission.poolId===a.poolId||v.admission.campaignId===a.campaignId
      ||v.admission.authoritySha256===a.authoritySha256))))fail('funding_reuse');
    const hold=next.at(-1);exact(hold,['id','amountUsd','state','retainedAmountUsd','retiredUnusedAuthorizationUsd','retainedUnknownCostsUsd','admission']);
    if(hold.id!==holdId||hold.state!=='held_for_standing_engineering'||money(hold.amountUsd)!==cap||money(hold.retainedAmountUsd)!==cap
      ||money(hold.retiredUnusedAuthorizationUsd)!==0n||money(hold.retainedUnknownCostsUsd)!==0n)fail('hold_binding');
    exact(hold.admission,['kind','poolId','campaignId','capMicros','taskCapMicros','authoritySha256','ledgerPath','auditRecord','aggregateBeforeSha256']);
    if(!matches(hold.admission,{kind:'standing_engineering',poolId:a.poolId,campaignId:a.campaignId,capMicros:a.capMicros,
      taskCapMicros:a.taskCapMicros,authoritySha256:a.authoritySha256,ledgerPath:o.ledgerPath,auditRecord:o.fundingHoldReceiptPath,
      aggregateBeforeSha256:beforeRef.sha256}))fail('hold_binding');
    // Exactly one append and conserved bookkeeping; no implicit budget increase,
    // retirement, acceptance reuse, unknown release, or protected earmark debit.
    const expected={...before,runtimePoolUsd:after.runtimePoolUsd!,totalCeilingUsd:after.totalCeilingUsd!,
      runtimeAllocations:[...prior,hold],runtimeCommittedOrHeldUsd:after.runtimeCommittedOrHeldUsd!,
      runtimeUnallocatedUsd:after.runtimeUnallocatedUsd!,totalCommittedOrHeldUsd:after.totalCommittedOrHeldUsd!,
      bookkeepingUpdatedAt:after.bookkeepingUpdatedAt!};
    if(typeof after.bookkeepingUpdatedAt!=='string'||!Number.isFinite(Date.parse(after.bookkeepingUpdatedAt))
      ||encode(expected)!==encode(after))fail('funding_transition');
    const current=parseAggregate(parseExact(safeFile(o.aggregatePath).bytes.toString('utf8')),newPool);
    const allocations=current.runtimeAllocations as Json[],sum=totals(current,newPool);
    if(next.some(v=>!record(v)||encode(allocations.find(w=>record(w)&&w.id===v.id)??null)!==encode(v)))fail('audited_hold_changed');
    if(sum.unknown<old.unknown||sum.retired!==old.retired)fail('protected_history_changed');
    if(allocations.some(v=>record(v)&&v.id!==holdId&&record(v.admission)
      &&(v.admission.poolId===a.poolId||v.admission.campaignId===a.campaignId||v.admission.authoritySha256===a.authoritySha256)))fail('funding_reuse');
  }
}

const TRANSFER_KEYS=['version','kind','sourceAggregatePath','source','retiredHoldId','retiredAuthoritySha256','retainedMicros','transferredMicros','poolId','ledgerPath','beforeSha256','retiredState','approvalEvidence'];
const RETIRED_STATE='retired_for_standing_transfer';
/** Minimal decimal USD lexeme (at most nine places) for exact JSON numbers. */
function usdLexeme(nano:bigint):string {
  if(nano<0n)fail('negative_usd');const whole=nano/1_000_000_000n,frac=String(nano%1_000_000_000n).padStart(9,'0').replace(/0+$/,'');
  return frac?`${whole}.${frac}`:String(whole);
}
/** The exact `before` a transfer must produce from its frozen source. */
function retiredBefore(source:RecordJson,holdIndex:number,retainedNano:bigint,transferredNano:bigint,updatedAt:Json):RecordJson {
  const allocations=(source.runtimeAllocations as Json[]).slice(),hold=allocations[holdIndex] as RecordJson;
  allocations[holdIndex]={...hold,state:RETIRED_STATE,retainedAmountUsd:new JsonNumber(usdLexeme(retainedNano)),
    retiredUnusedAuthorizationUsd:new JsonNumber(usdLexeme(transferredNano))};
  return {...source,runtimeAllocations:allocations,
    runtimeCommittedOrHeldUsd:new JsonNumber(usdLexeme(money(source.runtimeCommittedOrHeldUsd)-transferredNano)),
    runtimeUnallocatedUsd:new JsonNumber(usdLexeme(money(source.runtimeUnallocatedUsd)+transferredNano)),
    totalCommittedOrHeldUsd:new JsonNumber(usdLexeme(money(source.totalCommittedOrHeldUsd)-transferredNano)),
    runtimeAuthorizationRetiredUsd:new JsonNumber(usdLexeme(money(source.runtimeAuthorizationRetiredUsd)+transferredNano)),
    bookkeepingUpdatedAt:updatedAt};
}
function findStandingHold(source:RecordJson,holdId:string,authoritySha256:string):number {
  const allocations=source.runtimeAllocations as Json[];
  const index=allocations.findIndex(v=>record(v)&&v.id===holdId);const hold=allocations[index];
  if(index<0||allocations.findIndex((v,i)=>i!==index&&record(v)&&v.id===holdId)>=0||!record(hold)||hold.state!=='held_for_standing_engineering'
    ||money(hold.retainedAmountUsd)!==money(hold.amountUsd)||money(hold.retiredUnusedAuthorizationUsd)!==0n||money(hold.retainedUnknownCostsUsd)!==0n
    ||!record(hold.admission)||hold.admission.kind!=='standing_engineering'||hold.admission.authoritySha256!==authoritySha256)fail('transfer_source_hold');
  return index;
}
export const RELOCATION_APPROVAL_KEYS=['version','kind','approver','approvedAt','approvalText','sourceHoldId','retiredPoolId','transferredMicros','newPoolId'] as const;
/** Structured, human-confirmed approval for one exact transfer. */
export function assertRelocationApproval(evidence:Json,expected:{sourceHoldId:string;retiredPoolId:string;transferredMicros:number;newPoolId:string}):void {
  if(!record(evidence)||Object.keys(evidence).length!==RELOCATION_APPROVAL_KEYS.length||RELOCATION_APPROVAL_KEYS.some(k=>!Object.hasOwn(evidence,k)))fail('approval_evidence');
  if(!(evidence.version instanceof JsonNumber)||evidence.version.literal!=='1'||evidence.kind!=='standing_engineering_relocation_approval'
    ||typeof evidence.approver!=='string'||!evidence.approver.trim()||typeof evidence.approvalText!=='string'||!evidence.approvalText.trim()
    ||typeof evidence.approvedAt!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(evidence.approvedAt)||!Number.isFinite(Date.parse(evidence.approvedAt))
    ||evidence.sourceHoldId!==expected.sourceHoldId||evidence.retiredPoolId!==expected.retiredPoolId||evidence.newPoolId!==expected.newPoolId
    ||micros(evidence.transferredMicros)!==expected.transferredMicros)fail('approval_evidence');
}
function verifyTransfer(ref:{path:string;sha256:string},before:RecordJson,beforeSha256:string,
  next:{poolId:string;capMicros:number;ledgerPath:string;approvalEvidenceSha256:string},pool:bigint):void {
  const t=readPinned(ref.path,ref.sha256);exact(t,TRANSFER_KEYS);
  if(t.version instanceof JsonNumber?t.version.literal!=='1':true)fail('transfer_binding');
  if(t.kind!=='standing_engineering_funding_transfer'||t.poolId!==next.poolId||t.ledgerPath!==next.ledgerPath||t.beforeSha256!==beforeSha256
    ||t.retiredState!==RETIRED_STATE||typeof t.sourceAggregatePath!=='string'||typeof t.retiredHoldId!=='string'
    ||typeof t.retiredAuthoritySha256!=='string'||!HASH.test(t.retiredAuthoritySha256))fail('transfer_binding');
  const retained=BigInt(micros(t.retainedMicros))*1000n,transferred=BigInt(micros(t.transferredMicros))*1000n;
  if(transferred!==BigInt(next.capMicros)*1000n)fail('transfer_amount');
  const sourceRef=reference(t.source);const source=parseAggregate(readPinned(sourceRef.path,sourceRef.sha256),pool);
  const index=findStandingHold(source,t.retiredHoldId,t.retiredAuthoritySha256);
  const evidenceRef=reference(t.approvalEvidence);
  if(evidenceRef.sha256!==next.approvalEvidenceSha256)fail('approval_evidence');
  const retiredHold=(source.runtimeAllocations as RecordJson[])[index]!;
  assertRelocationApproval(readPinned(evidenceRef.path,evidenceRef.sha256),{sourceHoldId:t.retiredHoldId,
    retiredPoolId:record(retiredHold.admission)&&typeof retiredHold.admission.poolId==='string'?retiredHold.admission.poolId:'',
    transferredMicros:Number(transferred/1000n),newPoolId:next.poolId});
  // Conservation: what the old hold keeps plus what moves equals the old hold exactly.
  if(retained+transferred!==money((source.runtimeAllocations as RecordJson[])[index]!.amountUsd))fail('transfer_amount');
  if(typeof before.bookkeepingUpdatedAt!=='string'||!Number.isFinite(Date.parse(before.bookkeepingUpdatedAt))
    ||encode(retiredBefore(source,index,retained,transferred,before.bookkeepingUpdatedAt))!==encode(before))fail('transfer_transition');
}

export interface StandingFundingTransferInput {
  /** Exact current bytes of the old aggregate (copied, never edited). */
  sourceAggregateBytes:Buffer; sourceAggregatePath:string;
  retired:{poolId:string;authoritySha256:string;capMicros:number};
  /** Old pool commitments that stay held: committed task caps plus pool charges, settled and quiescent. */
  retainedMicros:number;
  next:{poolId:string;campaignId:string;taskCapMicros:number};
  ledgerPath:string; directory:string; aggregatePath:string; now:Date;
  /** Exact bytes of the structured approval record (RELOCATION_APPROVAL_KEYS); copied into the chain. */
  approvalEvidenceBytes:Buffer;
}
export interface StandingFundingTransferPlan {
  files:readonly {path:string;bytes:Buffer;sha256:string}[];
  authority:StandingEngineeringBudgetAuthority;
  fundingAuthorityPath:string; fundingHoldReceiptPath:string; aggregatePath:string;
}
/** Pure: computes every new file for relocating a standing grant. Writes nothing. */
export function planStandingFundingTransfer(i:StandingFundingTransferInput):StandingFundingTransferPlan {
  if(!Number.isSafeInteger(i.retainedMicros)||i.retainedMicros<0||i.retainedMicros>i.retired.capMicros)fail('transfer_input');
  const parsed=parseExact(i.sourceAggregateBytes.toString('utf8'));if(!record(parsed))fail('aggregate');
  const pool=money(parsed.runtimePoolUsd);const source=parseAggregate(parsed,pool);
  const holdId='standing-engineering:'+i.retired.poolId,index=findStandingHold(source,holdId,i.retired.authoritySha256);
  if(money((source.runtimeAllocations as RecordJson[])[index]!.amountUsd)!==BigInt(i.retired.capMicros)*1000n)fail('transfer_source_hold');
  const transferredMicros=i.retired.capMicros-i.retainedMicros;
  if(transferredMicros<i.next.taskCapMicros||transferredMicros<ENGINEERING_STANDING_MIN_TASK_CAP_MICROS)fail('transfer_insufficient');
  assertRelocationApproval(parseExact(i.approvalEvidenceBytes.toString('utf8')),{sourceHoldId:holdId,retiredPoolId:i.retired.poolId,
    transferredMicros,newPoolId:i.next.poolId});
  const path=(name:string)=>i.directory+'/'+name;
  const evidenceFile={path:path('approval-evidence.json'),bytes:i.approvalEvidenceBytes,sha256:sha(i.approvalEvidenceBytes)};
  const approvalEvidenceSha256=evidenceFile.sha256;
  const file=(name:string,text:string)=>{const bytes=Buffer.from(text+'\n');return {path:path(name),bytes,sha256:sha(bytes)};};
  const sourceFile={path:path('source-aggregate.json'),bytes:i.sourceAggregateBytes,sha256:sha(i.sourceAggregateBytes)};
  const stamp=i.now.toISOString();
  const before=retiredBefore(source,index,BigInt(i.retainedMicros)*1000n,BigInt(transferredMicros)*1000n,stamp);
  totals(before,pool);const beforeFile=file('before-aggregate.json',encode(before));
  const transfer=file('transfer-receipt.json',encode({version:new JsonNumber('1'),kind:'standing_engineering_funding_transfer',
    sourceAggregatePath:i.sourceAggregatePath,source:{path:sourceFile.path,sha256:sourceFile.sha256},retiredHoldId:holdId,
    retiredAuthoritySha256:i.retired.authoritySha256,retainedMicros:new JsonNumber(String(i.retainedMicros)),
    transferredMicros:new JsonNumber(String(transferredMicros)),poolId:i.next.poolId,ledgerPath:i.ledgerPath,
    beforeSha256:beforeFile.sha256,retiredState:RETIRED_STATE,approvalEvidence:{path:evidenceFile.path,sha256:evidenceFile.sha256}}));
  const poolMicros=Number(pool/1000n);
  const authorityFile=file('funding-authority.json',encode({version:new JsonNumber('1'),kind:'standing_engineering_funding',approved:true,
    poolId:i.next.poolId,campaignId:i.next.campaignId,capMicros:new JsonNumber(String(transferredMicros)),taskCapMicros:new JsonNumber(String(i.next.taskCapMicros)),
    aggregatePath:i.aggregatePath,ledgerPath:i.ledgerPath,approvalEvidenceSha256,
    aggregateBeforeRuntimePoolMicros:new JsonNumber(String(poolMicros)),additionalRuntimePoolMicros:new JsonNumber('0')}));
  const holdReceiptPath=path('hold-receipt.json');
  const hold={id:'standing-engineering:'+i.next.poolId,amountUsd:new JsonNumber(usdLexeme(BigInt(transferredMicros)*1000n)),
    state:'held_for_standing_engineering',retainedAmountUsd:new JsonNumber(usdLexeme(BigInt(transferredMicros)*1000n)),
    retiredUnusedAuthorizationUsd:new JsonNumber('0'),retainedUnknownCostsUsd:new JsonNumber('0'),
    admission:{kind:'standing_engineering',poolId:i.next.poolId,campaignId:i.next.campaignId,capMicros:new JsonNumber(String(transferredMicros)),
      taskCapMicros:new JsonNumber(String(i.next.taskCapMicros)),authoritySha256:authorityFile.sha256,ledgerPath:i.ledgerPath,
      auditRecord:holdReceiptPath,aggregateBeforeSha256:beforeFile.sha256}};
  const held=money(before.runtimeCommittedOrHeldUsd)+BigInt(transferredMicros)*1000n;
  const after={...before,runtimeAllocations:[...(before.runtimeAllocations as Json[]),hold],
    runtimeCommittedOrHeldUsd:new JsonNumber(usdLexeme(held)),runtimeUnallocatedUsd:new JsonNumber(usdLexeme(pool-held)),
    totalCommittedOrHeldUsd:new JsonNumber(usdLexeme(held+40_000_000_000n)),bookkeepingUpdatedAt:stamp};
  totals(after,pool);const afterText=encode(after);const afterFile=file('after-aggregate.json',afterText);
  const holdFile=file('hold-receipt.json',encode({version:new JsonNumber('1'),kind:'standing_engineering_hold',poolId:i.next.poolId,campaignId:i.next.campaignId,
    capMicros:new JsonNumber(String(transferredMicros)),taskCapMicros:new JsonNumber(String(i.next.taskCapMicros)),authoritySha256:authorityFile.sha256,
    aggregatePath:i.aggregatePath,ledgerPath:i.ledgerPath,before:{path:beforeFile.path,sha256:beforeFile.sha256},after:{path:afterFile.path,sha256:afterFile.sha256},
    aggregateBeforeRuntimePoolMicros:new JsonNumber(String(poolMicros)),additionalRuntimePoolMicros:new JsonNumber('0'),
    transfer:{path:transfer.path,sha256:transfer.sha256}}));
  const aggregateFile={path:i.aggregatePath,bytes:Buffer.from(afterText+'\n'),sha256:sha(afterText+'\n')};
  return {files:[evidenceFile,sourceFile,beforeFile,transfer,authorityFile,afterFile,holdFile,aggregateFile],
    authority:{version:1,poolId:i.next.poolId,campaignId:i.next.campaignId,capMicros:transferredMicros,taskCapMicros:i.next.taskCapMicros,
      authoritySha256:authorityFile.sha256,holdReceiptSha256:holdFile.sha256},
    fundingAuthorityPath:authorityFile.path,fundingHoldReceiptPath:holdFile.path,aggregatePath:i.aggregatePath};
}
