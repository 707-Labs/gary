import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackConversation, migrateSlackConversationPolicy, rollbackSlackConversationPolicy, legacyFingerprintSlackConversationConfig, fingerprintSlackConversationConfig, loadSlackConversationConfig, type SlackConversationInput } from '../../src/slack/conversation.ts';
import { createHermesDMResponder, DM_CONVERSATION_POLICY as POLICY, DMReplyError, type DMTurn } from '../../src/hermes/dm-conversation.ts';
import { SpendLedger } from '../../src/spend.ts';
import { createConversationEngineeringCapability } from '../../src/hermes/conversation-engineering.ts';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture(persistentLedger=false){const dir=realpathSync(mkdtempSync(join(tmpdir(),'gary-dm-context-')));chmodSync(dir,0o700);cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'conversation.json');writeFileSync(path,JSON.stringify({version:1,runId:'hermes-dm-20261008',campaignId:'hermes-dm-20261008',allocationId:'local:hermes-dm-20261008-tanner'}),{mode:0o600});
  const config=loadSlackConversationConfig(path),ledgerPath=join(dir,'spend.sqlite'),ledger=new SpendLedger(persistentLedger?ledgerPath:':memory:');cleanup.push(()=>ledger.close());ledger.createCampaign(config.campaignId,5);ledger.enrollTicket(config.campaignId,config.allocationId,5);
  return{dir,path,config,ledger,ledgerPath};}
const signal=new AbortController().signal;
const input=(n:number,extra:Partial<SlackConversationInput>={}):SlackConversationInput=>({eventId:'EvFixture'+n,channel:'D0FIXTURE1',ts:'1791417600.'+String(n).padStart(6,'0'),threadTs:'1791417600.'+String(n).padStart(6,'0'),text:'private fabricated phrase violet sparrow',...extra});
const sent=async()=> 'sent' as const;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const paidRequest=(maxTokens=4096)=>new Request('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer offline-fixture'},
  body:JSON.stringify({model:'deepseek-v4-pro',max_tokens:maxTokens,messages:[{role:'user',content:'synthetic queue fixture'}]})});
const paidReceipt=(inputTokens=30)=>Response.json({id:'msg_queue_fixture',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'text',text:'fixture reply'}],stop_reason:'end_turn',
  usage:{input_tokens:inputTokens,output_tokens:9,cache_read_input_tokens:0,cache_creation_input_tokens:0}});

