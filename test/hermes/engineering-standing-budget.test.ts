import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStandingEngineeringBudget, assertStandingEngineeringTaskBudget } from '../../src/hermes/engineering-standing-budget.ts';
import { standingBudgetFixture } from './fixtures/engineering-standing.ts';

const clean:Array<()=>void>=[];
afterEach(()=>{for(const f of clean.splice(0))f();});
function fixture(taskCap?:number,cap?:number){const f=standingBudgetFixture(taskCap,cap);clean.push(()=>f.dispose());return f;}
test('readiness is read-only and explicit enrollment creates only a distinct immutable standing campaign',()=>{
  const f=fixture(), before=f.db.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  expect(f.allocator.ready()).toBe(false);expect(f.allocator.status().enrolled).toBe(false);
  expect(f.db.query("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  expect(()=>f.allocator.allocate(f.input())).toThrow('pool_not_enrolled');
  f.allocator.enrollPool();f.allocator.enrollPool();expect(f.allocator.ready()).toBe(true);
  expect(f.db.query('SELECT * FROM spend_campaigns').all()).toHaveLength(1);
  expect(f.db.query('SELECT * FROM spend_tickets').all()).toHaveLength(0);
  const altered=createStandingEngineeringBudget({ledger:f.ledger,authority:{...f.authority,capMicros:9_000_000},assertAuthority:f.assertAuthority});
  expect(()=>altered.enrollPool()).toThrow('pool_binding');
});
test('existing acceptance/chat/history cannot be adopted even with a standing-shaped name',()=>{
  const f=fixture();f.ledger.createCampaign(f.authority.campaignId,8);f.ledger.enrollTicket(f.authority.campaignId,'prior-ticket',8);
  f.db.exec("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('prior-ticket','openrouter','deepseek/deepseek-v4.1-flash',8192,1416561,1416561,'unknown')");
  const before=f.db.query('SELECT * FROM spend_attempts').all();
  expect(()=>f.allocator.enrollPool()).toThrow('campaign_already_exists');
  expect(f.db.query('SELECT * FROM spend_attempts').all()).toEqual(before);
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'standing_engineering_%'").all()).toHaveLength(0);
});
test('separate allocator handles serialize whole-cap commitments and exact replay cannot create or reopen funds',()=>{
  const f=fixture();f.allocator.enrollPool();
  const other=createStandingEngineeringBudget({ledger:f.ledger,authority:f.authority,assertAuthority:f.assertAuthority});
  const first=f.allocator.allocate(f.input()), replay=other.allocate(f.input());
  expect(replay.allocationId).toBe(first.allocationId);expect(replay.allocationId).toBe(f.allocator.allocationIdFor(f.input().requestId));
  expect(()=>other.allocate({...f.input(),requestHash:'f'.repeat(64)})).toThrow('request_replay_mismatch');
  expect(()=>other.allocate({...f.input(),requestHash:'f'.repeat(64)+'\n'})).toThrow('request_binding');
  expect(()=>other.allocate({...f.input(),requestId:'request\n'})).toThrow('request_binding');
  expect(()=>other.allocate({...f.input(),taskId:'different'})).toThrow('request_replay_mismatch');
  other.allocate(f.input(2));expect(f.allocator.ready()).toBe(false);
  expect(f.allocator.status()).toMatchObject({committedCapMicros:8_000_000,uncommittedCapMicros:0,chargedMicros:0,chargedHeadroomMicros:8_000_000,canAllocate:false});
  expect(()=>f.allocator.allocate(f.input(3))).toThrow('uncommitted_pool_exhausted');
  // Existing commitments remain usable even when new admission is exhausted.
  first.assertCurrent();f.ledger.markTerminal(first.allocationId,'completed');
  const closed=other.allocate(f.input());expect(()=>closed.assertCurrent()).toThrow('task_unavailable');
  expect(()=>other.allocate(f.input(3))).toThrow('uncommitted_pool_exhausted');
  expect(f.ledger.status(first.allocationId)!.terminalReason).toBe('completed');
});
test('failed duplicate task enrollment rolls back both commitment and canonical ticket',()=>{
  const f=fixture();f.allocator.enrollPool();f.allocator.allocate(f.input());
  expect(()=>f.allocator.allocate({...f.input(2),taskId:f.input().taskId})).toThrow();
  expect(f.allocator.status().committedCapMicros).toBe(4_000_000);
  expect(f.db.query('SELECT * FROM spend_tickets').all()).toHaveLength(1);
  expect(f.db.query('SELECT * FROM standing_engineering_allocations').all()).toHaveLength(1);
});
test('minted capability, canonical file, synchronous authority and dedicated campaign are continuously enforced',()=>{
  const f=fixture();f.allocator.enrollPool();const b=f.allocator.allocate(f.input());
  expect(()=>assertStandingEngineeringTaskBudget({...b},f.ledger,b.taskId,b.allocationId)).toThrow('untrusted_task_budget');
  expect(()=>assertStandingEngineeringTaskBudget(b,f.ledger,'foreign',b.allocationId)).toThrow('untrusted_task_budget');
  expect(()=>createStandingEngineeringBudget({ledger:f.ledger,authority:f.authority,assertAuthority:async()=>{}})).toThrow('synchronous');
  f.ledger.enrollTicket(f.authority.campaignId,'foreign-ticket',1);
  expect(()=>b.assertCurrent()).toThrow('foreign_allocation');
  const g=fixture();g.allocator.enrollPool();const c=g.allocator.allocate(g.input());g.revoke();
  expect(()=>c.assertCurrent()).toThrow('revoked_funding');expect(g.allocator.ready()).toBe(false);
  const h=fixture();h.allocator.enrollPool();const d=h.allocator.allocate(h.input());
  copyFileSync(h.path,h.path+'.replacement');renameSync(h.path+'.replacement',h.path);
  expect(()=>d.assertCurrent()).toThrow('ledger_changed');
});
test('closing capability neither closes shared ledger nor recycles committed task funds',()=>{
  const f=fixture();f.allocator.enrollPool();const b=f.allocator.allocate(f.input());f.allocator.close();
  expect(()=>b.assertCurrent()).toThrow('closed');expect(f.ledger.status(b.allocationId)!.capMicros).toBe(4_000_000);
  const other=createStandingEngineeringBudget({ledger:f.ledger,authority:f.authority,assertAuthority:f.assertAuthority});
  expect(other.status().committedCapMicros).toBe(4_000_000);other.allocate(f.input()).assertCurrent();
});
test('pool commits preserve unrelated settled receipts and unknown holds',()=>{
  const f=fixture();f.ledger.createCampaign('old-chat',5);f.ledger.enrollTicket('old-chat','old-chat-allocation',5);
  f.db.exec("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('old-chat-allocation','openrouter','deepseek/deepseek-v4.1-flash',8192,1416561,1416561,'unknown'); INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(1,'ambiguous','{}')");
  const prior=[f.db.query('SELECT * FROM spend_attempts').all(),f.db.query('SELECT * FROM spend_receipts').all()];
  f.allocator.enrollPool();f.allocator.allocate(f.input());f.allocator.allocate(f.input(2));
  expect([f.db.query('SELECT * FROM spend_attempts').all(),f.db.query('SELECT * FROM spend_receipts').all()]).toEqual(prior);
  expect(f.ledger.status('old-chat-allocation')!.unknownAttempts).toBe(1);
});
test('two independent SQLite writers racing for the final cap can admit only one task',async()=>{
  const f=fixture(3_000_000,3_000_000);f.allocator.enrollPool();
  const script=join(f.root,'race.ts');
  writeFileSync(script,`import {SpendLedger} from ${JSON.stringify(new URL('../../src/spend.ts',import.meta.url).pathname)};
import {createStandingEngineeringBudget} from ${JSON.stringify(new URL('../../src/hermes/engineering-standing-budget.ts',import.meta.url).pathname)};
globalThis.fetch=async()=>{throw Error('no network')};
const ledger=new SpendLedger(${JSON.stringify(f.path)});
const pool=createStandingEngineeringBudget({ledger,authority:${JSON.stringify(f.authority)},assertAuthority(){}});
console.log('ready');await Bun.stdin.text();
try {pool.allocate({requestId:'request-'+process.argv[2],taskId:'task-'+process.argv[2],requestHash:'f'.repeat(64)});console.log('admitted');}
catch(e){console.log(String(e).includes('uncommitted_pool_exhausted')?'exhausted':'unexpected');process.exitCode=String(e).includes('uncommitted_pool_exhausted')?0:1;}
finally {pool.close();ledger.close();}`,{mode:0o600});
  const children=[1,2].map(n=>Bun.spawn([process.execPath,'--no-env-file','--no-install','--config=/dev/null',script,String(n)],
    {env:{HOME:'/var/empty',PATH:'/usr/bin:/bin'},stdin:'pipe',stdout:'pipe',stderr:'pipe'}));
  try {
    const readers=children.map(c=>c.stdout.getReader());
    const ready=await Promise.all(readers.map(r=>r.read()));
    expect(ready.map(r=>new TextDecoder().decode(r.value))).toEqual(['ready\n','ready\n']);
    children.forEach(c=>{c.stdin.write('go');c.stdin.end();});
    const outputs=await Promise.all(readers.map(async reader=>{let text='';for(;;){const next=await reader.read();if(next.done)return text;text+=new TextDecoder().decode(next.value);}}));
    expect(outputs.sort()).toEqual(['admitted\n','exhausted\n']);
    expect(await Promise.all(children.map(c=>c.exited))).toEqual([0,0]);
    expect(f.allocator.status()).toMatchObject({committedCapMicros:3_000_000,uncommittedCapMicros:0});
    expect(f.db.query('SELECT * FROM spend_tickets').all()).toHaveLength(1);
    expect(f.db.query('SELECT * FROM standing_engineering_allocations').all()).toHaveLength(1);
  } finally {for(const c of children)if(c.exitCode===null)c.kill();await Promise.all(children.map(c=>c.exited));}
},15_000);
test('an enrolled pool survives a reboot that renumbers the ledger volume dev, and nothing else',()=>{
  const f=fixture();f.allocator.enrollPool();f.allocator.close();
  const stored=JSON.parse((f.db.query('SELECT ledger_identity_json j FROM standing_engineering_pools').get() as {j:string}).j);
  const setStored=(v:Record<string,unknown>)=>f.db.query('UPDATE standing_engineering_pools SET ledger_identity_json=?').run(JSON.stringify(v));
  const UUID='7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697';
  const seen:number[]=[];
  const observe=(uuid:string)=>(dev:number)=>{seen.push(dev);return {bootSessionUUID:'2C2DEAF4-4608-4037-97F1-6E3E007AEBA7',apfsVolumeUUID:uuid};};
  const open=(ledgerVolume?:Parameters<typeof createStandingEngineeringBudget>[0]['ledgerVolume'])=>{
    const b=createStandingEngineeringBudget({ledger:f.ledger,authority:f.authority,assertAuthority:f.assertAuthority,...(ledgerVolume?{ledgerVolume}:{})});
    clean.push(()=>b.close());return b;};
  setStored({...stored,dev:stored.dev-1});
  // No pin: any identity change still rejects.
  expect(()=>open().status()).toThrow('pool_binding');
  // Same pinned volume: accepted, the row is not rewritten, and the live dev is what gets observed.
  const rebooted=open({apfsVolumeUUID:UUID,observe:observe(UUID)});
  expect(rebooted.status().enrolled).toBe(true);expect(seen).toEqual([stored.dev]);
  rebooted.allocate(f.input());
  expect(JSON.parse((f.db.query('SELECT ledger_identity_json j FROM standing_engineering_pools').get() as {j:string}).j).dev).toBe(stored.dev-1);
  // Another volume, an unobservable host, or any other identity field change: rejected.
  expect(()=>open({apfsVolumeUUID:UUID,observe:observe('00000000-0000-0000-0000-000000000000')}).status()).toThrow('pool_binding');
  expect(()=>open({apfsVolumeUUID:UUID,observe:()=>{throw new Error('engineering_budget_admission:reboot_attestation_rejected');}}).status()).toThrow('pool_binding');
  for(const key of ['ino','uid','gid','mode','nlink'] as const){
    setStored({...stored,dev:stored.dev-1,[key]:stored[key]+1});
    expect(()=>open({apfsVolumeUUID:UUID,observe:observe(UUID)}).status()).toThrow('pool_binding');
  }
  setStored({...stored,dev:stored.dev-1,extra:1});
  expect(()=>open({apfsVolumeUUID:UUID,observe:observe(UUID)}).status()).toThrow('pool_binding');
  setStored({...stored,dev:String(stored.dev-1)});
  expect(()=>open({apfsVolumeUUID:UUID,observe:observe(UUID)}).status()).toThrow('pool_binding');
});
