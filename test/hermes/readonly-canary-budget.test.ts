import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openSpendLedger } from '../../src/spend.ts';
import { admitReadonlyCanary, nanoToUsd, usdToNano, type ReadonlyCanaryAdmissionOptions } from '../../src/hermes/readonly-canary-budget.ts';
const roots:string[]=[];
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const original={schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,
  runtimeCommittedOrHeldUsd:8.687615006,runtimeUnallocatedUsd:51.312384994,totalCommittedOrHeldUsd:48.687615006,
  runtimeUnknownHoldsUsd:4.44446835,runtimeAuthorizationRetiredUsd:46.312384994,hermesPaidCalls:0,
  runtimeAllocations:[{id:'legacy',amountUsd:50,state:'reconciled_retained_hold',retainedAmountUsd:5.095283006,
    retiredUnusedAuthorizationUsd:44.904716994,retainedUnknownCostsUsd:4.44446835,history:{unknown:'never release',cap:50}},
    {id:'old-canary',amountUsd:5,state:'exhausted',retainedAmountUsd:3.592332,retiredUnusedAuthorizationUsd:1.407668,
      retainedUnknownCostsUsd:0,ticketId:'real-existing-ticket',exhaustedRequestLedgerUnchanged:true}],
  lastReconciliation:{exactUsd:{unknown:'4.444468350'},audit:'preserve-all-history'}};
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'readonly-admission-'));chmodSync(root,0o700);roots.push(root);
  const aggregatePath=join(root,'aggregate.json'),ledgerPath=join(root,'spend.db'),auditDir=join(root,'audit');
  writeFileSync(aggregatePath,JSON.stringify(original,null,2)+'\n',{mode:0o600});
  const ledger=openSpendLedger(ledgerPath);ledger.createCampaign('prior',50);ledger.enrollTicket('prior','prior-ticket',50,{draftPr:true});ledger.close();
  const db=new Database(ledgerPath);db.exec("UPDATE spend_tickets SET state='exhausted',terminal_reason='prior_exhausted'; INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('prior-ticket','fake','fake',1,4190885,4190885,'unknown'); INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(1,'ambiguous','{}')");db.close();
  const options:ReadonlyCanaryAdmissionOptions={aggregatePath,ledgerPath,auditDir,runId:'readonly-one',campaignId:'readonly-campaign',allocationId:'local:readonly-one',expectedAggregateSha256:hash(readFileSync(aggregatePath)),apply:true};
  return {root,options};
}
function rows(path:string){const db=new Database(path,{readonly:true});try{return ['spend_campaigns','spend_tickets','spend_attempts','spend_receipts'].map(t=>db.query('SELECT * FROM '+t).all());}finally{db.close();}}
function budget(o:ReadonlyCanaryAdmissionOptions){return JSON.parse(readFileSync(o.aggregatePath,'utf8'));}
function mutate(o:ReadonlyCanaryAdmissionOptions,fn:(b:any)=>void){const b=budget(o);fn(b);writeFileSync(o.aggregatePath,JSON.stringify(b));o.expectedAggregateSha256=hash(readFileSync(o.aggregatePath));}
function run(o:ReadonlyCanaryAdmissionOptions,stage:NonNullable<ReadonlyCanaryAdmissionOptions['onStage']>){return admitReadonlyCanary({...o,onStage:stage});}

