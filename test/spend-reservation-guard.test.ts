import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger, type SpendReservationGuard } from '../src/spend.ts';
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'reservation-guard-')),path=join(root,'spend.sqlite'),ledger=new SpendLedger(path),other=new Database(path);
  cleanup.push(()=>rmSync(root,{recursive:true}),()=>ledger.close(),()=>other.close());
  ledger.createCampaign('campaign',5.65);ledger.enrollTicket('campaign','allocation',5.65,{draftPr:false});other.exec('PRAGMA busy_timeout=1');
  let physical=0;
  const fetch=ledger.guardedFetch('openrouter',(async()=>{physical++;return Response.json({model:'deepseek/deepseek-v4.1-flash',usage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0, cost: 0}});}) as unknown as typeof globalThis.fetch);
  const run=()=>ledger.withSpendScope('allocation',()=>fetch(new Request('https://openrouter.ai/api/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek/deepseek-v4.1-flash',provider:{data_collection:'deny',max_price:{prompt:0.6,completion:2.4}}, max_tokens:8192,messages:[{role:'user',content:'synthetic'}]})})));
  return{ledger,other,run,physical:()=>physical};
}
test('second-connection change after preflight is seen under reservation lock; denial writes nothing and leaves allocation active',async()=>{
  const s=fixture();expect(s.ledger.status('allocation')!.remainingMicros).toBe(5_650_000);
  const guard:SpendReservationGuard=r=>{expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.status)).toBe(true);if(r.reservedMicros+638_962>r.status.remainingMicros)throw new Error('protected-review');};
  await expect(s.ledger.withReservationGuard(guard,()=>s.ledger.withPaidRequestGuard(phase=>{
    if(phase==='before_request')s.other.exec("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('allocation','openrouter','deepseek/deepseek-v4.1-flash',8192,4500000,4500000,'settled')");
  },s.run))).rejects.toThrow('protected-review');
  expect(s.physical()).toBe(0);expect(s.ledger.status('allocation')).toMatchObject({attemptCount:1,chargedMicros:4_500_000,state:'active',terminalReason:null,unknownAttempts:0});
  await s.run();expect(s.physical()).toBe(1); // Guard scope restored; canonical cap still applies.
});
test('guard observes writer lock, composes in order, and thrown inner guard rolls back before any charge',async()=>{
  const s=fixture(),order:string[]=[];
  const outer:SpendReservationGuard=()=>{order.push('outer');expect(()=>s.other.exec("UPDATE spend_tickets SET draft_pr=1 WHERE ticket_id='allocation'")).toThrow();};
  await expect(s.ledger.withReservationGuard(outer,()=>s.ledger.withReservationGuard(()=>{order.push('inner');throw new Error('deny');},s.run))).rejects.toThrow('deny');
  expect(order).toEqual(['outer','inner']);expect(s.ledger.status('allocation')).toMatchObject({draftPr:false,attemptCount:0,chargedMicros:0,state:'active',terminalReason:null});expect(s.physical()).toBe(0);
  await s.ledger.withReservationGuard(()=>{order.push('fresh');},s.run);expect(order).toEqual(['outer','inner','fresh']);expect(s.physical()).toBe(1);
});
test('async or nonvoid guards fail closed, restore scopes and leave no attempt or exhaustion latch',async()=>{
  const s=fixture();
  for(const guard of [async()=>{},async()=>{throw new Error('late');},()=>true]){
    await expect(s.ledger.withReservationGuard(guard as unknown as SpendReservationGuard,s.run)).rejects.toThrow('synchronously');
    expect(s.ledger.status('allocation')).toMatchObject({attemptCount:0,chargedMicros:0,state:'active',terminalReason:null});
  }
  await s.run();expect(s.physical()).toBe(1);
});