test('queued input retains original host engineering capability and text without serializing authority into history',async()=>{
  const f=fixture(),release=deferred(),started=deferred(),turns:DMTurn[]=[];
  const engineering=createConversationEngineeringCapability({surface:'private_dm',requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',channelId:'D0FIXTURE1',threadTs:input(1).ts},
    async()=>({ok:true,dataOnly:true,data:null}));
  const service=createSlackConversation({...f,reply:async turn=>{turns.push(turn);if(turns.length===1){started.resolve();await release.promise;}return 'reply';}});
  const first=service.respond(input(1),sent,signal);await started.promise;
  const secondInput=input(2,{threadTs:input(1).ts,text:'Fix 707-Labs/new-app',engineering});
  const second=service.respond(secondInput,sent,signal);secondInput.text='mutated';delete secondInput.engineering;
  release.resolve();await Promise.all([first,second]);
  expect(turns[1]!.text).toBe('Fix 707-Labs/new-app');expect(turns[1]!.engineering).toBe(engineering);
  expect(JSON.stringify(turns[1]!.history)).not.toContain('host_conversation_engineering');expect(service.close()).toEqual({drained:true});
});

test('a real held guarded reservation queues a follow-up, settles, and executes it once with committed history',async()=>{
  const f=fixture(),started=deferred(),release=deferred(),turns:DMTurn[]=[],messages:Array<{text:string;kind?:string}>=[];
  const transport=f.ledger.guardedFetch('deepseek',(async(_request:RequestInfo|URL,_init?:RequestInit)=>{if(turns.length===1){started.resolve();await release.promise;}return paidReceipt();}) as typeof fetch);
  const service=createSlackConversation({...f,reply:async turn=>{turns.push(turn);await f.ledger.withSpendScope(f.config.allocationId,()=>transport(paidRequest()));return 'answer '+turns.length;}});
  const deliver=async(text:string,kind?:'answer'|'notice')=>{messages.push({text,...(kind?{kind}:{})});return 'sent' as const;};
  const first=service.respond(input(1),deliver,signal);await started.promise;
  expect(f.ledger.unresolvedAttempts(f.config.allocationId)).toEqual([{id:1,state:'reserved'}]);expect(service.ready()).toBe(false);
  const second=service.respond(input(2,{threadTs:input(1).ts}),deliver,signal),duplicate=service.respond(input(2,{threadTs:input(1).ts}),deliver,signal);
  const db=new Database(join(f.dir,'context.sqlite'));
  expect(db.query('SELECT state FROM events ORDER BY rowid').all()).toEqual([{state:'running'},{state:'queued'}]);expect(messages).toEqual([]);expect(turns).toHaveLength(1);
  release.resolve();await Promise.all([first,second,duplicate]);
  expect(turns).toHaveLength(2);expect(turns[1]!.history).toEqual([{role:'user',content:input(1).text},{role:'assistant',content:'answer 1'}]);
  expect(messages.map(m=>m.kind)).toEqual(['answer','answer']);expect(f.ledger.status(f.config.allocationId)?.attemptCount).toBe(2);expect(f.ledger.unresolvedAttempts(f.config.allocationId)).toEqual([]);
  expect(db.query('SELECT state,cleanup FROM events ORDER BY rowid').all()).toEqual([{state:'sent',cleanup:1},{state:'sent',cleanup:1}]);db.close();expect(service.close()).toEqual({drained:true});
});

test('queue ownership propagates through the real Hermes responder and model transport with an offline launcher/provider',async()=>{
  const f=fixture(),started=deferred(),release=deferred(),messages:string[]=[];let providers=0;
  const reply=createHermesDMResponder({ledger:f.ledger,providerApiKey:'offline-key',fetch:async()=>{
    if(++providers===1){started.resolve();await release.promise;}return paidReceipt();
  },launch:async(manifest,handle)=>{
    const history=[...(manifest.history??[]),{role:'user',content:manifest.prompt}];
    const response=await handle(new Request('http://127.0.0.1/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+manifest.capability},
      body:JSON.stringify({model:manifest.model,messages:history,max_tokens:manifest.maxTokens,temperature:manifest.temperature,stream:false})}));
    expect(response.ok).toBe(true);const completion=await response.json();
    return {taskId:manifest.taskId,requestId:manifest.requestId,status:'no_finish',publicationApproved:false,history:[...history,completion.choices[0].message]};
  }});
  const service=createSlackConversation({...f,reply}),deliver=async(text:string)=>{messages.push(text);return 'sent' as const;};
  const first=service.respond(input(1),deliver,signal);await started.promise;
  const second=service.respond(input(2,{threadTs:input(1).ts}),deliver,signal);
  expect(messages).toEqual([]);expect(providers).toBe(1);release.resolve();await Promise.all([first,second]);
  expect(messages).toEqual(['fixture reply','fixture reply']);expect(providers).toBe(2);expect(f.ledger.status(f.config.allocationId)).toMatchObject({attemptCount:2,unknownAttempts:0});
  expect(service.close()).toEqual({drained:true});
});

test('same-ID unknown spend, changed owner, stale event and aborted owner cannot lend an in-flight queue exception',async()=>{
  for(const failure of ['unknown','owner','stale','aborted','unavailable','restart'] as const){
    const f=fixture(true),started=deferred(),release=deferred(),controller=new AbortController();let calls=0,notices=0;
    let available=true;
    const transport=f.ledger.guardedFetch('deepseek',(async(_request:RequestInfo|URL,_init?:RequestInit)=>{started.resolve();await release.promise;return paidReceipt();}) as typeof fetch);
    const service=createSlackConversation({...f,reply:async()=>{calls++;await f.ledger.withSpendScope(f.config.allocationId,()=>transport(paidRequest()));return 'must not deliver';}});
    const first=service.respond(input(1),sent,controller.signal,()=>available);await started.promise;
    const db=new Database(join(f.dir,'context.sqlite')),spend=new Database(f.ledgerPath);
    if(failure==='unknown')spend.query("UPDATE spend_attempts SET state='unknown' WHERE id=1").run();
    if(failure==='owner')db.query("UPDATE events SET owner='foreign-owner'").run();
    if(failure==='stale')db.query("UPDATE events SET state='failed'").run();
    if(failure==='aborted')controller.abort();
    if(failure==='unavailable')available=false;
    if(failure==='restart')expect(()=>createSlackConversation({...f,reply:async()=> 'never'})).toThrow('dm_budget_unavailable');
    await service.respond(input(2),async(_text,kind)=>{if(kind==='notice')notices++;return 'sent';},signal);
    expect(db.query('SELECT count(*) n FROM events').get()).toEqual({n:1});expect(notices).toBe(1);expect(calls).toBe(1);
    release.resolve();await first;expect(calls).toBe(1);db.close();spend.close();service.close();
  }
});

