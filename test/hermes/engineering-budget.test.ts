import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openSpendLedger } from '../../src/spend.ts';
import { admitEngineeringAcceptance, assertEngineeringBudgetAdmission, nanoToUsd, usdToNano, type EngineeringAcceptanceAdmissionOptions } from '../../src/hermes/engineering-budget.ts';

const roots:string[]=[];
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
// Synthetic history with the observed aggregate totals; no live paths or identities.
const original={schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,
  runtimeCommittedOrHeldUsd:50.302993006,runtimeUnallocatedUsd:9.697006994,totalCommittedOrHeldUsd:90.302993006,
  runtimeUnknownHoldsUsd:4.44446835,runtimeAuthorizationRetiredUsd:66.085182994,hermesPaidCalls:3,
  runtimeAllocations:[{id:'legacy',amountUsd:50,state:'reconciled_retained_hold',retainedAmountUsd:5.095283006,
    retiredUnusedAuthorizationUsd:44.904716994,retainedUnknownCostsUsd:4.44446835,history:{unknown:'never release',cap:50}},
    {id:'old-canary',amountUsd:5,state:'exhausted',retainedAmountUsd:3.592332,retiredUnusedAuthorizationUsd:1.407668,
      retainedUnknownCostsUsd:0,exhaustedRequestLedgerUnchanged:true},
    {id:'other-runtime',amountUsd:60,state:'conservative_hold',retainedAmountUsd:40.227202,retiredUnusedAuthorizationUsd:19.772798,retainedUnknownCostsUsd:0},
    {id:'classifier',amountUsd:1.388176,state:'held_for_classifier_canary',retainedAmountUsd:1.388176,retiredUnusedAuthorizationUsd:0,
      retainedUnknownCostsUsd:0,admission:{kind:'classifier_canary',commonfieldEarmarkMicros:3000000}}],
  lastReconciliation:{exactUsd:{unknown:'4.444468350'},audit:'preserve-all-history'}};
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'engineering-budget-'));chmodSync(root,0o700);roots.push(root);
  const aggregatePath=join(root,'aggregate.json'),ledgerPath=join(root,'spend.db'),auditDir=join(root,'audit');
  writeFileSync(aggregatePath,JSON.stringify(original,null,2)+'\n',{mode:0o600});
  const ledger=openSpendLedger(ledgerPath);ledger.createCampaign('prior',10);ledger.enrollTicket('prior','prior-ticket',10,{draftPr:true,codingReviewReserve:true});ledger.close();
  const db=new Database(ledgerPath);db.exec("UPDATE spend_tickets SET state='closed',terminal_reason='prior_complete'; INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('prior-ticket','fake','fake',1,4190885,4190885,'unknown'); INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(1,'ambiguous','{}')");db.close();
  const options:EngineeringAcceptanceAdmissionOptions={aggregatePath,ledgerPath,auditDir,runId:'engineering-one',grantId:'grant-one',campaignId:'engineering-one-campaign',allocationId:'engineering-one-allocation',
    expectedAggregateSha256:hash(readFileSync(aggregatePath)),sourceRevision:'a'.repeat(40),runtimeConfigSha256:'b'.repeat(64),authoritySha256:'c'.repeat(64),apply:true};
  return {root,options};
}
function rows(path:string){const db=new Database(path,{readonly:true});try{return ['spend_campaigns','spend_tickets','spend_attempts','spend_receipts','spend_coding_policies'].map(t=>db.query('SELECT * FROM '+t+' ORDER BY 1').all());}finally{db.close();}}
function budget(o:EngineeringAcceptanceAdmissionOptions){return JSON.parse(readFileSync(o.aggregatePath,'utf8'));}
function mutate(o:EngineeringAcceptanceAdmissionOptions,fn:(b:any)=>void){const b=budget(o);fn(b);writeFileSync(o.aggregatePath,JSON.stringify(b));o.expectedAggregateSha256=hash(readFileSync(o.aggregatePath));}
function run(o:EngineeringAcceptanceAdmissionOptions,stage:NonNullable<EngineeringAcceptanceAdmissionOptions['onStage']>){return admitEngineeringAcceptance({...o,onStage:stage});}

