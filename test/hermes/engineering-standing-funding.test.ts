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
