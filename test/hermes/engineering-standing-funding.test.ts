import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../../src/spend.ts';
import { createStandingEngineeringFundingGuard, type StandingEngineeringFundingOptions } from '../../src/hermes/engineering-standing-funding.ts';
import { createStandingEngineeringBudget } from '../../src/hermes/engineering-standing-budget.ts';

const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const hash=(s:Buffer|string)=>createHash('sha256').update(s).digest('hex');
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'standing-funding-')));roots.push(root);
  const aggregatePath=join(root,'aggregate.json'),ledgerPath=join(root,'spend.sqlite'),fundingAuthorityPath=join(root,'authority.json'),fundingHoldReceiptPath=join(root,'hold.json');
  const ledger=new SpendLedger(ledgerPath);ledger.close();
  const write=(path:string,v:unknown)=>{writeFileSync(path,JSON.stringify(v,null,2)+'\n',{mode:0o600});return hash(readFileSync(path));};
  // $50 committed includes immutable acceptance, DM and unknown history. $3 of
  // the $10 nominal unallocated remains protected; only the new $6 is committed.
  const before:any={schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,
    runtimeCommittedOrHeldUsd:50,runtimeUnallocatedUsd:10,totalCommittedOrHeldUsd:90,runtimeUnknownHoldsUsd:4.5,runtimeAuthorizationRetiredUsd:0,
    runtimeAllocations:[{id:'acceptance',amountUsd:5.65,retainedAmountUsd:5.65,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0},
      {id:'dm',amountUsd:5,retainedAmountUsd:5,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0},
      {id:'other-history',amountUsd:39.35,retainedAmountUsd:39.35,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:4.5,
        admission:{kind:'classifier_canary',commonfieldEarmarkMicros:3000000}}]};
  const authority={version:1 as const,poolId:'standing-engineering-test',campaignId:'standing-engineering-test-campaign',capMicros:6_000_000,
    taskCapMicros:3_000_000,authoritySha256:'',holdReceiptSha256:''};
  const approval={version:1,kind:'standing_engineering_funding',approved:true,poolId:authority.poolId,campaignId:authority.campaignId,
    capMicros:authority.capMicros,taskCapMicros:authority.taskCapMicros,aggregatePath,ledgerPath,approvalEvidenceSha256:'a'.repeat(64),aggregateBeforeRuntimePoolMicros:60_000_000,additionalRuntimePoolMicros:0};
  authority.authoritySha256=write(fundingAuthorityPath,approval);
  const beforeRef={path:join(root,'before.json'),sha256:write(join(root,'before.json'),before)};
  const hold={id:'standing-engineering:'+authority.poolId,amountUsd:6,state:'held_for_standing_engineering',retainedAmountUsd:6,
    retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0,admission:{kind:'standing_engineering',poolId:authority.poolId,campaignId:authority.campaignId,
      capMicros:authority.capMicros,taskCapMicros:authority.taskCapMicros,authoritySha256:authority.authoritySha256,ledgerPath,
      auditRecord:fundingHoldReceiptPath,aggregateBeforeSha256:beforeRef.sha256}};
  const after={...structuredClone(before),runtimeAllocations:[...structuredClone(before.runtimeAllocations),hold],
    runtimeCommittedOrHeldUsd:56,runtimeUnallocatedUsd:4,totalCommittedOrHeldUsd:96,bookkeepingUpdatedAt:'2026-10-11T01:00:00Z'};
  const afterRef={path:join(root,'after.json'),sha256:write(join(root,'after.json'),after)};
  const receipt={version:1,kind:'standing_engineering_hold',poolId:authority.poolId,campaignId:authority.campaignId,
    capMicros:authority.capMicros,taskCapMicros:authority.taskCapMicros,authoritySha256:authority.authoritySha256,aggregatePath,ledgerPath,
    before:beforeRef,after:afterRef,aggregateBeforeRuntimePoolMicros:60_000_000,additionalRuntimePoolMicros:0};
  authority.holdReceiptSha256=write(fundingHoldReceiptPath,receipt);write(aggregatePath,after);
  const o:StandingEngineeringFundingOptions={authority,aggregatePath,ledgerPath,fundingAuthorityPath,fundingHoldReceiptPath};
  return {root,o,write,before,after,approval,receipt,
    repin(){receipt.before.sha256=write(receipt.before.path,before);receipt.after.sha256=write(receipt.after.path,after);
      o.authority.holdReceiptSha256=write(fundingHoldReceiptPath,receipt);write(aggregatePath,after);}};
}
test('recorded distinct hold enables explicit pool enrollment and every guard remains read-only',()=>{
  const f=fixture(),guard=createStandingEngineeringFundingGuard(f.o),before=readFileSync(f.o.aggregatePath);
  guard();expect(readFileSync(f.o.aggregatePath)).toEqual(before);
  const ledger=new SpendLedger(f.o.ledgerPath);
  try {const allocator=createStandingEngineeringBudget({ledger,authority:f.o.authority,assertAuthority:guard});
    expect(allocator.ready()).toBe(false);allocator.enrollPool();
    allocator.allocate({requestId:'request',requestHash:'b'.repeat(64),taskId:'task'}).assertCurrent();
    expect(allocator.status().uncommittedCapMicros).toBe(3_000_000);
    expect(readFileSync(f.o.aggregatePath)).toEqual(before);
  }finally{ledger.close();}
});
test('approval, evidence hashes, ledger location and exact shape are mandatory',()=>{
  for(const fault of ['approved','hash','ledger','extra','private']){
    const f=fixture();
    if(fault==='approved'){f.approval.approved=false;f.o.authority.authoritySha256=f.write(f.o.fundingAuthorityPath,f.approval);}
    if(fault==='hash')writeFileSync(f.o.fundingAuthorityPath,readFileSync(f.o.fundingAuthorityPath,'utf8')+' ');
    if(fault==='ledger')f.o.ledgerPath=join(f.root,'missing.sqlite');
    if(fault==='extra')f.o.authority.authoritySha256=f.write(f.o.fundingAuthorityPath,{...f.approval,adoptAcceptance:true});
    if(fault==='private')chmodSync(f.o.fundingAuthorityPath,0o644);
    expect(()=>createStandingEngineeringFundingGuard(f.o)()).toThrow();
  }
});
test('retired acceptance authorization, DM funds, unknown holds and earmarks cannot finance a standing pool',()=>{
  for(const fault of ['acceptance','dm','unknown','earmark','ceiling']){
    const f=fixture();
    if(fault==='acceptance'||fault==='dm'){
      const index=fault==='acceptance'?0:1;f.after.runtimeAllocations[index].retainedAmountUsd-=1;f.after.runtimeAllocations[index].retiredUnusedAuthorizationUsd=1;
      f.after.runtimeCommittedOrHeldUsd-=1;f.after.runtimeUnallocatedUsd+=1;f.after.totalCommittedOrHeldUsd-=1;f.after.runtimeAuthorizationRetiredUsd=1;
    } else if(fault==='unknown'){f.after.runtimeAllocations[2].retainedUnknownCostsUsd=4;f.after.runtimeUnknownHoldsUsd=4;}
    else if(fault==='earmark')f.after.runtimeAllocations[2].admission.commonfieldEarmarkMicros=0;
    else {f.after.runtimePoolUsd=61;f.after.totalCeilingUsd=101;f.after.runtimeUnallocatedUsd+=1;}
    f.repin();expect(()=>createStandingEngineeringFundingGuard(f.o)()).toThrow();
  }
});
test('current hold changes, prior-history edits, duplicate JSON keys and subnanodollar precision fail closed',()=>{
  for(const fault of ['held','prior','duplicate','precision','receipt']){
    const f=fixture(),guard=createStandingEngineeringFundingGuard(f.o);guard();
    if(fault==='held'){f.after.runtimeAllocations[3].state='released';f.write(f.o.aggregatePath,f.after);}
    else if(fault==='prior'){f.after.runtimeAllocations[0].newHistory='tampered';f.write(f.o.aggregatePath,f.after);}
    else if(fault==='duplicate')writeFileSync(f.o.aggregatePath,readFileSync(f.o.aggregatePath,'utf8').replace('"schemaVersion": 2','"schemaVersion": 2, "schemaVersion": 2'));
    else if(fault==='precision')writeFileSync(f.o.aggregatePath,readFileSync(f.o.aggregatePath,'utf8').replace('"runtimeUnknownHoldsUsd": 4.5','"runtimeUnknownHoldsUsd": 4.5000000001'));
    else writeFileSync(f.o.fundingHoldReceiptPath,readFileSync(f.o.fundingHoldReceiptPath,'utf8')+' ');
    expect(guard).toThrow();
  }
});
test('conserved later unrelated holds are allowed; audited funds remain unavailable for duplication',()=>{
  const f=fixture(),guard=createStandingEngineeringFundingGuard(f.o);
  f.after.runtimeAllocations.push({id:'later',amountUsd:0.5,retainedAmountUsd:0.5,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0});
  f.after.runtimeCommittedOrHeldUsd+=0.5;f.after.runtimeUnallocatedUsd-=0.5;f.after.totalCommittedOrHeldUsd+=0.5;
  f.write(f.o.aggregatePath,f.after);guard();
  f.after.runtimeAllocations.at(-1).admission={poolId:f.o.authority.poolId};f.write(f.o.aggregatePath,f.after);
  expect(guard).toThrow('funding_reuse');
});
test('only an explicitly approved finite addition increases runtime and total envelopes while preserving old holds',()=>{
  const f=fixture();
  f.approval.additionalRuntimePoolMicros=20_000_000;
  f.o.authority.authoritySha256=f.write(f.o.fundingAuthorityPath,f.approval);
  f.receipt.authoritySha256=f.o.authority.authoritySha256;f.receipt.additionalRuntimePoolMicros=20_000_000;
  f.after.runtimeAllocations[3].admission.authoritySha256=f.o.authority.authoritySha256;
  f.after.runtimePoolUsd=80;f.after.totalCeilingUsd=120;f.after.runtimeUnallocatedUsd=24;f.repin();
  const guard=createStandingEngineeringFundingGuard(f.o);guard();
  expect(f.after.runtimeAllocations.slice(0,3)).toEqual(f.before.runtimeAllocations);
  expect(f.after.other90HoldUsd).toBe(30);expect(f.after.bufferHoldUsd).toBe(10);
  // Even another dollar is not implied by the finite funding approval.
  f.after.runtimePoolUsd=81;f.after.totalCeilingUsd=121;f.after.runtimeUnallocatedUsd=25;
  f.write(f.o.aggregatePath,f.after);expect(guard).toThrow('aggregate_cap_mismatch');
  const missing=fixture();missing.after.runtimePoolUsd=80;missing.after.totalCeilingUsd=120;missing.after.runtimeUnallocatedUsd=24;missing.repin();
  expect(()=>createStandingEngineeringFundingGuard(missing.o)()).toThrow('aggregate_cap_mismatch');
});

