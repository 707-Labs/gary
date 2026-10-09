import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackService, GARY_SLACK, READY_DM_TEXT, READONLY_READY_DM_TEXT, PRIVATE_DM_STATUS, type SlackHostHealth, type SlackService, type SlackServiceOptions } from '../../src/slack/service.ts';
import type { SlackTransport,SlackFrameInfo } from '../../src/slack/transport.ts';

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
type SendArgs=Parameters<SlackTransport['sendMessage']>[0];
const healthy:SlackHostHealth={ready:true,hermesCanarySucceeded:true,receiptId:'canary-action-123:deployment-456'};
const readonlyHealthy:SlackHostHealth={kind:'readonly_runtime',ready:true,readonlyCanarySucceeded:true,receiptId:'readonly-canary-123:runtime-456'};
function fakeTransport() {
  const sends:SendArgs[]=[];let callback:((event:unknown,frame?:SlackFrameInfo)=>void|Promise<void>)|undefined;
  let connected=false,starts=0,stops=0;
  const identity={appId:GARY_SLACK.appId as string,teamId:GARY_SLACK.teamId as string,botUserId:GARY_SLACK.botUserId as string};
  let send:SlackTransport['sendMessage']=async args=>({ok:true,channel:args.channel.startsWith('U')?'D0FIXTURE1':args.channel,ts:'1791417600.000001'});
  const transport:SlackTransport={
    async identity(){return {...identity};},socketHealthy(){return connected;},
    async sendMessage(args,signal){sends.push({...args});return send(args,signal);},
    async start(handler){starts++;callback=handler;connected=true;},async stop(){stops++;connected=false;},
  };
  return {transport,sends,identity,emit:(event:unknown,frame?:SlackFrameInfo)=>Promise.resolve(callback?.(event,frame)),
    set connected(value:boolean){connected=value;},set send(value:SlackTransport['sendMessage']){send=value;},
    get starts(){return starts;},get stops(){return stops;}};
}
function fixture(extra:Partial<SlackServiceOptions>={}) {
  const db=extra.db??new Database(':memory:',{strict:true});if(!extra.db)cleanups.push(()=>db.close());
  const fake=fakeTransport();let health:SlackHostHealth={...healthy},healthCalls=0;
  const service=createSlackService({db,transport:fake.transport,checkHostHealth:async()=>{healthCalls++;return {...health};},...extra});
  cleanups.push(()=>service.stop().catch(()=>{}));
  return {db,fake,service,set health(value:SlackHostHealth){health=value;},get healthCalls(){return healthCalls;}};
}
function envelope(overrides:Record<string,unknown>={},payloadOverrides:Record<string,unknown>={}) {
  return {type:'events_api',envelope_id:'socket-envelope-1',payload:{type:'event_callback',team_id:GARY_SLACK.teamId,api_app_id:GARY_SLACK.appId,
    event_id:'EvFixture1',event:{type:'app_mention',user:GARY_SLACK.tannerId,channel:'C0APPROVED',ts:'1791417600.000002',text:`<@${GARY_SLACK.botUserId}> status`,...overrides},...payloadOverrides}};
}
function rows(db:Database):any[]{return db.query('SELECT * FROM gary_slack_outbox ORDER BY rowid').all();}
function dm(overrides:Record<string,unknown>={},payloadOverrides:Record<string,unknown>={}) {
  return envelope({type:'message',channel_type:'im',channel:'D0FIXTURE1',text:'private inbound fixture',...overrides},payloadOverrides);
}
test('alert messages route separately, preserve trusted frame size, and never enter DM or shared responders',async()=>{
  let alerts=0,dmCalls=0,shared=0,initialized=0;
  const f=fixture({checkConversationHealth:()=>true,tannerDirectMessages:true,
    conversation:{ready:()=>true,close:()=>({drained:true}),async respond(){dmCalls++;}},
    sharedConversation:{ready:()=>true,close:()=>({drained:true}),async respond(){shared++;}},
    alertIntake:{initialize(){initialized++;},ready:()=>true,close:()=>({drained:true}),drain:async()=>({drained:true}),
      async handle(_envelope,signal,available,rawBytes){alerts++;expect(rawBytes).toBe(1234);expect(signal?.aborted).toBe(false);expect(available?.()).toBe(true);return{kind:'suppressed'};}}});
  f.health={...healthy,ready:false};await f.service.start();expect(initialized).toBe(1);
  const candidate=envelope({type:'message',channel_type:'channel',channel:'C0AKGTZM8KB',bot_id:'B0AJNH6K4LF',subtype:'bot_message'});
  await f.fake.emit(candidate,{rawBytes:1234});expect(alerts).toBe(1);expect(dmCalls).toBe(0);expect(shared).toBe(0);expect(f.fake.sends).toEqual([]);
  await f.fake.emit(envelope({type:'message',channel_type:'channel',channel:'C0OTHER123'}),{rawBytes:1234});
  await f.fake.emit({...candidate,payload:{...candidate.payload,team_id:'T0FOREIGN'}},{rawBytes:1234});expect(alerts).toBe(1);
  await f.fake.emit(envelope());expect(shared).toBe(1);
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'alert_%'").all()).toEqual([]);
});
test('latched alert store is detected before socket ingress opens',async()=>{
  let handled=0;const f=fixture({alertIntake:{initialize(){},ready:()=>false,close:()=>({drained:true}),drain:async()=>({drained:true}),async handle(){handled++;return{kind:'halted'};}}});
  await expect(f.service.start()).rejects.toThrow('alert_intake_not_ready');expect(f.fake.starts).toBe(0);expect(handled).toBe(0);
});
test('a normal alert arriving during startup health does not get mistaken for failed initialization',async()=>{
  const db=new Database(':memory:',{strict:true});cleanups.push(()=>db.close());const fake=fakeTransport();let busy=false,readyChecks=0,release!:()=>void;
  const work=new Promise<void>(resolve=>{release=resolve;});
  const service=createSlackService({db,transport:fake.transport,checkConversationHealth:()=>true,
    alertIntake:{initialize(){expect(fake.starts).toBe(0);},ready(){readyChecks++;return !busy;},close:()=>({drained:!busy}),drain:async()=>({drained:!busy}),
      async handle(){busy=true;await work;busy=false;return{kind:'drafted'};}},
    async checkHostHealth(){void fake.emit(envelope({type:'message',channel_type:'channel',channel:'C0AKGTZM8KB'}),{rawBytes:1000});return{...healthy,ready:false};}});
  cleanups.push(()=>service.stop());await service.start();expect(busy).toBe(true);expect(readyChecks).toBe(1);expect(service.health.running).toBe(true);
  release();await service.stop();
});
test('shared conversation uses independent trusted runtime health without claiming coding readiness or sending a ready DM',async()=>{
  let calls=0;const f=fixture({checkConversationHealth:()=>true,sharedConversation:{ready:()=>true,close:()=>({drained:true}),async respond(input,deliver,_signal,available){
    calls++;expect(input.requesterId).toBe('U0MEMBER11');expect(input.teamId).toBe(GARY_SLACK.teamId);expect(available?.()).toBe(true);expect(await deliver('Shared answer')).toBe('sent');
  }}});f.health={...healthy,ready:false,hermesCanarySucceeded:false};await f.service.start();expect(f.fake.sends).toEqual([]);
  await f.fake.emit(envelope({user:'U0MEMBER11'}));expect(calls).toBe(1);expect(f.fake.sends).toEqual([{channel:'C0APPROVED',threadTs:'1791417600.000002',text:'Shared answer'}]);
  expect(f.service.health.hostReady).toBe(false);expect(f.service.health.readinessKind).toBe(null);expect(rows(f.db)).toEqual([]);
  await f.fake.emit(envelope({user:'U0MEMBER11'}));expect(calls).toBe(1);
});
test('shared route requires explicit mention each turn and rejects bots, DM, foreign workspace and SlackConnect envelope hints',async()=>{
  let calls=0;const f=fixture({checkConversationHealth:()=>true,sharedConversation:{ready:()=>true,close:()=>({drained:true}),async respond(){calls++;}}});f.health={...healthy,ready:false};await f.service.start();
  for(const event of [{type:'message',channel_type:'channel'},{user:GARY_SLACK.botUserId},{bot_id:'B0OTHER11'},{subtype:'bot_message'},{channel:'D0PRIVATE1'},{text:'no mention'},{team:'TFOREIGN'}])await f.fake.emit(envelope(event));
  for(const payload of [{team_id:'TFOREIGN'},{api_app_id:'AFOREIGN'},{context_team_id:'TFOREIGN'},{is_ext_shared_channel:true}])await f.fake.emit(envelope({},payload));
  expect(calls).toBe(0);expect(f.fake.sends).toEqual([]);
  await f.fake.emit(envelope({thread_ts:'1791400000.000001'}));expect(calls).toBe(1);
});
test('shared readiness does not enable private DMs and revoked conversation health blocks post-await send',async()=>{
  let allowed=true,sharedCalls=0;const f=fixture({checkConversationHealth:()=>allowed,sharedConversation:{ready:()=>true,close:()=>({drained:true}),async respond(_input,deliver,_signal,available){
    sharedCalls++;allowed=false;expect(available?.()).toBe(false);expect(await deliver('must not leave')).toBe('not_sent');
  }}});f.health={...healthy,ready:false};await f.service.start();await f.fake.emit(dm());expect(sharedCalls).toBe(0);
  await f.fake.emit(envelope());expect(sharedCalls).toBe(1);expect(f.fake.sends).toEqual([]);
});
test('private DM trusted health can remain available independently of unavailable coding/shared readiness',async()=>{
  const initial=fixture({tannerDirectMessages:true});initial.health=readonlyHealthy;await initial.service.start();await initial.service.stop();let calls=0;
  const f=fixture({db:initial.db,tannerDirectMessages:true,checkConversationHealth:()=>true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(_i,deliver){calls++;expect(await deliver('Private answer')).toBe('sent');}},
    sharedConversation:{ready:()=>false,close:()=>({drained:true}),async respond(){throw new Error('shared unavailable');}}});f.health={...healthy,ready:false};await f.service.start();
  await f.fake.emit(dm());expect(calls).toBe(1);expect(f.fake.sends[0]?.text).toBe('Private answer');expect(f.service.health.hostReady).toBe(false);
});
test('an unready store may send a fixed typed notice but never a paid answer or repeat unknown delivery',async()=>{
  let calls=0;const f=fixture({checkConversationHealth:()=>true,sharedConversation:{ready:()=>false,close:()=>({drained:false}),async respond(_input,deliver){
    calls++;expect(await deliver('unready paid answer','answer')).toBe('not_sent');expect(await deliver('Fixed bounded stop notice','notice')).toBe('unknown');
  }}});f.health={...healthy,ready:false};await f.service.start();f.fake.send=async()=>({ok:false,outcome:'unknown',code:'fixture'});
  await f.fake.emit(envelope());await f.fake.emit(envelope());expect(calls).toBe(1);expect(f.fake.sends).toEqual([{channel:'C0APPROVED',threadTs:'1791417600.000002',text:'Fixed bounded stop notice'}]);
  expect(f.db.query('SELECT status FROM gary_slack_shared_outbox').get()).toEqual({status:'unknown'});
});
test('free-form dispatch keeps Tanner/app/team/DM/readiness boundary and authenticates exact delivered content',async()=>{
  let calls=0;const f=fixture({tannerDirectMessages:true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(input,deliver){
    calls++;expect(input.text).toBe('private inbound fixture');expect(await deliver('A real conversational answer.')).toBe('sent');
  }}});f.health=readonlyHealthy;await f.service.start();
  for(const event of [{user:GARY_SLACK.benId},{channel:'D0FOREIGN'},{bot_id:'B1234567'},{subtype:'message_changed'}])await f.fake.emit(dm(event));
  await f.fake.emit(dm({}, {team_id:'T0FOREIGN'}));await f.fake.emit(dm({}, {api_app_id:'A0FOREIGN'}));expect(calls).toBe(0);
  await f.fake.emit(dm());expect(calls).toBe(1);expect(f.fake.sends[1]?.text).toBe('A real conversational answer.');
  await f.fake.emit(dm());expect(calls).toBe(1);
  f.health={...readonlyHealthy,ready:false};await f.fake.emit(dm({}, {event_id:'EvUnready'}));expect(calls).toBe(1);
});
test('upgrading old static sent/unknown DM claims never starts inference or treats old prose as new delivered text',async()=>{
  for(const unknown of [false,true]){
    const original=fixture({tannerDirectMessages:true});original.health=readonlyHealthy;await original.service.start();
    if(unknown)original.fake.send=async()=>({ok:false,outcome:'unknown',code:'fixture'});
    await original.fake.emit(dm());await original.service.stop();
    let calls=0;const upgraded=fixture({db:original.db,tannerDirectMessages:true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(){calls++;}}});
    upgraded.health=readonlyHealthy;await upgraded.service.start();await upgraded.fake.emit(dm());expect(calls).toBe(0);expect(upgraded.fake.sends).toEqual([]);
  }
});
test('conversation cannot confirm a mismatched delivery row and shutdown waits for its handler',async()=>{
  let finish!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>finish=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const f=fixture({tannerDirectMessages:true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(_input,deliver){
    expect(await deliver('first authenticated body')).toBe('sent');expect(await deliver('different body')).toBe('unknown');entered();await gate;
  }}});f.health=readonlyHealthy;await f.service.start();const event=f.fake.emit(dm());await started;
  let stopped=false;const stop=f.service.stop().then(()=>stopped=true);await Promise.resolve();expect(stopped).toBe(false);finish();await Promise.all([stop,event]);expect(stopped).toBe(true);
});
test('explicit private DM opt-in replies once only to Tanner in the previously verified private conversation',async()=>{
  const f=fixture({tannerDirectMessages:true});f.health=readonlyHealthy;await f.service.start();
  const readyBefore=JSON.stringify(rows(f.db));
  await Promise.all([f.fake.emit(dm()),f.fake.emit(dm())]);
  expect(f.fake.sends).toHaveLength(2);
  expect(f.fake.sends[1]).toEqual({channel:'D0FIXTURE1',threadTs:'1791417600.000002',text:PRIVATE_DM_STATUS});
  expect(JSON.stringify(rows(f.db))).toBe(readyBefore);
  const records=f.db.query('SELECT * FROM gary_slack_dm_outbox').all() as any[];
  expect(records).toHaveLength(1);expect(records[0]).toMatchObject({kind:'dm',request_id:'EvFixture1',recipient_id:GARY_SLACK.tannerId,status:'sent'});
  expect(JSON.stringify(records)).not.toContain('private inbound fixture');
  expect(JSON.stringify(records)).not.toContain(PRIVATE_DM_STATUS);
});
test('DM admission rejects other users, conversations, event types, bot/subtype and malformed or foreign envelopes',async()=>{
  const f=fixture({tannerDirectMessages:true});await f.service.start();
  for(const event of [{user:GARY_SLACK.benId},{user:'U0STRANGER'},{channel:'D0OTHER11'},{channel:'C0FIXTURE1'},
    {channel_type:'mpim'},{channel_type:undefined},{bot_id:'B0FIXTURE1'},{subtype:'message_changed'},
    {ts:'invalid'},{thread_ts:'invalid'},{text:''},{text:'x'.repeat(40_001)},{type:'app_mention'}])await f.fake.emit(dm(event));
  for(const payload of [{team_id:'T0WRONG11'},{api_app_id:'A0WRONG11'},{event_id:'bad'}])await f.fake.emit(dm({},payload));
  expect(f.fake.sends).toHaveLength(1);expect(f.db.query('SELECT * FROM gary_slack_dm_outbox').all()).toEqual([]);
  const disabled=fixture();await disabled.service.start();await disabled.fake.emit(dm());
  expect(disabled.fake.sends).toHaveLength(1);expect(disabled.db.query("SELECT name FROM sqlite_master WHERE name='gary_slack_dm_outbox'").all()).toEqual([]);
});
test('DM unknown delivery survives service restart without automatic retry or ready replay',async()=>{
  const f=fixture({tannerDirectMessages:true});await f.service.start();
  f.fake.send=async()=>({ok:false,outcome:'unknown',code:'fixture_timeout'});
  await f.fake.emit(dm());await f.service.stop();
  const restarted=fixture({db:f.db,tannerDirectMessages:true});await restarted.service.start();await restarted.fake.emit(dm());
  expect(restarted.fake.sends).toEqual([]);
  expect(f.db.query('SELECT status FROM gary_slack_dm_outbox').get()).toEqual({status:'unknown'});
});
test('DM preserves thread reply target and reports unavailable host without inference',async()=>{
  const f=fixture({tannerDirectMessages:true});await f.service.start();f.health={...healthy,ready:false};
  await f.fake.emit(dm({thread_ts:'1791417600.000001'}));
  expect(f.fake.sends[1]?.threadTs).toBe('1791417600.000001');expect(f.fake.sends[1]?.text).toContain('not passed');
  expect(f.fake.sends[1]?.text).toContain("haven't started a task");
  await f.service.stop();await f.fake.emit(dm({}, {event_id:'EvAfterStop'}));expect(f.fake.sends).toHaveLength(2);
});