test('nanoUSD arithmetic is exact and rejects overprecision/exponents',()=>{
  expect(usdToNano('4.444468350')).toBe(4_444_468_350n);expect(nanoToUsd(usdToNano('8.687615006')+usdToNano('5'))).toBe('13.687615006');
  for(const x of ['-1','1e2','0.0000000001','01','NaN'])expect(()=>usdToNano(x)).toThrow();
});
test('preview is read-only and cannot authorize execution',()=>{
  const {options:o}=fixture(),before=readFileSync(o.aggregatePath),prior=rows(o.ledgerPath);
  const result=admitReadonlyCanary({...o,apply:false});expect(result.applied).toBe(false);expect(result.canRun).toBe(false);
  expect(result.runtimeHeldUsd).toBe('13.687615006');expect(readFileSync(o.aggregatePath)).toEqual(before);expect(rows(o.ledgerPath)).toEqual(prior);
  expect(existsSync(o.auditDir)).toBe(false);expect(existsSync(o.aggregatePath+'.admission.lock')).toBe(false);
});
test('durable hold precedes immutable $5 enrollment and preserves all prior rows and JSON',()=>{
  const {options:o}=fixture(),before=rows(o.ledgerPath);let sawHold=false;
  const result=run(o,stage=>{if(stage==='hold_durable'){sawHold=true;expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.687615006);expect(rows(o.ledgerPath)).toEqual(before);}});
  expect(sawHold).toBe(true);expect(result.canRun).toBe(true);expect(result.status?.draftPr).toBe(false);expect(result.status?.capMicros).toBe(5_000_000);
  const b=budget(o);expect(b.runtimeAllocations.slice(0,2)).toEqual(original.runtimeAllocations);expect(b.lastReconciliation).toEqual(original.lastReconciliation);
  expect(b.runtimeUnknownHoldsUsd).toBe(4.44446835);expect(b.runtimeAuthorizationRetiredUsd).toBe(46.312384994);expect(b.runtimeUnallocatedUsd).toBe(46.312384994);
  expect(b.totalCommittedOrHeldUsd).toBe(53.687615006);expect(b.hermesPaidCalls).toBe(0);
  const after=rows(o.ledgerPath);expect(after[0]!.slice(0,1)).toEqual(before[0]!);expect(after[1]!.slice(0,1)).toEqual(before[1]!);expect(after.slice(2)).toEqual(before.slice(2));
  const intent=JSON.parse(readFileSync(join(o.auditDir,o.runId+'.intent.json'),'utf8'));
  expect(hash(readFileSync(join(o.auditDir,o.runId+'.before.json')))).toBe(intent.beforeSha256);expect(hash(readFileSync(join(o.auditDir,o.runId+'.after.json')))).toBe(intent.afterSha256);
  expect(readFileSync(o.aggregatePath,'utf8')).toContain('13.687615006');expect(readdirSync(o.auditDir).length).toBe(4);
  expect(existsSync(o.aggregatePath+'.admission.lock')).toBe(false);
});
test('exclusive stable lock rejects competing coordinator and does not steal stale locks',()=>{
  const {options:o}=fixture();run(o,stage=>{if(stage==='locked')expect(()=>admitReadonlyCanary({...o,runId:'second'})).toThrow('EEXIST');});
  const lock=o.aggregatePath+'.admission.lock';mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'claim.json'),'operator must inspect',{mode:0o600});
  expect(()=>admitReadonlyCanary(o)).toThrow('EEXIST');expect(readFileSync(join(lock,'claim.json'),'utf8')).toBe('operator must inspect');expect(budget(o).runtimeAllocations.length).toBe(3);
});
for(const fault of ['audit_prepared','hold_durable','campaign_created','allocation_enrolled'] as const)test('exact recovery after '+fault+' never doubles hold or enrollment',()=>{
  const {options:o}=fixture();expect(()=>run(o,stage=>{if(stage===fault)throw new Error('injected_crash');})).toThrow('injected_crash');
  expect(existsSync(o.aggregatePath+'.admission.lock')).toBe(false);
  if(fault!=='audit_prepared')expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.687615006);
  if(fault==='hold_durable')expect(rows(o.ledgerPath)[0]!.length).toBe(1);
  if(fault==='campaign_created'){expect(rows(o.ledgerPath)[0]!.length).toBe(2);expect(rows(o.ledgerPath)[1]!.length).toBe(1);}
  const recovered=admitReadonlyCanary(o);expect(recovered.canRun).toBe(true);expect(budget(o).runtimeAllocations.length).toBe(3);
  expect(rows(o.ledgerPath)[0]!.length).toBe(2);expect(rows(o.ledgerPath)[1]!.length).toBe(2);expect(admitReadonlyCanary(o).recovery).toBe(true);
});
test('once used or closed an existing allocation is never reopened or offered for execution',()=>{
  const {options:o}=fixture();admitReadonlyCanary(o);const db=new Database(o.ledgerPath);
  db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'fake','fake',1,100,100,'unknown')").run(o.allocationId);db.close();
  expect(admitReadonlyCanary(o).canRun).toBe(false);const ledger=openSpendLedger(o.ledgerPath);ledger.markTerminal(o.allocationId,'completed');ledger.close();
  const before=rows(o.ledgerPath);const result=admitReadonlyCanary(o);expect(result.canRun).toBe(false);expect(result.status?.state).toBe('closed');expect(result.status?.unknownAttempts).toBe(1);expect(rows(o.ledgerPath)).toEqual(before);
});
test('partial hold cannot be reused under another ledger, campaign, allocation or run',()=>{
  const {options:o}=fixture();expect(()=>run(o,s=>{if(s==='hold_durable')throw new Error('stop');})).toThrow();
  for(const change of [{campaignId:'different'},{allocationId:'local:different'},{runId:'different'}])expect(()=>admitReadonlyCanary({...o,...change})).toThrow();
  expect(budget(o).runtimeAllocations.length).toBe(3);expect(rows(o.ledgerPath)[0]!.length).toBe(1);
});
test('preexisting SQL IDs require original bound hold and never get fresh reservation',()=>{
  const {options:o}=fixture(),before=readFileSync(o.aggregatePath);
  expect(()=>admitReadonlyCanary({...o,campaignId:'prior'})).toThrow('unbound_existing_ledger_ids');expect(readFileSync(o.aggregatePath)).toEqual(before);
});
test('CAS rejects aggregate bytes or metadata changed after audit preparation',()=>{
  for(const mode of ['bytes','metadata']){const {options:o}=fixture();
    expect(()=>run(o,s=>{if(s==='audit_prepared'){if(mode==='bytes')writeFileSync(o.aggregatePath,readFileSync(o.aggregatePath,'utf8')+' ');else chmodSync(o.aggregatePath,0o640);}})).toThrow('aggregate_changed_before_commit');
    expect(budget(o).runtimeAllocations.length).toBe(2);expect(rows(o.ledgerPath)[0]!.length).toBe(1);
  }
});
test('bad hash, inconsistent totals, caps, precision, duplicate JSON keys and released unknowns fail closed',()=>{
  for(const change of ['hash','total','cap','precision','duplicate','unknown']){
    const {options:o}=fixture();if(change==='hash')o.expectedAggregateSha256='a'.repeat(64);
    else if(change==='total')mutate(o,b=>b.runtimeCommittedOrHeldUsd=8);
    else if(change==='cap')mutate(o,b=>b.runtimePoolUsd=61);
    else if(change==='precision'){writeFileSync(o.aggregatePath,readFileSync(o.aggregatePath,'utf8').replace('4.44446835','4.4444683501'));o.expectedAggregateSha256=hash(readFileSync(o.aggregatePath));}
    else if(change==='duplicate'){writeFileSync(o.aggregatePath,readFileSync(o.aggregatePath,'utf8').replace('"schemaVersion": 2','"schemaVersion": 2, "schemaVersion": 2'));o.expectedAggregateSha256=hash(readFileSync(o.aggregatePath));}
    else mutate(o,b=>{b.runtimeAllocations[0].retainedUnknownCostsUsd=4;b.runtimeUnknownHoldsUsd=4;});
    const before=readFileSync(o.aggregatePath);expect(()=>admitReadonlyCanary(o)).toThrow();expect(readFileSync(o.aggregatePath)).toEqual(before);expect(rows(o.ledgerPath)[0]!.length).toBe(1);
  }
});
test('aggregate, ledger, audit and parent symlinks plus unsafe modes/hardlinks fail closed',()=>{
  for(const target of ['aggregate','ledger','audit','parent','mode','hardlink']){
    const {root,options:o}=fixture();
    if(target==='aggregate'||target==='ledger'){const key=target==='aggregate'?'aggregatePath':'ledgerPath';const path=join(root,'alias');symlinkSync(o[key],path);o[key]=path;}
    else if(target==='audit'){const dir=join(root,'elsewhere');mkdirSync(dir,{mode:0o700});symlinkSync(dir,o.auditDir);}
    else if(target==='parent'){const dir=join(root,'alias');symlinkSync(root,dir);o.aggregatePath=join(dir,'aggregate.json');}
    else if(target==='mode')chmodSync(o.aggregatePath,0o666);else linkSync(o.aggregatePath,join(root,'hardlink'));
    expect(()=>admitReadonlyCanary(o)).toThrow();expect(rows(o.ledgerPath)[0]!.length).toBe(1);
  }
});
test('recovery rejects changed audit, later aggregate changes and ledger mismatch without releasing hold',()=>{
  for(const target of ['audit','aggregate','ledger']){const {options:o}=fixture();expect(()=>run(o,s=>{if(s==='hold_durable')throw new Error('stop');})).toThrow();
    if(target==='audit')writeFileSync(join(o.auditDir,o.runId+'.after.json'),'{}');
    else if(target==='aggregate')writeFileSync(o.aggregatePath,readFileSync(o.aggregatePath,'utf8')+' ');
    else{const ledger=openSpendLedger(o.ledgerPath);ledger.createCampaign(o.campaignId,6);ledger.close();}
    expect(()=>admitReadonlyCanary(o)).toThrow();expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.687615006);
  }
});