test('exact nanodollars preserve nine-decimal liabilities and reject rounding/ambiguous JSON money',()=>{
  expect(usdToNano('5.650000000')).toBe(5_650_000_000n);
  expect(nanoToUsd(usdToNano('9.697006994')-usdToNano('3')-usdToNano('5.65'))).toBe('1.047006994');
  for(const value of ['-1','1e2','0.0000000001','01','NaN','1'.repeat(33)])expect(()=>usdToNano(value)).toThrow();
});
test('preview is read-only, preserves protected earmarks and cannot authorize a call',()=>{
  const {options:o}=fixture(),before=readFileSync(o.aggregatePath),prior=rows(o.ledgerPath);
  const result=admitEngineeringAcceptance({...o,apply:false});
  expect(result.applied).toBe(false);expect(result.canRun).toBe(false);
  expect(result.capUsd).toBe('5.650000000');expect(result.runtimeHeldUsd).toBe('55.952993006');
  expect(result.runtimeUnallocatedUsd).toBe('4.047006994');expect(result.commonfieldEarmarkUsd).toBe('3.000000000');expect(result.runtimeUnearmarkedUsd).toBe('1.047006994');
  expect(readFileSync(o.aggregatePath)).toEqual(before);expect(rows(o.ledgerPath)).toEqual(prior);
  expect(existsSync(o.auditDir)).toBe(false);expect(existsSync(o.aggregatePath+'.admission.lock')).toBe(false);
});
test('durable aggregate hold and audit precede fresh immutable ordinary $5.65 enrollment',()=>{
  const {options:o}=fixture(),prior=rows(o.ledgerPath);let sawHold=false;
  const result=run(o,stage=>{if(stage==='hold_durable'){
    sawHold=true;expect(rows(o.ledgerPath)).toEqual(prior);expect(budget(o).runtimeCommittedOrHeldUsd).toBe(55.952993006);
    const intent=JSON.parse(readFileSync(join(o.auditDir,o.runId+'.intent.json'),'utf8'));
    expect(hash(readFileSync(join(o.auditDir,o.runId+'.before.json')))).toBe(intent.beforeSha256);
    expect(hash(readFileSync(join(o.auditDir,o.runId+'.after.json')))).toBe(intent.afterSha256);
    expect(intent.runtimeConfigSha256).toBe(o.runtimeConfigSha256);expect(intent.authoritySha256).toBe(o.authoritySha256);
  }});
  expect(sawHold).toBe(true);expect(result.canRun).toBe(true);expect(result.status?.capMicros).toBe(5_650_000);expect(result.status?.campaignCapMicros).toBe(5_650_000);expect(result.status?.draftPr).toBe(false);
  const b=budget(o);expect(b.runtimeAllocations.slice(0,4)).toEqual(original.runtimeAllocations);expect(b.lastReconciliation).toEqual(original.lastReconciliation);
  expect(b.runtimeUnknownHoldsUsd).toBe(4.44446835);expect(b.runtimeAuthorizationRetiredUsd).toBe(66.085182994);expect(b.hermesPaidCalls).toBe(3);
  expect(b.other90HoldUsd).toBe(30);expect(b.bufferHoldUsd).toBe(10);expect(b.totalCommittedOrHeldUsd).toBe(95.952993006);
  const after=rows(o.ledgerPath);expect(after.slice(2)).toEqual(prior.slice(2));
  expect(assertEngineeringBudgetAdmission(o,{requireUnused:true}).status.attemptCount).toBe(0);
});
test('stable lock excludes concurrent coordinators and is never stolen even with a dead-looking owner',()=>{
  const {options:o}=fixture();run(o,stage=>{if(stage==='locked')expect(()=>admitEngineeringAcceptance({...o,runId:'other'})).toThrow('EEXIST');});
  const lock=o.aggregatePath+'.admission.lock';mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'claim.json'),'dead owner still requires operator inspection',{mode:0o600});
  expect(()=>admitEngineeringAcceptance({...o,resumePartial:true})).toThrow('EEXIST');expect(readFileSync(join(lock,'claim.json'),'utf8')).toBe('dead owner still requires operator inspection');
});
for(const fault of ['audit_prepared','hold_durable','campaign_created','allocation_enrolled'] as const)test('explicit exact partial recovery after '+fault+' retains one hold and one enrollment',()=>{
  const {options:o}=fixture();expect(()=>run(o,stage=>{if(stage===fault)throw new Error('injected_failure');})).toThrow('injected_failure');
  expect(existsSync(o.aggregatePath+'.admission.lock')).toBe(false);
  if(fault!=='audit_prepared')expect(budget(o).runtimeCommittedOrHeldUsd).toBe(55.952993006);
  expect(()=>admitEngineeringAcceptance(o)).toThrow('explicit_partial_recovery_required');
  const result=admitEngineeringAcceptance({...o,resumePartial:true});expect(result.canRun).toBe(true);
  expect(budget(o).runtimeAllocations).toHaveLength(5);expect(rows(o.ledgerPath)[0]).toHaveLength(2);expect(rows(o.ledgerPath)[1]).toHaveLength(2);
  expect(()=>admitEngineeringAcceptance({...o,resumePartial:true})).toThrow('admission_already_completed');
});
test('fresh IDs are mandatory and the same approval cannot fund a renamed second acceptance',()=>{
  const {options:o}=fixture(),before=readFileSync(o.aggregatePath);
  expect(()=>admitEngineeringAcceptance({...o,campaignId:'prior'})).toThrow('unbound_existing_ledger_ids');expect(readFileSync(o.aggregatePath)).toEqual(before);
  expect(()=>admitEngineeringAcceptance({...o,resumePartial:true})).toThrow('partial_admission_missing');
  admitEngineeringAcceptance(o);
  expect(()=>admitEngineeringAcceptance({...o,runId:'two',campaignId:'two-campaign',allocationId:'two-allocation',expectedAggregateSha256:hash(readFileSync(o.aggregatePath))})).toThrow('admission_identity_already_bound');
});
test('partial recovery binds exact authority, source, config, ledger identity and unchanged aggregate',()=>{
  for(const target of ['authority','source','config','aggregate','ledger','audit']){
    const {options:o}=fixture();expect(()=>run(o,s=>{if(s==='hold_durable')throw new Error('stop');})).toThrow('stop');
    if(target==='authority')o.authoritySha256='d'.repeat(64);
    else if(target==='source')o.sourceRevision='d'.repeat(40);
    else if(target==='config')o.runtimeConfigSha256='d'.repeat(64);
    else if(target==='aggregate')writeFileSync(o.aggregatePath,readFileSync(o.aggregatePath,'utf8')+' ');
    else if(target==='ledger'){const copy=o.ledgerPath+'.copy';copyFileSync(o.ledgerPath,copy);renameSync(copy,o.ledgerPath);}
    else writeFileSync(join(o.auditDir,o.runId+'.after.json'),'{}');
    expect(()=>admitEngineeringAcceptance({...o,resumePartial:true})).toThrow();expect(budget(o).runtimeCommittedOrHeldUsd).toBe(55.952993006);
  }
});
test('historical attempt, receipt and coding-policy changes during admission fail while retaining the full hold',()=>{
  for(const kind of ['attempt','receipt','coding-policy']){
    const {options:o}=fixture();expect(()=>run(o,s=>{if(s==='hold_durable'){
      const db=new Database(o.ledgerPath);db.exec(kind==='attempt'?"UPDATE spend_attempts SET charged_micros=charged_micros+1 WHERE id=1":kind==='receipt'?"UPDATE spend_receipts SET details_json='changed' WHERE attempt_id=1":"DELETE FROM spend_coding_policies WHERE ticket_id='prior-ticket'");db.close();
    }})).toThrow('historical_ledger_rows_changed');
    expect(budget(o).runtimeCommittedOrHeldUsd).toBe(55.952993006);expect(rows(o.ledgerPath)[0]).toHaveLength(1);
  }
});
test('orphan historical receipts are preserved in the digest and orphan candidate attempts cannot be reused',()=>{
  const {options:o}=fixture();let db=new Database(o.ledgerPath);
  db.exec("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(99,'orphan','{}')");db.close();
  expect(()=>run(o,s=>{if(s==='hold_durable'){db=new Database(o.ledgerPath);db.exec('DELETE FROM spend_receipts WHERE attempt_id=99');db.close();}})).toThrow('historical_ledger_rows_changed');
  const other=fixture().options;db=new Database(other.ledgerPath);
  db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'fake','fake',1,100,100,'unknown')").run(other.allocationId);db.close();
  const before=readFileSync(other.aggregatePath);expect(()=>admitEngineeringAcceptance(other)).toThrow('unbound_existing_ledger_ids');expect(readFileSync(other.aggregatePath)).toEqual(before);
});
test('CAS catches aggregate content and metadata races before replacing it or enrolling SQL',()=>{
  for(const target of ['bytes','metadata']){
    const {options:o}=fixture();expect(()=>run(o,s=>{if(s==='audit_prepared'){
      if(target==='bytes')writeFileSync(o.aggregatePath,readFileSync(o.aggregatePath,'utf8')+' ');else chmodSync(o.aggregatePath,0o640);
    }})).toThrow('aggregate_changed_before_commit');expect(rows(o.ledgerPath)[0]).toHaveLength(1);expect(budget(o).runtimeAllocations).toHaveLength(4);
  }
});
test('bad decimal precision, duplicates, pool caps, unknown liabilities and earmark changes reject without enrollment',()=>{
  for(const kind of ['hash','precision','duplicate','pool','other90','buffer','unknown','earmark','missing-earmark']){
    const {options:o}=fixture();
    if(kind==='hash')o.expectedAggregateSha256='f'.repeat(64);
    else if(kind==='precision'||kind==='duplicate'){
      writeFileSync(o.aggregatePath,readFileSync(o.aggregatePath,'utf8').replace(kind==='precision'?'4.44446835':'"schemaVersion": 2',kind==='precision'?'4.4444683501':'"schemaVersion": 2, "schemaVersion": 2'));
      o.expectedAggregateSha256=hash(readFileSync(o.aggregatePath));
    }else mutate(o,b=>{
      if(kind==='pool')b.runtimePoolUsd=61;else if(kind==='other90')b.other90HoldUsd=29;else if(kind==='buffer')b.bufferHoldUsd=9;
      else if(kind==='unknown'){b.runtimeAllocations[0].retainedUnknownCostsUsd=4;b.runtimeUnknownHoldsUsd=4;}
      else if(kind==='earmark')b.runtimeAllocations[3].admission.commonfieldEarmarkMicros=0;else delete b.runtimeAllocations[3].admission.commonfieldEarmarkMicros;
    });
    const before=readFileSync(o.aggregatePath);expect(()=>admitEngineeringAcceptance(o)).toThrow();expect(readFileSync(o.aggregatePath)).toEqual(before);expect(rows(o.ledgerPath)[0]).toHaveLength(1);
  }
});
test('nominal spare funds cannot spend Commonfield earmark and exact one-nanodollar shortfall rejects',()=>{
  const {options:o}=fixture();mutate(o,b=>{
    b.runtimeAllocations.push({id:'other-extra',amountUsd:1.047006995,retainedAmountUsd:1.047006995,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0});
    b.runtimeCommittedOrHeldUsd=51.350000001;b.runtimeUnallocatedUsd=8.649999999;b.totalCommittedOrHeldUsd=91.350000001;
  });
  expect(()=>admitEngineeringAcceptance(o)).toThrow('aggregate_headroom_insufficient');expect(rows(o.ledgerPath)[0]).toHaveLength(1);
});
test('symlinks, hard links and unsafe file/audit modes reject without changing live-shaped prior rows',()=>{
  for(const target of ['aggregate','ledger','audit','hardlink','mode']){
    const {root,options:o}=fixture();
    if(target==='aggregate'||target==='ledger'){const key=target==='aggregate'?'aggregatePath':'ledgerPath';const alias=join(root,'alias');symlinkSync(o[key],alias);o[key]=alias;}
    else if(target==='audit'){const other=join(root,'other');mkdirSync(other,{mode:0o700});symlinkSync(other,o.auditDir);}
    else if(target==='hardlink')linkSync(o.aggregatePath,join(root,'hardlink'));else chmodSync(o.aggregatePath,0o666);
    expect(()=>admitEngineeringAcceptance(o)).toThrow();expect(rows(o.ledgerPath)[0]).toHaveLength(1);
  }
});
test('read-only ongoing health accepts metered use but fresh admission rejects reuse and never reopens closure',()=>{
  const {options:o}=fixture();admitEngineeringAcceptance(o);const db=new Database(o.ledgerPath);
  db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'fake','fake',1,100,100,'settled')").run(o.allocationId);db.close();
  const before=rows(o.ledgerPath),aggregate=readFileSync(o.aggregatePath);
  expect(assertEngineeringBudgetAdmission(o).status.attemptCount).toBe(1);
  expect(()=>assertEngineeringBudgetAdmission(o,{requireUnused:true})).toThrow('allocation_already_used');
  expect(rows(o.ledgerPath)).toEqual(before);expect(readFileSync(o.aggregatePath)).toEqual(aggregate);
  const ledger=openSpendLedger(o.ledgerPath);ledger.markTerminal(o.allocationId,'completed');ledger.close();
  expect(()=>assertEngineeringBudgetAdmission(o)).toThrow('existing_ledger_binding_mismatch');
  expect(()=>admitEngineeringAcceptance({...o,resumePartial:true})).toThrow('admission_already_completed');
});
test('ongoing health rejects missing/tampered durable enrollment proof and cap/policy changes',()=>{
  for(const target of ['receipt','cap','policy','deleted','config','inode']){
    const {options:o}=fixture();admitEngineeringAcceptance(o);
    if(target==='receipt')rmSync(join(o.auditDir,o.runId+'.enrolled.json'));
    else if(target==='config')o.runtimeConfigSha256='f'.repeat(64);
    else if(target==='inode'){const copy=o.ledgerPath+'.copy';copyFileSync(o.ledgerPath,copy);renameSync(copy,o.ledgerPath);}
    else {const db=new Database(o.ledgerPath);if(target==='cap')db.query('UPDATE spend_tickets SET cap_micros=5650001 WHERE ticket_id=?').run(o.allocationId);
      else if(target==='policy')db.query('INSERT INTO spend_coding_policies(ticket_id,version) VALUES(?,1)').run(o.allocationId);
      else db.query('DELETE FROM spend_tickets WHERE ticket_id=?').run(o.allocationId);db.close();}
    expect(()=>assertEngineeringBudgetAdmission(o)).toThrow();
  }
});
test('readiness rejects an allocation relinked to a different equally capped campaign',()=>{
  const {options:o}=fixture();admitEngineeringAcceptance(o);
  const ledger=openSpendLedger(o.ledgerPath);ledger.createCampaign('different-same-cap',5.65);ledger.close();
  const db=new Database(o.ledgerPath);db.query('UPDATE spend_tickets SET campaign_id=? WHERE ticket_id=?').run('different-same-cap',o.allocationId);db.close();
  expect(()=>assertEngineeringBudgetAdmission(o)).toThrow('existing_ledger_binding_mismatch');
  expect(()=>assertEngineeringBudgetAdmission(o,{requireUnused:true})).toThrow('existing_ledger_binding_mismatch');
});