test('construction validates policy without schema mutation, socket startup or sends',()=>{
  const f=fixture();expect(f.db.query("SELECT name FROM sqlite_master WHERE name='gary_slack_outbox'").all()).toEqual([]);
  expect(f.fake.starts).toBe(0);expect(f.fake.sends).toEqual([]);expect(f.service.health.readyDelivery).toBe('none');
  for(const policy of [{approvedChannelIds:['D0PRIVATE']},{approvedChannelIds:['C0APPROVED','C0APPROVED']},{allowedUserIds:['U0STRANGER']}]) {
    expect(()=>createSlackService({db:f.db,transport:f.fake.transport,checkHostHealth:()=>healthy,...policy})).toThrow('allowlist');
  }
});
test('service requires verified FULL synchronous before creating or claiming its WAL outbox',async()=>{
  const root=mkdtempSync(join(tmpdir(),'gary-slack-full-sync-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const db=new Database(join(root,'state.db'),{strict:true});cleanups.push(()=>db.close());
  db.exec('PRAGMA journal_mode = WAL');db.exec('PRAGMA synchronous = NORMAL');
  const level=()=>db.query<{synchronous:number},[]>('PRAGMA synchronous').get()!.synchronous;
  expect(level()).toBe(1);
  const f=fixture({db});expect(level()).toBe(1);
  f.fake.send=async()=>{
    expect(level()).toBe(2);expect(rows(db)[0].status).toBe('unknown');
    return {ok:true,channel:'D0FIXTURE1',ts:'1791417600.000001'};
  };
  expect((await f.service.start()).readyDelivery).toBe('sent');expect(level()).toBe(2);
  expect(f.fake.starts).toBe(1);expect(f.fake.sends).toHaveLength(1);
});
test('durability configuration failure propagates before outbox writes or transport startup',async()=>{
  const f=fixture();f.db.exec('PRAGMA synchronous = NORMAL');f.db.exec('BEGIN');
  try {
    // SQLite forbids changing synchronous inside an active transaction.
    await expect(f.service.start()).rejects.toThrow('slack_durability_unverified');
    expect(f.fake.starts).toBe(0);expect(f.fake.sends).toEqual([]);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name='gary_slack_outbox'").all()).toEqual([]);
  } finally {f.db.exec('ROLLBACK');}
});
test('ready DM requires exact identity, live socket and explicit successful host canary',async()=>{
  for(const mode of ['app','team','bot','not-ready','no-canary','bad-receipt']) {
    const f=fixture();
    if(mode==='app')f.fake.identity.appId='A0WRONG';if(mode==='team')f.fake.identity.teamId='T0WRONG';if(mode==='bot')f.fake.identity.botUserId='U0WRONG';
    if(mode==='not-ready')f.health={...healthy,ready:false};if(mode==='no-canary')f.health={...healthy,hermesCanarySucceeded:false};if(mode==='bad-receipt')f.health={...healthy,receiptId:''};
    const result=await f.service.start();expect(f.fake.sends).toEqual([]);expect(result.readyDelivery).toBe('none');expect(rows(f.db)).toEqual([]);
  }
  const f=fixture();f.health={...healthy,ready:false};await f.service.start();f.health=healthy;f.fake.connected=false;
  await f.service.refreshHealth();expect(f.fake.sends).toEqual([]);f.fake.connected=true;await f.service.refreshHealth();expect(f.fake.sends).toHaveLength(1);
});
test('one ready DM claims durably before send and records only safe delivery receipt metadata',async()=>{
  const f=fixture();f.fake.send=async args=>{
    expect(rows(f.db)).toHaveLength(1);expect(rows(f.db)[0].status).toBe('unknown');expect(args).toEqual({channel:GARY_SLACK.tannerId,text:READY_DM_TEXT});
    return {ok:true,channel:'D0FIXTURE1',ts:'1791417600.000001'};
  };
  expect((await f.service.start()).readyDelivery).toBe('sent');await Promise.all([f.service.refreshHealth(),f.service.refreshHealth()]);
  expect(f.fake.sends).toHaveLength(1);expect(f.fake.starts).toBe(1);await f.service.start();expect(f.fake.starts).toBe(1);
  const row=rows(f.db)[0];expect(row).toMatchObject({kind:'ready',request_id:GARY_SLACK.readyRequest,app_id:GARY_SLACK.appId,
    team_id:GARY_SLACK.teamId,bot_user_id:GARY_SLACK.botUserId,recipient_id:GARY_SLACK.tannerId,status:'sent',slack_channel:'D0FIXTURE1',slack_ts:'1791417600.000001',readiness_receipt_id:healthy.receiptId});
  expect(row.content_sha256).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(row)).not.toContain(READY_DM_TEXT);
});
test('verified readonly runtime uses fixed accurate wording and typed status with the same recipient and one claim',async()=>{
  const f=fixture();f.health=readonlyHealthy;
  expect(READONLY_READY_DM_TEXT).toBe("i'm gary. the Hermes runtime is up, my read-only model/tool check passed, and this Slack connection is verified. coding still follows the approved Linear flow.");
  const status=await f.service.start();await f.service.refreshHealth();await f.fake.emit(envelope());
  expect(status).toMatchObject({hostReady:true,readinessKind:'readonly_runtime',readinessReceiptId:readonlyHealthy.receiptId,readyDelivery:'sent'});
  expect(f.fake.sends).toEqual([{channel:GARY_SLACK.tannerId,text:READONLY_READY_DM_TEXT}]);
  expect(rows(f.db)).toHaveLength(1);
  expect(rows(f.db)[0]).toMatchObject({kind:'ready',request_id:GARY_SLACK.readyRequest,app_id:GARY_SLACK.appId,
    team_id:GARY_SLACK.teamId,bot_user_id:GARY_SLACK.botUserId,recipient_id:GARY_SLACK.tannerId,
    delivery_key:`ready:${GARY_SLACK.readyRequest}:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${GARY_SLACK.tannerId}`});
  expect(f.fake.sends[0]!.text).not.toContain('publication');
});
test('readonly proof cannot satisfy coding readiness and malformed or mixed proof variants fail closed',async()=>{
  const cases:unknown[]=[
    {...readonlyHealthy,ready:false}, {...readonlyHealthy,readonlyCanarySucceeded:false}, {...readonlyHealthy,receiptId:''},
    {ready:true,readonlyCanarySucceeded:true,receiptId:'read-only-proof'},
    {...healthy,kind:'coding_publication',hermesCanarySucceeded:false,readonlyCanarySucceeded:true},
    {...healthy,readonlyCanarySucceeded:true}, {...readonlyHealthy,hermesCanarySucceeded:true},
    {...healthy,kind:'unknown'}, {...healthy,kind:null}, {...healthy,kind:17},
    {...readonlyHealthy,kind:'coding_publication'}, {...healthy,kind:'readonly_runtime'},
  ];
  for(const proof of cases) {
    const f=fixture({checkHostHealth:()=>proof as SlackHostHealth});
    expect(await f.service.start()).toMatchObject({hostReady:false,readinessKind:null,readinessReceiptId:null,readyDelivery:'none'});
    expect(f.fake.sends).toEqual([]);expect(rows(f.db)).toEqual([]);
  }
  const coding=fixture({checkHostHealth:()=>({...healthy,kind:'coding_publication'})});
  expect((await coding.service.start()).readinessKind).toBe('coding_publication');
  expect(coding.fake.sends).toEqual([{channel:GARY_SLACK.tannerId,text:READY_DM_TEXT}]);
});
test('readonly status replies identify the readonly proof and clear its kind when health becomes invalid',async()=>{
  const f=fixture({approvedChannelIds:['C0APPROVED']});f.health=readonlyHealthy;await f.service.start();
  await f.fake.emit(envelope());
  expect(f.fake.sends[1]).toEqual({channel:'C0APPROVED',threadTs:'1791417600.000002',text:READONLY_READY_DM_TEXT});
  f.health={...readonlyHealthy,readonlyCanarySucceeded:false};await f.service.refreshHealth();
  expect(f.service.health).toMatchObject({hostReady:false,readinessKind:null,readinessReceiptId:null});
  await f.fake.emit(envelope({}, {event_id:'EvAfterFailure'}));
  expect(f.fake.sends[2]!.text).toContain('not passed');
  expect(f.fake.sends[2]!.text).not.toContain('my read-only model/tool check passed');
});
test('switching readonly and coding proof kinds shares the original durable ready key without another DM',async()=>{
  for(const [initial,next] of [[readonlyHealthy,healthy],[healthy,readonlyHealthy]] as const) {
    const db=new Database(':memory:',{strict:true});cleanups.push(()=>db.close());
    const first=fixture({db,checkHostHealth:()=>initial});await first.service.start();await first.service.stop();
    const second=fixture({db,checkHostHealth:()=>next});
    expect((await second.service.start()).readyDelivery).toBe('sent');expect(second.fake.sends).toEqual([]);
    expect(rows(db)).toHaveLength(1);expect(first.fake.sends).toHaveLength(1);
    expect(rows(db)[0].delivery_key).toBe(`ready:${GARY_SLACK.readyRequest}:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${GARY_SLACK.tannerId}`);
  }
});
test('ambiguous readonly readiness delivery remains unknown after switching to coding readiness',async()=>{
  const f=fixture();f.health=readonlyHealthy;f.fake.send=async()=>({ok:false,outcome:'unknown',code:'offline-fixture'});
  expect((await f.service.start()).readyDelivery).toBe('unknown');
  f.health=healthy;expect((await f.service.refreshHealth()).readyDelivery).toBe('unknown');
  expect(f.fake.sends).toHaveLength(1);expect(rows(f.db)).toHaveLength(1);
});
test('durable sentinel key suppresses another DM across restart, deployment and canary changes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'gary-slack-outbox-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const db=new Database(join(root,'state.db'),{strict:true});cleanups.push(()=>db.close());
  const first=fixture({db});await first.service.start();await first.service.stop();
  const second=fixture({db,checkHostHealth:()=>({...healthy,receiptId:'new-deployment:new-canary'})});
  expect((await second.service.start()).readyDelivery).toBe('sent');expect(second.fake.sends).toEqual([]);expect(rows(db)).toHaveLength(1);
});
test('unknown claim survives closing and reopening SQLite without another send attempt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'gary-slack-reopen-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'state.db');let db=new Database(path,{strict:true});
  try {
    const first=fixture({db});first.fake.send=async()=>({ok:false,outcome:'unknown',code:'timeout'});
    await first.service.start();await first.service.stop();expect(rows(db)[0].status).toBe('unknown');
    db.close();db=new Database(path,{strict:true});
    const second=fixture({db});expect((await second.service.start()).readyDelivery).toBe('unknown');
    expect(second.fake.sends).toEqual([]);expect(rows(db)).toHaveLength(1);await second.service.stop();
  } finally {db.close();}
});
test('concurrent service instances race for one durable claim and only one sends',async()=>{
  const db=new Database(':memory:',{strict:true});cleanups.push(()=>db.close());const first=fixture({db}),second=fixture({db});
  await Promise.all([first.service.start(),second.service.start()]);expect(first.fake.sends.length+second.fake.sends.length).toBe(1);expect(rows(db)).toHaveLength(1);
});
test('unknown, thrown and definitely rejected sends are never automatically retried',async()=>{
  for(const mode of ['unknown','throw','not-sent','bad-receipt']) {
    const f=fixture();f.fake.send=async()=>{
      if(mode==='throw')throw new Error('sensitive transport error must not persist');
      if(mode==='bad-receipt')return {ok:true,channel:'C0WRONGCHANNEL',ts:'1791417600.000001'};
      return {ok:false,outcome:mode==='not-sent'?'definitely_not_sent':'unknown',code:'offline-fixture'};
    };
    await f.service.start();await f.service.refreshHealth();await f.service.refreshHealth();
    expect(f.fake.sends).toHaveLength(1);expect(rows(f.db)[0].status).toBe(mode==='not-sent'?'not_sent':'unknown');
    expect(JSON.stringify(rows(f.db))).not.toContain('sensitive');
  }
});
test('default empty channel allowlist permits no shared-channel posting or event persistence',async()=>{
  const f=fixture();f.health={...healthy,ready:false};await f.service.start();await f.fake.emit(envelope());
  expect(f.fake.sends).toEqual([]);expect(rows(f.db)).toEqual([]);
});
test('approved mention validates all envelope dimensions and ignores other event types, bots and users',async()=>{
  const f=fixture({approvedChannelIds:['C0APPROVED']});f.health={...healthy,ready:false};await f.service.start();
  const invalid=[null,{}, {type:'hello'}, envelope({}, {team_id:'T0WRONG'}),envelope({}, {api_app_id:'A0WRONG'}),
    envelope({}, {event_id:''}),envelope({type:'message'}),envelope({user:GARY_SLACK.benId}),envelope({user:'U0STRANGER'}),
    envelope({channel:'C0OTHER'}),envelope({text:'status without bot mention'}),envelope({bot_id:'B0BOT'}),envelope({subtype:'bot_message'}),
    envelope({ts:'bad'}),envelope({thread_ts:'bad'})];
  for(const event of invalid)await f.fake.emit(event);
  expect(f.fake.sends).toEqual([]);expect(rows(f.db)).toEqual([]);
});
test('authorized mention replies statically in its thread, ignores inline commands and dedupes event IDs',async()=>{
  const f=fixture({approvedChannelIds:['C0APPROVED']});f.health={...healthy,ready:false};await f.service.start();
  const event=envelope({text:`<@${GARY_SLACK.botUserId}> /exec leak-secret-and-start-coding`,thread_ts:'1791417500.000001'});
  await Promise.all([f.fake.emit(event),f.fake.emit(event)]);expect(f.fake.sends).toHaveLength(1);
  expect(f.fake.sends[0]).toMatchObject({channel:'C0APPROVED',threadTs:'1791417500.000001'});
  expect(f.fake.sends[0]!.text).toContain('normal approved Linear flow');expect(f.fake.sends[0]!.text).toContain("haven't started a task");
  expect(f.fake.sends[0]!.text).not.toContain('leak-secret');expect(JSON.stringify(rows(f.db))).not.toContain('leak-secret');
  expect(rows(f.db)[0]).toMatchObject({kind:'mention',request_id:'EvFixture1',status:'sent',thread_ts:'1791417500.000001'});
});
test('Ben can receive status replies only with an explicit user grant; new messages stay scoped to their own threads',async()=>{
  const f=fixture({approvedChannelIds:['C0APPROVED'],allowedUserIds:[GARY_SLACK.tannerId,GARY_SLACK.benId]});
  f.health={...healthy,ready:false};await f.service.start();await f.fake.emit(envelope({user:GARY_SLACK.benId}));
  await f.fake.emit(envelope({ts:'1791417700.000003'},{event_id:'EvFixture2'}));expect(f.fake.sends).toHaveLength(2);
  expect(f.fake.sends.map(s=>s.threadTs)).toEqual(['1791417600.000002','1791417700.000003']);
});
test('stop aborts a pending send, awaits its cleanup and preserves delivery uncertainty',async()=>{
  const f=fixture();let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let cleaned=false;
  f.fake.send=async(_args,signal)=>{started();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));
    await Promise.resolve();cleaned=true;return {ok:false,outcome:'unknown',code:'cancelled'};};
  const start=f.service.start();await ready;await f.service.stop();await start;
  expect(cleaned).toBe(true);expect(f.service.health.running).toBe(false);expect(rows(f.db)[0].status).toBe('unknown');
  await f.fake.emit(envelope());await f.service.refreshHealth();expect(f.fake.sends).toHaveLength(1);
});
test('host health exceptions fail closed and never leak into Slack replies or receipts',async()=>{
  const f=fixture({approvedChannelIds:['C0APPROVED'],checkHostHealth:()=>{throw new Error('private proof data');}});
  await f.service.start();expect(f.fake.sends).toEqual([]);await f.fake.emit(envelope());expect(f.fake.sends).toHaveLength(1);
  expect(f.fake.sends[0]!.text).toContain('not passed');expect(JSON.stringify(rows(f.db))).not.toContain('private proof');
});
test('shutdown awaits a pending send and persists its uncertainty even when transport.stop rejects',async()=>{
  const f=fixture();let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;}),cleanup=new Promise<void>(resolve=>{release=resolve;});
  let cleaned=false,stopSettled=false;
  f.fake.send=async(_args,signal)=>{
    started();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));
    await cleanup;cleaned=true;return {ok:false,outcome:'unknown',code:'cancelled'};
  };
  f.fake.transport.stop=async()=>{throw new Error('private transport diagnostic');};
  const start=f.service.start();await ready;
  const stop=f.service.stop();void stop.then(()=>{stopSettled=true;},()=>{stopSettled=true;});
  await Promise.resolve();await Promise.resolve();expect(stopSettled).toBe(false);expect(cleaned).toBe(false);
  release();await expect(stop).rejects.toThrow('slack_service_stop_failed');await start;
  expect(cleaned).toBe(true);expect(rows(f.db)[0].status).toBe('unknown');expect(JSON.stringify(rows(f.db))).not.toContain('private transport');
});
test('failed startup also drains cleanup and reports only a fixed diagnostic if transport.stop rejects',async()=>{
  const f=fixture();f.fake.transport.start=async()=>{throw new Error('private startup diagnostic');};
  f.fake.transport.stop=async()=>{throw new Error('private shutdown diagnostic');};
  await expect(f.service.start()).rejects.toThrow('slack_service_start_failed');
  expect(f.service.health.running).toBe(false);expect(f.fake.sends).toEqual([]);
});
test('a stopped service cannot report its cached successful start as current readiness',async()=>{
  const f=fixture();await f.service.start();await f.service.stop();
  await expect(f.service.start()).rejects.toThrow('slack_service_stopped');expect(f.service.health.running).toBe(false);
  expect(f.fake.starts).toBe(1);expect(f.fake.sends).toHaveLength(1);
});

