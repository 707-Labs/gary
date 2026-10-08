import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackConversation, fingerprintSlackConversationConfig, loadSlackConversationConfig, type SlackConversationInput } from '../../src/slack/conversation.ts';
import { DMReplyError, type DMTurn } from '../../src/hermes/dm-conversation.ts';
import { SpendLedger } from '../../src/spend.ts';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture(){const dir=realpathSync(mkdtempSync(join(tmpdir(),'gary-dm-context-')));chmodSync(dir,0o700);cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'conversation.json');writeFileSync(path,JSON.stringify({version:1,runId:'hermes-dm-20261008',campaignId:'hermes-dm-20261008',allocationId:'local:hermes-dm-20261008-tanner'}),{mode:0o600});
  const config=loadSlackConversationConfig(path),ledger=new SpendLedger(':memory:');cleanup.push(()=>ledger.close());ledger.createCampaign(config.campaignId,5);ledger.enrollTicket(config.campaignId,config.allocationId,5);
  return{dir,path,config,ledger};}
const signal=new AbortController().signal;
const input=(n:number,extra:Partial<SlackConversationInput>={}):SlackConversationInput=>({eventId:'EvFixture'+n,channel:'D0FIXTURE1',ts:'1791417600.'+String(n).padStart(6,'0'),threadTs:'1791417600.'+String(n).padStart(6,'0'),text:'private fabricated phrase violet sparrow',...extra});
const sent=async()=> 'sent' as const;
test('trusted host composition revocation stops private DM inference and delivery without reading shared state',async()=>{
  const f=fixture();let allowed=false,calls=0,sends=0;
  const service=createSlackConversation({...f,reply:async turn=>{calls++;allowed=false;expect(()=>turn.assertActive()).toThrow('dm_owner_changed');return 'must not send';}});
  await service.respond(input(1),async()=>{sends++;return 'sent';},signal,()=>allowed);expect(calls).toBe(0);
  allowed=true;await service.respond(input(2),async()=>{sends++;return 'sent';},signal,()=>allowed);expect(calls).toBe(1);expect(sends).toBe(0);service.close();
});
test('private config rejects loose modes, duplicate fields, extra scope, or noncanonical IDs',()=>{
  const f=fixture();expect(fingerprintSlackConversationConfig(f.config)).toMatch(/^[a-f0-9]{64}$/);
  chmodSync(f.path,0o644);expect(()=>loadSlackConversationConfig(f.path)).toThrow('private_path');chmodSync(f.path,0o600);
  writeFileSync(f.path,'{"version":1,"version":1,"runId":"hermes-dm-20261008","campaignId":"hermes-dm-20261008","allocationId":"local:hermes-dm-20261008-tanner"}');expect(()=>loadSlackConversationConfig(f.path)).toThrow('config_rejected');
  writeFileSync(f.path,JSON.stringify({...f.config}));expect(()=>loadSlackConversationConfig(f.path)).toThrow('config_rejected');
});
test('confirmed two-turn thread context survives restart; event and message duplicates never repeat inference',async()=>{
  const f=fixture(),calls:DMTurn[]=[],reply=async(turn:DMTurn)=>{calls.push(turn);return 'The phrase is violet sparrow.';};
  let service=createSlackConversation({...f,reply});await service.respond(input(1),sent,signal);expect(service.close()).toEqual({drained:true});
  service=createSlackConversation({...f,reply});
  await service.respond(input(1),sent,signal);await service.respond(input(1,{eventId:'EvDifferent'}),sent,signal);
  await service.respond(input(2,{threadTs:input(1).ts,text:'What phrase?'}),sent,signal);
  expect(calls).toHaveLength(2);expect(calls[1]?.history).toEqual([{role:'user',content:input(1).text},{role:'assistant',content:'The phrase is violet sparrow.'}]);
  await service.respond(input(3),sent,signal);expect(calls[2]?.history).toEqual([]);
  expect(service.close()).toEqual({drained:true});expect(statSync(join(f.dir,'context.sqlite')).mode&0o777).toBe(0o600);
});
test('unknown Slack send is not conversation history and blocks thread without an automatic retry',async()=>{
  const f=fixture();let calls=0;const replies:string[]=[];const service=createSlackConversation({...f,reply:async()=>{calls++;return 'unconfirmed body';}});
  await service.respond(input(1),async()=> 'unknown',signal);
  await service.respond(input(1),sent,signal);await service.respond(input(2,{threadTs:input(1).ts}),async text=>{replies.push(text);return 'sent';},signal);
  expect(calls).toBe(1);expect(replies).toHaveLength(1);expect(replies[0]).toContain('No model call');expect(service.close()).toEqual({drained:true});
  const db=new Database(join(f.dir,'context.sqlite'));expect(db.query('SELECT history,blocked FROM sessions').get()).toEqual({history:'[]',blocked:1});db.close();
});
test('durable claim and exact worker name precede inference; stale owner blocks spending and drain proof',async()=>{
  const f=fixture();let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const a=createSlackConversation({...f,reply:async turn=>{turn.recordWorker('gary-hermes-worker-12345678-1234-1234-1234-123456789abc');entered();await wait;return 'reply';}});
  const job=a.respond(input(1),sent,signal);await started;
  const check=new Database(join(f.dir,'context.sqlite'));expect(check.query('SELECT state,worker_name FROM events').get()).toEqual({state:'running',worker_name:'gary-hermes-worker-12345678-1234-1234-1234-123456789abc'});check.close();
  let extra=0;const b=createSlackConversation({...f,reply:async()=>{extra++;return 'forbidden';}});await b.respond(input(2),sent,signal);expect(extra).toBe(0);expect(b.close()).toEqual({drained:false});
  release();await job;a.close();
});
test('native cleanup failure stays latched across restart, with sanitized user failure and no retry',async()=>{
  const f=fixture();const messages:string[]=[];let calls=0;
  let service=createSlackConversation({...f,reply:async()=>{calls++;throw new DMReplyError('dm_native_reply_unconfirmed',false);}});
  await service.respond(input(1),async text=>{messages.push(text);return 'sent';},signal);expect(service.close()).toEqual({drained:false});
  service=createSlackConversation({...f,reply:async()=>{calls++;return 'forbidden';}});await service.respond(input(2),sent,signal);
  expect(calls).toBe(1);expect(messages[0]).not.toContain('dm_');expect(service.close()).toEqual({drained:false});
});
test('serialized queue max4, unknown historical threads and UTF8 input cap produce no extra calls',async()=>{
  const f=fixture();let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);let calls=0,inFlight=0,max=0;
  const service=createSlackConversation({...f,reply:async()=>{calls++;max=Math.max(max,++inFlight);await wait;inFlight--;return 'reply';}});
  const jobs=[1,2,3,4,5].map(n=>service.respond(input(n),sent,signal));release();await Promise.all(jobs);
  expect(calls).toBe(4);expect(max).toBe(1);
  await service.respond(input(6,{threadTs:'1791417000.000001'}),sent,signal);
  await service.respond(input(7,{text:'🦜'.repeat(1001)}),sent,signal);expect(calls).toBe(4);expect(service.close()).toEqual({drained:true});
});
test('persisted session/turn/accepted-event bounds and bounded rejection notices survive process restarts',async()=>{
  const f=fixture();let calls=0;const reply=async()=>{calls++;return 'r';};let service=createSlackConversation({...f,reply});
  for(let n=1;n<=17;n++)await service.respond(input(n),sent,signal);expect(calls).toBe(16);service.close();
  service=createSlackConversation({...f,reply});for(let n=20;n<32;n++)await service.respond(input(n,{threadTs:input(1).ts}),sent,signal);
  expect(calls).toBe(27);service.close();
  const db=new Database(join(f.dir,'context.sqlite'));expect((db.query('SELECT turns FROM sessions WHERE session_key=?').get('D0FIXTURE1:'+input(1).ts) as any).turns).toBe(12);
  expect(Number((db.query('SELECT count(*) AS n FROM sessions').get() as any).n)).toBe(16);db.close();
});
test('canonical unavailable budget never enrolls or refills and sends only a bounded status',async()=>{
  const f=fixture();let calls=0,notices=0;const service=createSlackConversation({...f,reply:async()=>{calls++;return 'forbidden';}});
  f.ledger.markTerminal(f.config.allocationId,'operator_stop');
  for(let n=1;n<=70;n++)await service.respond(input(n),async text=>{notices++;expect(text).toContain('No model call');return 'sent';},signal);
  expect(calls).toBe(0);expect(notices).toBe(64);expect(f.ledger.status(f.config.allocationId)?.state).toBe('closed');service.close();
});