test('foreign same-allocation reservations remain fenced even while this owner has a known active request',async()=>{
  const f=fixture(),started=deferred(),release=deferred(),foreignStarted=deferred(),foreignRelease=deferred();let calls=0,notices=0;
  const own=f.ledger.guardedFetch('deepseek',(async(_request:RequestInfo|URL,_init?:RequestInit)=>{started.resolve();await release.promise;return paidReceipt();}) as typeof fetch);
  const foreign=f.ledger.guardedFetch('deepseek',(async(_request:RequestInfo|URL,_init?:RequestInit)=>{foreignStarted.resolve();await foreignRelease.promise;return paidReceipt();}) as typeof fetch);
  const service=createSlackConversation({...f,reply:async()=>{calls++;await f.ledger.withSpendScope(f.config.allocationId,()=>own(paidRequest()));return 'first';}});
  const first=service.respond(input(1),sent,signal);await started.promise;
  const competing=f.ledger.withSpendScope(f.config.allocationId,()=>foreign(paidRequest()));await foreignStarted.promise;
  expect(f.ledger.unresolvedAttempts(f.config.allocationId)).toHaveLength(2);
  await service.respond(input(2),async()=>{notices++;return 'sent';},signal);expect(notices).toBe(1);expect(calls).toBe(1);
  foreignRelease.resolve();await competing;release.resolve();await first;expect(calls).toBe(1);service.close();
});

test('queued work rechecks actual settlement and never spends after unknown usage or depletion',async()=>{
  for(const failure of ['unknown','depleted'] as const){
    const f=fixture(),started=deferred(),release=deferred();let calls=0;
    if(failure==='depleted'){
      const seed=f.ledger.guardedFetch('deepseek',(async(_request:RequestInfo|URL,_init?:RequestInit)=>paidReceipt(1_048_576)) as typeof fetch);
      for(let n=0;n<2;n++)await f.ledger.withSpendScope(f.config.allocationId,()=>seed(paidRequest(8192)));
    }
    const transport=f.ledger.guardedFetch('deepseek',(async(_request:RequestInfo|URL,_init?:RequestInit)=>{started.resolve();await release.promise;if(failure==='unknown')throw new Error('offline transport failure');return paidReceipt(1_048_576);}) as typeof fetch);
    const service=createSlackConversation({...f,reply:async()=>{calls++;await f.ledger.withSpendScope(f.config.allocationId,()=>transport(paidRequest()));return 'last funded reply';}});
    const first=service.respond(input(1),sent,signal);await started.promise;const second=service.respond(input(2),sent,signal);
    const db=new Database(join(f.dir,'context.sqlite'));expect(db.query('SELECT state FROM events ORDER BY rowid').all()).toEqual([{state:'running'},{state:'queued'}]);
    release.resolve();await Promise.all([first,second]);expect(calls).toBe(1);
    expect(f.ledger.status(f.config.allocationId)?.attemptCount).toBe(failure==='depleted'?3:1);
    expect(f.ledger.status(f.config.allocationId)?.unknownAttempts).toBe(failure==='depleted'?0:1);
    expect(db.query('SELECT state FROM events ORDER BY rowid').all()).toEqual([{state:failure==='depleted'?'sent':'failed'},{state:'failed'}]);db.close();service.close();
  }
});