test('recovery binds ledger inode and never recreates a completed enrollment after deletion',()=>{
  for(const target of ['replacement','deleted']){const {options:o}=fixture();admitReadonlyCanary(o);
    if(target==='replacement'){const replacement=o.ledgerPath+'.new';copyFileSync(o.ledgerPath,replacement);renameSync(replacement,o.ledgerPath);}
    else{const db=new Database(o.ledgerPath);db.query('DELETE FROM spend_tickets WHERE ticket_id=?').run(o.allocationId);db.close();}
    expect(()=>admitReadonlyCanary(o)).toThrow(target==='replacement'?'recovery_ledger_identity_changed':'completed_enrollment_rows_missing');
    expect(budget(o).runtimeAllocations.length).toBe(3);
  }
});
test('fully allocated runtime pool cannot receive another hold',()=>{
  const {options:o}=fixture();mutate(o,b=>{b.runtimeAllocations.push({id:'other-committed',amountUsd:51.312384994,retainedAmountUsd:51.312384994,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0});b.runtimeCommittedOrHeldUsd=60;b.runtimeUnallocatedUsd=0;b.totalCommittedOrHeldUsd=100;});
  const before=readFileSync(o.aggregatePath);expect(()=>admitReadonlyCanary(o)).toThrow('aggregate_headroom_insufficient');expect(readFileSync(o.aggregatePath)).toEqual(before);expect(rows(o.ledgerPath)[0]!.length).toBe(1);
});