// Relocating a standing grant: the old aggregate is copied (never edited), its
// standing hold is retired in the copy, and the unused balance funds a new hold.
import { mkdirSync } from 'node:fs';
import { planStandingFundingTransfer } from '../../src/hermes/engineering-standing-funding.ts';
function approval(f:ReturnType<typeof fixture>,retainedMicros:number,overrides:Record<string,unknown>={}) {
  return Buffer.from(JSON.stringify({version:1,kind:'standing_engineering_relocation_approval',approver:'Tanner Vass',approvedAt:'2026-10-28',
    approvalText:'Move the standing engineering budget out of ~/Documents.',sourceHoldId:'standing-engineering:'+f.o.authority.poolId,
    retiredPoolId:f.o.authority.poolId,transferredMicros:f.o.authority.capMicros-retainedMicros,newPoolId:'standing-engineering-moved',...overrides},null,2)+'\n');
}
function relocated(retainedMicros=1_000_000) {
  const f=fixture(),dir=join(f.root,'budget');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const sourceBytes=readFileSync(f.o.aggregatePath);
  const plan=planStandingFundingTransfer({sourceAggregateBytes:sourceBytes,sourceAggregatePath:f.o.aggregatePath,
    retired:{poolId:f.o.authority.poolId,authoritySha256:f.o.authority.authoritySha256,capMicros:f.o.authority.capMicros},retainedMicros,
    next:{poolId:'standing-engineering-moved',campaignId:'standing-engineering-moved-campaign',taskCapMicros:3_000_000},
    ledgerPath:f.o.ledgerPath,approvalEvidenceBytes:approval(f,retainedMicros),directory:dir,aggregatePath:join(dir,'aggregate.json'),now:new Date('2026-10-28T00:00:00Z')});
  for(const file of plan.files){writeFileSync(file.path,file.bytes,{mode:0o600});chmodSync(file.path,0o600);}
  const o:StandingEngineeringFundingOptions={authority:plan.authority,aggregatePath:plan.aggregatePath,ledgerPath:f.o.ledgerPath,
    fundingAuthorityPath:plan.fundingAuthorityPath,fundingHoldReceiptPath:plan.fundingHoldReceiptPath};
  return {f,dir,plan,o,sourceBytes};
}
test('relocated grant verifies, conserves the old hold exactly and enrolls a new pool without touching the old aggregate',()=>{
  const r=relocated();
  createStandingEngineeringFundingGuard(r.o)();
  expect(readFileSync(r.f.o.aggregatePath)).toEqual(r.sourceBytes);
  expect(r.plan.authority.capMicros).toBe(5_000_000);
  const after=JSON.parse(readFileSync(r.o.aggregatePath,'utf8'));
  const old=after.runtimeAllocations.find((v:any)=>v.id==='standing-engineering:'+r.f.o.authority.poolId);
  expect(old).toMatchObject({state:'retired_for_standing_transfer',amountUsd:6,retainedAmountUsd:1,retiredUnusedAuthorizationUsd:5});
  expect(after.runtimeAllocations.at(-1)).toMatchObject({id:'standing-engineering:standing-engineering-moved',amountUsd:5,retainedAmountUsd:5});
  // Totals: held unchanged (6 -> 1 + 5), retirement recorded, pool unchanged.
  expect([after.runtimeCommittedOrHeldUsd,after.runtimeUnallocatedUsd,after.runtimeAuthorizationRetiredUsd,after.runtimePoolUsd]).toEqual([56,4,5,60]);
  const ledger=new SpendLedger(r.o.ledgerPath);
  try {const allocator=createStandingEngineeringBudget({ledger,authority:r.o.authority,assertAuthority:createStandingEngineeringFundingGuard(r.o)});
    allocator.enrollPool();expect(allocator.status()).toMatchObject({enrolled:true,poolCapMicros:5_000_000});
  } finally {ledger.close();}
});
test('relocation cannot create money, change the source, alter other history or reuse a retired hold',()=>{
  expect(()=>relocated(7_000_000)).toThrow('transfer_input');
  expect(()=>relocated(4_000_000)).toThrow('transfer_insufficient'); // 2 left < 3 task cap
  for(const fault of ['source','before','transfer-amount','other-history']){
    const r=relocated(),pinned=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
    const write=(p:string,v:unknown)=>{writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});return hash(readFileSync(p));};
    const receipt=pinned(r.o.fundingHoldReceiptPath),transferPath=receipt.transfer.path,transfer=pinned(transferPath);
    if(fault==='source'){const s=pinned(transfer.source.path);s.runtimeAllocations[0].retainedAmountUsd=5.64;transfer.source.sha256=write(transfer.source.path,s);}
    if(fault==='before'||fault==='other-history'){
      const b=pinned(receipt.before.path);
      if(fault==='before'){const h=b.runtimeAllocations.find((v:any)=>v.state==='retired_for_standing_transfer');h.retainedAmountUsd=0.5;h.retiredUnusedAuthorizationUsd=5.5;}
      else b.runtimeAllocations[1].retiredUnusedAuthorizationUsd=1,b.runtimeAllocations[1].retainedAmountUsd=4;
      receipt.before.sha256=write(receipt.before.path,b);transfer.beforeSha256=receipt.before.sha256;
    }
    if(fault==='transfer-amount'){transfer.transferredMicros=6_000_000;transfer.retainedMicros=0;}
    receipt.transfer.sha256=write(transferPath,transfer);r.o.authority.holdReceiptSha256=write(r.o.fundingHoldReceiptPath,receipt);
    expect(()=>createStandingEngineeringFundingGuard(r.o)()).toThrow();
  }
});