test('a detached prior-event callback cannot reserve or borrow the next running event lease',async()=>{
  const f=fixture(),late=deferred(),started=deferred(),release=deferred();let calls=0,lateRequest!:Promise<Response>;
  const transport=f.ledger.guardedFetch('deepseek',(async(_request:RequestInfo|URL,_init?:RequestInit)=>{started.resolve();await release.promise;return paidReceipt();}) as typeof fetch);
  const service=createSlackConversation({...f,reply:async()=>{
    if(++calls===1){lateRequest=late.promise.then(()=>f.ledger.withSpendScope(f.config.allocationId,()=>transport(paidRequest())));return 'first';}
    await f.ledger.withSpendScope(f.config.allocationId,()=>transport(paidRequest()));return 'second';
  }});
  await service.respond(input(1),sent,signal);const second=service.respond(input(2),sent,signal);await started.promise;
  late.resolve();await expect(lateRequest).rejects.toThrow('dm_owner_changed');
  expect(f.ledger.status(f.config.allocationId)?.attemptCount).toBe(1);expect(f.ledger.unresolvedAttempts(f.config.allocationId)).toEqual([{id:1,state:'reserved'}]);
  release.resolve();await second;expect(service.close()).toEqual({drained:true});
});
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
test('actionable finite failure survives restart without replaying a completed mutation or its notice',async()=>{
  const f=fixture();const messages:string[]=[];let mutations=0,calls=0;
  let service=createSlackConversation({...f,reply:async()=>{calls++;mutations++;throw new DMReplyError('project_tool_limit',true);}});
  await service.respond(input(1),async text=>{messages.push(text);return 'sent';},signal);
  expect(messages).toHaveLength(1);expect(messages[0]).toContain('tool limit');expect(messages[0]).toContain("aren't repeated");
  expect(service.close()).toEqual({drained:true});
  service=createSlackConversation({...f,reply:async()=>{calls++;mutations++;return 'must not replay';}});
  await service.respond(input(1),async text=>{messages.push(text);return 'sent';},signal);
  expect(calls).toBe(1);expect(mutations).toBe(1);expect(messages).toHaveLength(1);
  const db=new Database(join(f.dir,'context.sqlite'));
  expect(db.query('SELECT state,cleanup,error_code FROM events').get()).toEqual({state:'failed',cleanup:1,error_code:'project_tool_limit'});
  expect(db.query('SELECT blocked FROM sessions').get()).toEqual({blocked:1});db.close();service.close();
});
test('uncertain cleanup takes precedence over a recoverable-looking cause without exposing exception text',async()=>{
  const f=fixture();const messages:string[]=[];
  const service=createSlackConversation({...f,reply:async()=>{throw new DMReplyError('project_context_limit',false);}});
  await service.respond(input(1),async text=>{messages.push(text);return 'sent';},signal);
  expect(messages[0]).toContain("couldn't confirm that the worker stopped");expect(messages[0]).not.toContain('Start a new thread');
  expect(service.close()).toEqual({drained:false});
});
test('serialized queue max4, unknown historical threads and UTF8 input cap produce no extra calls',async()=>{
  const f=fixture();let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);let calls=0,inFlight=0,max=0;
  const service=createSlackConversation({...f,reply:async()=>{calls++;max=Math.max(max,++inFlight);await wait;inFlight--;return 'reply';}});
  const jobs=[1,2,3,4,5].map(n=>service.respond(input(n),sent,signal));release();await Promise.all(jobs);
  expect(calls).toBe(4);expect(max).toBe(1);
  await service.respond(input(6,{threadTs:'1791417000.000001'}),sent,signal);
  await service.respond(input(7,{text:'🦜'.repeat(POLICY.maxInputBytes/4+1)}),sent,signal);expect(calls).toBe(4);expect(service.close()).toEqual({drained:true});
});
test('persisted session/turn/accepted-event bounds and bounded rejection notices survive process restarts',async()=>{
  const f=fixture();let calls=0;const reply=async()=>{calls++;return 'r';};let service=createSlackConversation({...f,reply});
  for(let n=1;n<=POLICY.maxSessions+1;n++)await service.respond(input(n),sent,signal);expect(calls).toBe(POLICY.maxSessions);service.close();
  service=createSlackConversation({...f,reply});for(let n=100;n<100+POLICY.maxTurns;n++)await service.respond(input(n,{threadTs:input(1).ts}),sent,signal);
  expect(calls).toBe(POLICY.maxSessions+POLICY.maxTurns-1);service.close();
  const db=new Database(join(f.dir,'context.sqlite'));expect((db.query('SELECT turns FROM sessions WHERE session_key=?').get('D0FIXTURE1:'+input(1).ts) as any).turns).toBe(POLICY.maxTurns);
  expect(Number((db.query('SELECT count(*) AS n FROM sessions').get() as any).n)).toBe(POLICY.maxSessions);db.close();
});
test('canonical unavailable budget never enrolls or refills and sends only a bounded status',async()=>{
  const f=fixture();let calls=0,notices=0;const service=createSlackConversation({...f,reply:async()=>{calls++;return 'forbidden';}});
  f.ledger.markTerminal(f.config.allocationId,'operator_stop');
  for(let n=1;n<=70;n++)await service.respond(input(n),async text=>{notices++;expect(text).toContain('No model call');return 'sent';},signal);
  expect(calls).toBe(0);expect(notices).toBe(64);expect(f.ledger.status(f.config.allocationId)?.state).toBe('closed');service.close();
});