test('ingress diagnostics distinguish gates without exposing fields; labeled mentions preserve exact authorization',async()=>{
  const records:any[]=[],calls:string[]=[];
  const f=fixture({onIngressDiagnostic:value=>{records.push(value);throw new Error('observer failure');},checkConversationHealth:()=>true,
    sharedConversation:{ready:()=>true,close:()=>({drained:true}),async respond(input){calls.push(input.text);}}});
  f.health={...healthy,ready:false};await f.service.start();
  await f.fake.emit(envelope({text:`<@${GARY_SLACK.botUserId}|Gary> synthetic-secret-body`}));
  await f.fake.emit(envelope({text:`<@${GARY_SLACK.botUserId}> synthetic-secret-body`}));
  expect(calls).toHaveLength(2);expect(records.some(x=>x.stage==='shared_dispatch')).toBe(true);
  const cases:Array<[any,any,string]>=[
    [{bot_id:null},{},'shared_bot_rejected'],[{subtype:null},{},'shared_bot_rejected'],[{user:GARY_SLACK.botUserId},{},'shared_bot_rejected'],
    [{user:'invalid'},{},'shared_shape_rejected'],[{text:`<@${GARY_SLACK.botUserId}X|Gary>`},{},'shared_mention_rejected'],
    [{text:`<@U0OTHER11|${GARY_SLACK.botUserId}>`},{},'shared_mention_rejected'],
    [{},{is_ext_shared_channel:true},'shared_scope_rejected'],[{team:'TFOREIGN'},{},'shared_scope_rejected'],
    [{},{api_app_id:'AFOREIGN'},'service_payload_rejected'],
  ];
  for(const [event,payload,stage] of cases){records.length=0;await f.fake.emit(envelope(event,payload));expect(records.at(-1).stage).toBe(stage);}
  expect(calls).toHaveLength(2);
  f.fake.identity.teamId='TFOREIGN';records.length=0;await f.fake.emit(envelope());expect(records.at(-1).stage).toBe('shared_health_rejected');
  expect(calls).toHaveLength(2);expect(f.fake.sends).toEqual([]);
  expect(JSON.stringify(records)).not.toContain('synthetic-secret-body');expect(JSON.stringify(records)).not.toContain(GARY_SLACK.tannerId);
});