import { Database } from 'bun:sqlite';
import { standingPoolRetainedMicros } from '../../src/hermes/engineering-standing-relocation.ts';
test('relocation keeps every committed old-pool cap and refuses open conversation leases or unsettled attempts',()=>{
  const f=fixture(),ledger=new SpendLedger(f.o.ledgerPath);
  try {
    const budget=createStandingEngineeringBudget({ledger,authority:f.o.authority,assertAuthority:createStandingEngineeringFundingGuard(f.o)});
    budget.enrollPool();const task=budget.allocate({requestId:'r1',requestHash:'b'.repeat(64),taskId:'t1'});
    const config={funding:f.o.authority} as any,read=()=>{const db=new Database(f.o.ledgerPath,{readonly:true});try{return standingPoolRetainedMicros(db,config);}finally{db.close();}};
    expect(read()).toBe(3_000_000); // one committed task cap, nothing released
    const db=new Database(f.o.ledgerPath);
    db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'openrouter','deepseek/deepseek-v4.1-flash',8192,648807,648807,'unknown')").run(task.allocationId);
    expect(read).toThrow('unsettled_attempt');
    db.exec("UPDATE spend_attempts SET state='settled'");
    db.query("INSERT INTO standing_engineering_conversation_leases(lease_id,pool_id,ticket_id,start_attempt_id) VALUES('l',?,'local:hermes-dm-20261008-tanner',0)").run(f.o.authority.poolId);
    expect(read).toThrow('conversation_lease_open');db.close();
  } finally {ledger.close();}
});