test('operator-only exact predecessor migration preserves stopped sessions/events/notices and supports rollback only before state changes',async()=>{
  const f=fixture();let service=createSlackConversation({...f,reply:async()=>{throw new DMReplyError('project_tool_limit',true);}});
  await service.respond(input(1),sent,signal);await service.respond(input(2,{threadTs:input(1).ts}),sent,signal);service.close();
  const db=new Database(join(f.dir,'context.sqlite'));
  db.query('UPDATE control SET fingerprint=?').run(legacyFingerprintSlackConversationConfig(f.config));
  const state=()=>({control:db.query('SELECT blocked FROM control').all(),sessions:db.query('SELECT * FROM sessions').all(),events:db.query('SELECT * FROM events').all(),notices:db.query('SELECT * FROM notices').all()});
  const before=state();
  expect(()=>createSlackConversation({...f,reply:async()=> 'never'})).toThrow('dm_context_config_mismatch');
  const receipt=migrateSlackConversationPolicy(f.config);expect(receipt?.fromFingerprint).toBe(legacyFingerprintSlackConversationConfig(f.config));
  expect(receipt?.toFingerprint).toBe(fingerprintSlackConversationConfig(f.config));expect(receipt?.stateSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(state()).toEqual(before);expect(migrateSlackConversationPolicy(f.config)).toBeNull();
  rollbackSlackConversationPolicy(f.config);expect(state()).toEqual(before);
  expect(db.query('SELECT fingerprint FROM control').get()).toEqual({fingerprint:legacyFingerprintSlackConversationConfig(f.config)});
  const historicalReceipt=db.query('SELECT * FROM policy_migrations WHERE id=1').get();
  expect(migrateSlackConversationPolicy(f.config)?.stateSha256).toBe(receipt!.stateSha256);
  expect(db.query('SELECT * FROM policy_migrations WHERE id=1').get()).toEqual(historicalReceipt);
  expect(db.query('SELECT count(*) n FROM policy_migrations').get()).toEqual({n:2});
  rollbackSlackConversationPolicy(f.config);expect(state()).toEqual(before);
  // A different/unreviewed predecessor cannot be blessed by the migration.
  db.query('UPDATE control SET fingerprint=?').run('f'.repeat(64));expect(()=>migrateSlackConversationPolicy(f.config)).toThrow('dm_context_config_mismatch');expect(state()).toEqual(before);db.close();
});

test('migration refuses unresolved cleanup without clearing a global stop, and rollback refuses any new conversation receipt',async()=>{
  const f=fixture();const service=createSlackConversation({...f,reply:async()=>{throw new DMReplyError('worker_cleanup_failed',false);}});
  await service.respond(input(1),sent,signal);service.close();
  const db=new Database(join(f.dir,'context.sqlite'));db.query('UPDATE control SET fingerprint=?').run(legacyFingerprintSlackConversationConfig(f.config));
  expect(()=>migrateSlackConversationPolicy(f.config)).toThrow('dm_context_migration_not_drained');
  expect(db.query('SELECT blocked FROM control').get()).toEqual({blocked:1});expect(db.query('SELECT cleanup FROM events').get()).toEqual({cleanup:0});db.close();
  const g=fixture();createSlackConversation({...g,reply:async()=> 'never'}).close();const check=new Database(join(g.dir,'context.sqlite'));
  check.query('UPDATE control SET fingerprint=?').run(legacyFingerprintSlackConversationConfig(g.config));migrateSlackConversationPolicy(g.config);
  const active=createSlackConversation({...g,reply:async()=> 'new confirmed answer'});await active.respond(input(1),sent,signal);active.close();
  expect(()=>rollbackSlackConversationPolicy(g.config)).toThrow('dm_context_rollback_state_changed');
  expect(check.query('SELECT state FROM events').get()).toEqual({state:'sent'});expect(check.query('SELECT fingerprint FROM control').get()).toEqual({fingerprint:fingerprintSlackConversationConfig(g.config)});check.close();
});

test('full64KiB answers and verified compressed context commit together only after all parts are confirmed',async()=>{
  for(const delivery of ['sent','unknown'] as const){
    const f=fixture();let calls=0;const original='old fact '.repeat(8_000),summary=[{role:'user' as const,content:'Archived conversation facts; source digest fixture'},{role:'assistant' as const,content:'Old fact summary'}];
    const service=createSlackConversation({...f,reply:async turn=>{calls++;if(calls===1)return 'first';expect(turn.history[0]?.content).toBe(original);turn.compactHistory!(summary);return 'A'.repeat(65_536);}});
    // Seed a valid audience-local old transcript, then exercise the actual delivery commit path.
    await service.respond(input(1),sent,signal);
    const db=new Database(join(f.dir,'context.sqlite'));const old=[{role:'user',content:original},{role:'assistant',content:'recorded answer'}];
    db.query('UPDATE sessions SET history=?').run(JSON.stringify(old));
    await service.respond(input(2,{threadTs:input(1).ts}),async text=>{expect(Buffer.byteLength(text)).toBe(65_536);return delivery;},signal);service.close();
    const row=db.query('SELECT history,blocked FROM sessions').get() as any;
    if(delivery==='sent'){
      expect(JSON.parse(row.history)).toEqual([...summary,{role:'user',content:input(2).text},{role:'assistant',content:'A'.repeat(65_536)}]);
      const archive=db.query('SELECT dropped_messages,archived_history,before_sha256,after_sha256 FROM history_compactions').get() as any;
      expect(archive.dropped_messages).toBe(2);expect(JSON.parse(archive.archived_history)).toEqual(old);expect(archive.before_sha256).not.toBe(archive.after_sha256);expect(row.blocked).toBe(0);
    }else{expect(JSON.parse(row.history)).toEqual(old);expect(db.query('SELECT * FROM history_compactions').all()).toEqual([]);expect(row.blocked).toBe(1);}
    db.close();
  }
});

test('bounded complete-pair history fallback preserves discarded source in the same private store without losing event receipts',async()=>{
  const f=fixture();let calls=0;const service=createSlackConversation({...f,reply:async()=>{calls++;return 'r'.repeat(60_000);}});
  await service.respond(input(1),sent,signal);const db=new Database(join(f.dir,'context.sqlite'));
  const old=[{role:'user',content:'ancient source '.repeat(11000)},{role:'assistant',content:'ancient answer'}, {role:'user',content:'recent source'},{role:'assistant',content:'recent answer'}];
  db.query('UPDATE sessions SET history=?').run(JSON.stringify(old));
  await service.respond(input(2,{threadTs:input(1).ts}),sent,signal);service.close();
  expect(calls).toBe(2);const history=JSON.parse((db.query('SELECT history FROM sessions').get() as any).history);
  expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(POLICY.maxContextBytes);expect(history.slice(-2)[0].content).toBe(input(2).text);
  const archived=db.query('SELECT archived_history,dropped_messages FROM history_compactions').get() as any;expect(archived.dropped_messages).toBe(2);expect(JSON.parse(archived.archived_history)).toEqual(old.slice(0,2));
  expect(db.query('SELECT state FROM events ORDER BY event_key').all()).toEqual([{state:'sent'},{state:'sent'}]);db.close();
});