import { assertGaryStopped, inspectStandingRelocation, planStandingRelocation } from '../../src/hermes/engineering-standing-relocation.ts';
test('after a transfer the OLD grant refuses on both the funding guard and the ledger, and the new one spends',()=>{
  const r=relocated(),oldGuard=createStandingEngineeringFundingGuard(r.f.o);
  const ledger=new SpendLedger(r.f.o.ledgerPath);
  try {
    const old=createStandingEngineeringBudget({ledger,authority:r.f.o.authority,assertAuthority:oldGuard});old.enrollPool();
    old.allocate({requestId:'old-1',requestHash:'b'.repeat(64),taskId:'old-task-1'});
    // Tombstone beside the old aggregate (what --apply writes): the old funding guard now refuses.
    mkdirSync(r.f.o.aggregatePath+'.admission.lock',{mode:0o700});writeFileSync(r.f.o.aggregatePath+'.admission.lock/transferred.json','{}',{mode:0o600});
    expect(()=>oldGuard()).toThrow('aggregate_transferred');expect(old.ready()).toBe(false);
    // Independently of the file, --enroll retires the old pool in the same ledger transaction.
    const next=createStandingEngineeringBudget({ledger,authority:r.o.authority,assertAuthority:createStandingEngineeringFundingGuard(r.o)});
    expect(()=>next.enrollPoolReplacing({retired:r.f.o.authority,retainedMicros:999_999,transferReceiptSha256:'e'.repeat(64)})).toThrow('retirement_input');
    expect(()=>next.enrollPoolReplacing({retired:r.f.o.authority,retainedMicros:1_000_000,transferReceiptSha256:'e'.repeat(64)})).toThrow('retired_pool_commitment_changed');
    expect(next.ready()).toBe(false); // the failed transaction enrolled nothing
  } finally {ledger.close();}
});
test('enrollPoolReplacing retires the old pool at its exact commitment atomically with the new enrollment',()=>{
  const r=relocated(3_000_000),ledger=new SpendLedger(r.f.o.ledgerPath);
  try {
    const old=createStandingEngineeringBudget({ledger,authority:r.f.o.authority,assertAuthority:()=>{}});old.enrollPool();
    old.allocate({requestId:'old-1',requestHash:'b'.repeat(64),taskId:'old-task-1'}); // commits 3_000_000
    const next=createStandingEngineeringBudget({ledger,authority:r.o.authority,assertAuthority:createStandingEngineeringFundingGuard(r.o)});
    next.enrollPoolReplacing({retired:r.f.o.authority,retainedMicros:3_000_000,transferReceiptSha256:'e'.repeat(64)});
    expect(next.status()).toMatchObject({enrolled:true,poolCapMicros:3_000_000});
    expect(()=>old.status()).toThrow('pool_retired');expect(old.ready()).toBe(false);
    expect(()=>old.allocate({requestId:'old-2',requestHash:'c'.repeat(64),taskId:'old-task-2'})).toThrow('pool_retired');
    expect(()=>next.enrollPoolReplacing({retired:r.f.o.authority,retainedMicros:3_000_000,transferReceiptSha256:'e'.repeat(64)})).toThrow('already_retired');
  } finally {ledger.close();}
});
test('approval evidence must name the exact hold, pools and amount',()=>{
  for(const override of [{transferredMicros:5_000_001},{newPoolId:'standing-engineering-other'},{retiredPoolId:'x'},{sourceHoldId:'x'},{approvalText:''},{approvedAt:'soon'},{extra:true}]){
    const f=fixture(),dir=join(f.root,'budget');mkdirSync(dir,{mode:0o700});
    expect(()=>planStandingFundingTransfer({sourceAggregateBytes:readFileSync(f.o.aggregatePath),sourceAggregatePath:f.o.aggregatePath,
      retired:{poolId:f.o.authority.poolId,authoritySha256:f.o.authority.authoritySha256,capMicros:f.o.authority.capMicros},retainedMicros:1_000_000,
      next:{poolId:'standing-engineering-moved',campaignId:'standing-engineering-moved-campaign',taskCapMicros:3_000_000},ledgerPath:f.o.ledgerPath,
      approvalEvidenceBytes:approval(f,1_000_000,override),directory:dir,aggregatePath:join(dir,'aggregate.json'),now:new Date()})).toThrow('approval_evidence');
  }
  const r=relocated(),receipt=JSON.parse(readFileSync(r.o.fundingHoldReceiptPath,'utf8')),t=JSON.parse(readFileSync(receipt.transfer.path,'utf8'));
  writeFileSync(t.approvalEvidence.path,approval(r.f,1_000_000,{transferredMicros:4_000_000}),{mode:0o600});
  expect(()=>createStandingEngineeringFundingGuard(r.o)()).toThrow();
});
test('relocation inspection lists other open holds and planning refuses while any exist',()=>{
  const f=fixture();f.after.runtimeAllocations[0].state='held_for_engineering_acceptance';f.after.runtimeAllocations[1].state='held_for_dm_conversation';f.repin();
  const ledger=new SpendLedger(f.o.ledgerPath);
  try {createStandingEngineeringBudget({ledger,authority:f.o.authority,assertAuthority:()=>{}}).enrollPool();} finally {ledger.close();}
  const journalDb=new Database(':memory:'),spendDb=new Database(f.o.ledgerPath,{readonly:true});
  try {
    const config={funding:f.o.authority,aggregatePath:f.o.aggregatePath} as any,next={poolId:'standing-engineering-moved',campaignId:'standing-engineering-moved-campaign'};
    const inspection=inspectStandingRelocation({config,journalDb,spendDb,listLabelledContainers:()=>[],next});
    expect(inspection.openHolds).toEqual([{id:'acceptance',state:'held_for_engineering_acceptance',retainedAmountUsd:5.65}]);
    expect(inspection.carriedHolds).toEqual([{id:'dm',state:'held_for_dm_conversation',retainedAmountUsd:5}]);
    expect(inspection).toMatchObject({retainedMicros:0,transferredMicros:6_000_000,sourceHoldId:'standing-engineering:'+f.o.authority.poolId});
    expect(()=>planStandingRelocation({config,journalDb,spendDb,listLabelledContainers:()=>[],next,configPath:'/unused',ledgerPath:f.o.ledgerPath,
      approvalEvidenceBytes:Buffer.from('{}'),targetDirectory:join(f.root,'t'),now:new Date()})).toThrow('open_holds:acceptance');
  } finally {journalDb.close();spendDb.close();}
});
test('apply and enroll refuse while the LaunchAgent has a running process',()=>{
  expect(()=>assertGaryStopped(()=>'\tstate = running\n\tpid = 4242\n')).toThrow('gary_running');
  expect(()=>assertGaryStopped(()=>'\tstate = not running\n')).not.toThrow();
  expect(()=>assertGaryStopped(()=>{throw new Error('Could not find service');})).not.toThrow();
});
