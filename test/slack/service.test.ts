import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderSlackReplyParts, renderSlackReply, SLACK_REPLY_TRUNCATED } from '../../src/slack/render.ts';
import { createSlackService, GARY_SLACK, READY_DM_TEXT, READONLY_READY_DM_TEXT, PRIVATE_DM_STATUS, type EngineeringIngressRequest, type EngineeringReceipt, type EngineeringIngress, type SlackHostHealth, type SlackService, type SlackServiceOptions } from '../../src/slack/service.ts';
import type { SlackTransport,SlackFrameInfo } from '../../src/slack/transport.ts';
import { submitConversationEngineering } from '../../src/hermes/conversation-engineering.ts';
import { createSlackConversation } from '../../src/slack/conversation.ts';
import { DMReplyError } from '../../src/hermes/dm-conversation.ts';
import { SpendLedger } from '../../src/spend.ts';

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
  // Mock responders have no metadata client; supply an explicit trusted authorization stub for their delivery.
  const shared=extra.sharedConversation;
  const configured=shared?{...extra,sharedConversation:{...shared,respond:(...args:Parameters<typeof shared.respond>)=>{
    const [input,deliver,signal,available]=args;return shared.respond(input,(text,kind,authorize)=>deliver(text,kind,authorize??(async()=>true)),signal,available);
  }}}:extra;
  const service=createSlackService({db,transport:fake.transport,checkHostHealth:async()=>{healthCalls++;return {...health};},...configured});
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
    sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(){shared++;}},
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
  let calls=0;const f=fixture({checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(input,deliver,_signal,available){
    calls++;expect(input.requesterId).toBe('U0MEMBER11');expect(input.teamId).toBe(GARY_SLACK.teamId);expect(available?.()).toBe(true);expect(await deliver('Shared answer')).toBe('sent');
  }}});f.health={...healthy,ready:false,hermesCanarySucceeded:false};await f.service.start();expect(f.fake.sends).toEqual([]);
  await f.fake.emit(envelope({user:'U0MEMBER11'}));expect(calls).toBe(1);expect(f.fake.sends).toEqual([{channel:'C0APPROVED',threadTs:'1791417600.000002',text:'Shared answer'}]);
  expect(f.service.health.hostReady).toBe(false);expect(f.service.health.readinessKind).toBe(null);expect(rows(f.db)).toEqual([]);
  await f.fake.emit(envelope({user:'U0MEMBER11'}));expect(calls).toBe(1);
});
test('plain replies in a joined thread reach the shared responder; roots, unjoined threads, bots, DMs and mentions are not routed from message events',async()=>{
  const inputs:any[]=[],records:any[]=[];let joined=true;
  const f=fixture({onIngressDiagnostic:r=>{records.push(r);},checkConversationHealth:()=>true,sharedConversation:{joined:(channel,threadTs)=>{inputs.push({joined:[channel,threadTs]});return joined;},ready:()=>true,close:()=>({drained:true}),
    async respond(input,deliver){inputs.push(input);expect(await deliver('Thread answer')).toBe('sent');}}});
  f.health={...healthy,ready:false};await f.service.start();const before=f.healthCalls;
  const reply=(event:Record<string,unknown>={},payload:Record<string,unknown>={})=>envelope({type:'message',channel_type:'channel',thread_ts:'1791417500.000001',text:'what are you working on now?',...event},{event_id:'EvThread1',...payload});
  for(const event of [{thread_ts:undefined},{thread_ts:'1791417600.000002'},{bot_id:'B0OTHER11'},{subtype:'message_changed'},{user:GARY_SLACK.botUserId},{user:'USLACKBOT'},{channel_type:'mpim'},{channel:'D0PRIVATE1'},
    {user:'invalid'},{text:'   '},{ts:'bad'},{thread_ts:'bad'},{text:`<@${GARY_SLACK.botUserId}> hi`},{team:'TFOREIGN'}])await f.fake.emit(reply(event));
  await f.fake.emit(reply({},{is_ext_shared_channel:true}));
  expect(inputs).toEqual([]);expect(f.healthCalls).toBe(before);expect(f.fake.sends).toEqual([]);
  joined=false;await f.fake.emit(reply());expect(inputs).toEqual([{joined:['C0APPROVED','1791417500.000001']}]);expect(f.healthCalls).toBe(before);expect(records.at(-1).stage).toBe('shared_thread_inactive');
  joined=true;inputs.length=0;await f.fake.emit(reply());
  expect(inputs).toEqual([{joined:['C0APPROVED','1791417500.000001']},{type:'thread_reply',appId:GARY_SLACK.appId,teamId:GARY_SLACK.teamId,botUserId:GARY_SLACK.botUserId,requesterId:GARY_SLACK.tannerId,
    eventId:'EvThread1',channel:'C0APPROVED',ts:'1791417600.000002',threadTs:'1791417500.000001',text:'what are you working on now?'}]);
  expect(f.fake.sends).toEqual([{channel:'C0APPROVED',threadTs:'1791417500.000001',text:'Thread answer'}]);expect(records.some(r=>r.stage==='shared_thread_dispatch')).toBe(true);
  inputs.length=0;await f.fake.emit(reply());expect(inputs).toEqual([{joined:['C0APPROVED','1791417500.000001']}]);expect(records.at(-1).stage).toBe('shared_duplicate');
  expect(f.db.query('SELECT kind,request_id,status,thread_ts FROM gary_slack_shared_outbox').all()).toEqual([{kind:'shared',request_id:'EvThread1',status:'sent',thread_ts:'1791417500.000001'}]);
  expect(JSON.stringify(records)).not.toContain('what are you working on');
});
test('shared mention route rejects bots, DM, foreign workspace and SlackConnect envelope hints; unthreaded channel messages are ignored',async()=>{
  let calls=0;const f=fixture({checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(){calls++;}}});f.health={...healthy,ready:false};await f.service.start();
  for(const event of [{type:'message',channel_type:'channel'},{user:GARY_SLACK.botUserId},{user:'USLACKBOT'},{bot_id:'B0OTHER11'},{subtype:'bot_message'},{channel:'D0PRIVATE1'},{text:'no mention'},{team:'TFOREIGN'}])await f.fake.emit(envelope(event));
  for(const payload of [{team_id:'TFOREIGN'},{api_app_id:'AFOREIGN'},{context_team_id:'TFOREIGN'},{is_ext_shared_channel:true}])await f.fake.emit(envelope({},payload));
  expect(calls).toBe(0);expect(f.fake.sends).toEqual([]);
  await f.fake.emit(envelope({thread_ts:'1791400000.000001'}));expect(calls).toBe(1);
});
test('shared readiness does not enable private DMs and revoked conversation health blocks post-await send',async()=>{
  let allowed=true,sharedCalls=0;const f=fixture({checkConversationHealth:()=>allowed,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(_input,deliver,_signal,available){
    sharedCalls++;allowed=false;expect(available?.()).toBe(false);expect(await deliver('must not leave')).toBe('not_sent');
  }}});f.health={...healthy,ready:false};await f.service.start();await f.fake.emit(dm());expect(sharedCalls).toBe(0);
  await f.fake.emit(envelope());expect(sharedCalls).toBe(1);expect(f.fake.sends).toEqual([]);
});
test('private DM trusted health can remain available independently of unavailable coding/shared readiness',async()=>{
  const initial=fixture({tannerDirectMessages:true});initial.health=readonlyHealthy;await initial.service.start();await initial.service.stop();let calls=0;
  const f=fixture({db:initial.db,tannerDirectMessages:true,checkConversationHealth:()=>true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(_i,deliver){calls++;expect(await deliver('Private answer')).toBe('sent');}},
    sharedConversation:{joined:()=>true,ready:()=>false,close:()=>({drained:true}),async respond(){throw new Error('shared unavailable');}}});f.health={...healthy,ready:false};await f.service.start();
  await f.fake.emit(dm());expect(calls).toBe(1);expect(f.fake.sends[0]?.text).toBe('Private answer');expect(f.service.health.hostReady).toBe(false);
});
test('an unready store may send a fixed typed notice but never a paid answer or repeat unknown delivery',async()=>{
  let calls=0;const f=fixture({checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>false,close:()=>({drained:false}),async respond(_input,deliver){
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
test('DM and shared outboxes authenticate rendered bytes, including expanded multipart output, once per event',async()=>{
  const markdown='# Summary\n**done**\n'+('& 🐌 '.repeat(3_000)),expected=renderSlackReplyParts(markdown);
  expect(expected.length).toBeGreaterThan(1);
  const sha=createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  for(const shared of [false,true]) {
    let delivered=0;
    const respond:NonNullable<SlackServiceOptions['conversation']>['respond']=async(_input,deliver)=>{
      expect(await deliver(markdown)).toBe('sent');
      expect(await deliver(markdown)).toBe('sent');
      expect(await deliver('different answer')).toBe('unknown');delivered++;
    };
    const f=fixture(shared?{checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),respond}}
      :{tannerDirectMessages:true,conversation:{ready:()=>true,close:()=>({drained:true}),respond}});
    f.health=readonlyHealthy;await f.service.start();await f.fake.emit(shared?envelope():dm());await f.fake.emit(shared?envelope():dm());
    expect(delivered).toBe(1);expect(f.fake.sends).toHaveLength(1+expected.length);expect(f.fake.sends.slice(1).map(p=>p.text)).toEqual(expected);
    const table=shared?'gary_slack_shared_outbox':'gary_slack_dm_outbox';
    expect(f.db.query(`SELECT content_sha256,status FROM ${table}`).all()).toEqual([{content_sha256:sha,status:'sent'}]);
  }
});
test('a formatted stop notice uses the same one-claim path and an unknown send is never repeated',async()=>{
  const f=fixture({checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>false,close:()=>({drained:false}),async respond(_input,deliver){
    expect(await deliver('## Blocked\n**Output limit**','notice')).toBe('unknown');
    expect(await deliver('## Blocked\n**Output limit**','notice')).toBe('unknown');
  }}});
  f.health={...healthy,ready:false};await f.service.start();f.fake.send=async()=>({ok:false,outcome:'unknown',code:'fixture'});
  await f.fake.emit(envelope());await f.fake.emit(envelope());
  expect(f.fake.sends).toEqual([{channel:'C0APPROVED',threadTs:'1791417600.000002',text:'*Blocked*\n*Output limit*'}]);
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
    sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(input){calls.push(input.text);}}});
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

test('multipart answer claims every plan then each physical send, confirms aggregate only after all parts, and never replays on restart',async()=>{
  const text='Detailed ticket evidence. '.repeat(1800),parts=renderSlackReplyParts(text);expect(parts.length).toBeGreaterThan(2);
  let delivered=0,calls=0;
  const respond:NonNullable<SlackServiceOptions['conversation']>['respond']=async(_input,deliver)=>{calls++;expect(await deliver(text)).toBe('sent');delivered++;};
  const f=fixture({checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),respond}});
  f.health={...healthy,ready:false};
  f.fake.send=async args=>{
    const index=f.fake.sends.length-1;
    const records=f.db.query('SELECT part_index,part_count,status,content_sha256 FROM gary_slack_conversation_parts ORDER BY part_index').all() as any[];
    expect(records).toHaveLength(parts.length);
    expect(records.map(p=>p.status)).toEqual(parts.map((_,i)=>i<index?'sent':i===index?'unknown':'planned'));
    expect(records[index].content_sha256).toBe(createHash('sha256').update(args.text).digest('hex'));
    expect(f.db.query('SELECT status FROM gary_slack_shared_outbox').get()).toEqual({status:'unknown'});
    expect(args.channel).toBe('C0APPROVED');expect(args.threadTs).toBe('1791417600.000002');
    return{ok:true,channel:args.channel,ts:'1791417600.'+String(index+10).padStart(6,'0')};
  };
  await f.service.start();await f.fake.emit(envelope());await f.fake.emit(envelope());await f.service.stop();
  expect(delivered).toBe(1);expect(calls).toBe(1);expect(f.fake.sends.map(p=>p.text)).toEqual(parts);
  expect(f.db.query('SELECT status FROM gary_slack_shared_outbox').get()).toEqual({status:'sent'});
  const next=fixture({db:f.db,checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),respond}});
  next.health={...healthy,ready:false};await next.service.start();await next.fake.emit(envelope());expect(next.fake.sends).toEqual([]);expect(calls).toBe(1);
});

test('an uncertain or declined multipart send stops the sequence and preserves confirmed/planned parts across restart',async()=>{
  for(const outcome of ['unknown','definitely_not_sent'] as const)for(const stopAt of [0,1]){
    const text='x'.repeat(40_000);let calls=0;
    const expected=stopAt===0&&outcome==='definitely_not_sent'?'not_sent':'unknown';
    const respond:NonNullable<SlackServiceOptions['conversation']>['respond']=async(_input,deliver)=>{calls++;expect(await deliver(text)).toBe(expected);expect(await deliver(text)).toBe(expected);};
    const sharedConversation={joined:()=>true,ready:()=>true,close:()=>({drained:true}),respond};
    const f=fixture({checkConversationHealth:()=>true,sharedConversation});f.health={...healthy,ready:false};
    f.fake.send=async args=>f.fake.sends.length-1===stopAt?{ok:false,outcome,code:'offline'}:{ok:true,channel:args.channel,ts:'1791417600.000010'};
    await f.service.start();await f.fake.emit(envelope());await f.service.stop();
    expect(f.fake.sends).toHaveLength(stopAt+1);
    expect(f.db.query('SELECT status FROM gary_slack_conversation_parts ORDER BY part_index').all()).toEqual([0,1,2].map(i=>({status:i<stopAt?'sent':i===stopAt?outcome==='unknown'?'unknown':'not_sent':'planned'})));
    expect(f.db.query('SELECT status FROM gary_slack_shared_outbox').get()).toEqual({status:expected});
    const next=fixture({db:f.db,checkConversationHealth:()=>true,sharedConversation});next.health={...healthy,ready:false};
    await next.service.start();await next.fake.emit(envelope());expect(calls).toBe(1);expect(next.fake.sends).toEqual([]);
  }
});

test('rendering beyond five parts refuses before an outbox claim or any outgoing message',async()=>{
  const f=fixture({checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(_input,deliver){expect(await deliver('&'.repeat(65_000))).toBe('not_sent');}}});
  f.health={...healthy,ready:false};await f.service.start();await f.fake.emit(envelope());
  expect(f.fake.sends).toEqual([]);expect(f.db.query('SELECT * FROM gary_slack_shared_outbox').all()).toEqual([]);
  expect(f.db.query('SELECT * FROM gary_slack_conversation_parts').all()).toEqual([]);
});

test('shared delivery without a trusted physical-send authorization callback fails closed before any claim',async()=>{
  const db=new Database(':memory:',{strict:true});cleanups.push(()=>db.close());const fake=fakeTransport();
  const service=createSlackService({db,transport:fake.transport,checkHostHealth:()=>({...healthy,ready:false}),checkConversationHealth:()=>true,
    sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(_input,deliver){expect(await deliver('No authorization callback')).toBe('not_sent');}}});
  cleanups.push(()=>service.stop());await service.start();await fake.emit(envelope());expect(fake.sends).toEqual([]);
  expect(db.query('SELECT * FROM gary_slack_shared_outbox').all()).toEqual([]);expect(db.query('SELECT * FROM gary_slack_conversation_parts').all()).toEqual([]);
});

function engineeringFixture(extra:Partial<SlackServiceOptions>={},override?:EngineeringIngress['admit']) {
  const requests:EngineeringIngressRequest[]=[],receipts=new Set<string>();let chats=0,enabled=true;
  const issue=(request:EngineeringIngressRequest,phase:'admitted'|'final'='admitted',changes:Partial<EngineeringReceipt>={}):EngineeringReceipt=>{
    const receipt:EngineeringReceipt={requestId:request.requestId,taskId:'engineering-offline-fixture',receiptId:'receipt:'+phase,phase,
      status:phase==='admitted'?'queued':'completed',text:phase==='admitted'?'Engineering request accepted.':'Engineering task completed.',...changes};
    receipts.add(JSON.stringify(receipt));return receipt;
  };
  const ingress:EngineeringIngress={async admit(request,signal,available){requests.push(request);expect(signal.aborted).toBe(false);expect(available()).toBe(true);
    return override?override(request,signal,available):issue(request);},verifyReceipt:receipt=>receipts.has(JSON.stringify(receipt)),
    readReceipt:input=>[...receipts].map(raw=>JSON.parse(raw) as EngineeringReceipt).filter(receipt=>receipt.requestId===input.requestId&&receipt.taskId===input.taskId).at(-1)??null};
  const f=fixture({tannerDirectMessages:true,checkConversationHealth:()=>true,checkEngineeringHealth:()=>enabled,engineeringIngress:ingress,
    conversation:{ready:()=>false,close:()=>({drained:true}),async respond(){chats++;}},...extra});
  return {...f,requests,issue,ingress,receipts,get chats(){return chats;},get enabled(){return enabled;},set enabled(value:boolean){enabled=value;}};
}
const engineeringMessage=(event:Record<string,unknown>={},payload:Record<string,unknown>={})=>dm({text:'!engineer 707-Labs/gary fix the fixture\nRun the offline checks.',...event},payload);

const ordinaryAudience=(input:{channel:string;threadTs:string})=>({surface:'private_dm' as const,requesterId:GARY_SLACK.tannerId,teamId:GARY_SLACK.teamId,channelId:input.channel,threadTs:input.threadTs});
test('standing ordinary DM admits exact original text once, separates answer delivery, then wakes after cleanup',async()=>{
  const text='Can you fix the login bug in 707-Labs/new-app?\nAdd a regression test.';
  let finished=false,wakes=0,toolResult:any,retained:unknown;
  const f=engineeringFixture({standingEngineeringEnabled:true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(input,deliver,signal){
    retained=input.engineering;expect(input.engineering).toBeDefined();
    toolResult=await submitConversationEngineering(input.engineering,ordinaryAudience(input),'707-Labs/new-app',signal,()=>{});
    expect(toolResult).toMatchObject({ok:true,data:{status:'queued',started:false,repository:'707-Labs/new-app'}});
    expect(wakes).toBe(0);expect(f.fake.sends).toHaveLength(1);
    expect((await submitConversationEngineering(input.engineering,ordinaryAudience(input),'707-Labs/new-app',signal,()=>{})).ok).toBeFalse();
    expect(await deliver('Your engineering task is queued.')).toBe('sent');expect(wakes).toBe(0);input.onEngineeringOutcome?.('reply_committed');finished=true;
  }}});
  f.ingress.start=()=>{expect(finished).toBeTrue();wakes++;};
  await f.service.start();await f.fake.emit(dm({text}));
  expect(wakes).toBe(1);expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({task:text,repository:'707-Labs/new-app',eventId:'EvFixture1',
    messageKey:`${GARY_SLACK.appId}:${GARY_SLACK.teamId}:D0FIXTURE1:1791417600.000002`,authority:{authenticated:true,...ordinaryAudience({channel:'D0FIXTURE1',threadTs:'1791417600.000002'})}});
  expect(Object.isFrozen(f.requests[0])).toBeTrue();expect(Object.isFrozen(f.requests[0]!.authority)).toBeTrue();
  expect(f.db.query('SELECT state,command_sha256 FROM gary_slack_engineering_ingress').get()).toEqual({state:'bound',command_sha256:createHash('sha256').update(text).digest('hex')});
  expect(f.fake.sends).toHaveLength(2);expect(f.fake.sends[1]!.text).toBe('Your engineering task is queued.');
  await f.fake.emit(dm({text}));expect(f.requests).toHaveLength(1);expect(wakes).toBe(1);
  expect((await submitConversationEngineering(retained,ordinaryAudience({channel:'D0FIXTURE1',threadTs:'1791417600.000002'}),'707-Labs/new-app',new AbortController().signal,()=>{})).ok).toBeFalse();
  expect(await f.service.deliverEngineeringReceipt(f.issue(f.requests[0]!,'final'))).toBe('sent');
  expect(f.fake.sends.at(-1)!.channel).toBe('D0FIXTURE1');
});

test('ordinary engineering cannot promote quoted, unrelated, absent or model-selected repository scope',async()=>{
  for(const [text,repository] of [['What is 707-Labs/new-app doing?','707-Labs/new-app'],['Please explain:\n> Fix 707-Labs/new-app','707-Labs/new-app'],
    ['Fix 707-Labs/one and 707-Labs/two','707-Labs/one'],['Fix 707-Labs/one','707-Labs/two'],['Fix the bug','707-Labs/new-app']]) {
    let result:any;
    const f=engineeringFixture({standingEngineeringEnabled:true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(input,deliver,signal){
      result=await submitConversationEngineering(input.engineering,ordinaryAudience(input),repository,signal,()=>{});await deliver('Please clarify the repository and action.');
    }}});await f.service.start();await f.fake.emit(dm({text}));
    expect(result.ok).toBeFalse();expect(f.requests).toEqual([]);expect(f.db.query('SELECT * FROM gary_slack_engineering_ingress').all()).toEqual([]);
  }
});

test('standing tool retains unknown admission and refuses wake after failed delivery, cancellation or cleanup',async()=>{
  for(const failure of ['admission','delivery','cleanup','cancel'] as const) {
    let wakes=0,ready=true,retained:unknown;const abort=new AbortController();
    let f:ReturnType<typeof engineeringFixture>;
    f=engineeringFixture({standingEngineeringEnabled:true,conversation:{ready:()=>ready,close:()=>({drained:true}),async respond(input,deliver,signal){
      retained=input.engineering;
      if(failure==='cancel')abort.abort();
      try{await submitConversationEngineering(input.engineering,ordinaryAudience(input),'707-Labs/new-app',failure==='cancel'?abort.signal:signal,()=>{});}catch{/* Cancellation prevents submission. */}
      if(failure==='cleanup'){ready=false;return;}
      await deliver('Recorded result.');
    }}},async request=>{if(failure==='admission')throw Error('unknown_admission');return f.issue(request);});
    f.ingress.start=()=>{wakes++;};await f.service.start();
    if(failure==='delivery')f.fake.send=async()=>({ok:false,outcome:'unknown',code:'fixture'});
    await f.fake.emit(dm({text:'Fix 707-Labs/new-app'}));expect(wakes).toBe(0);
    if(failure==='cancel')expect(f.requests).toEqual([]);
    else expect(f.requests).toHaveLength(1);
    const state=f.db.query('SELECT state FROM gary_slack_engineering_ingress').get();
    expect(state).toEqual(failure==='cancel'?null:{state:failure==='admission'?'unknown':'bound'});
    // A later verified admission callback must not wake a task fenced after cleanup/delivery failure.
    if(failure==='cleanup'||failure==='delivery')await f.service.deliverEngineeringReceipt(f.issue(f.requests[0]!));
    expect(wakes).toBe(0);
    expect((await submitConversationEngineering(retained,ordinaryAudience({channel:'D0FIXTURE1',threadTs:'1791417600.000002'}),'707-Labs/new-app',new AbortController().signal,()=>{})).ok).toBeFalse();
  }
});

test('absent standing flag preserves legacy ordinary DM and foreign ingress never obtains a capability',async()=>{
  let seen:any,calls=0;
  const legacy=engineeringFixture({conversation:{ready:()=>true,close:()=>({drained:true}),async respond(input,deliver){seen=input;await deliver('ordinary reply');}}});
  await legacy.service.start();await legacy.fake.emit(dm({text:'Fix 707-Labs/new-app'}));expect(seen.engineering).toBeUndefined();expect(legacy.requests).toEqual([]);
  const f=engineeringFixture({standingEngineeringEnabled:true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(){calls++;}}});await f.service.start();
  for(const event of [{user:GARY_SLACK.benId},{channel:'D0FOREIGN'},{channel_type:'mpim'},{bot_id:'B0BOT123'},{subtype:'message_changed'},{team:'T0FOREIGN'}])await f.fake.emit(dm({text:'Fix 707-Labs/new-app',...event}));
  for(const payload of [{team_id:'T0FOREIGN'},{api_app_id:'A0FOREIGN'},{context_team_id:'T0FOREIGN'},{is_ext_shared_channel:true}])await f.fake.emit(dm({text:'Fix 707-Labs/new-app'},payload));
  expect(calls).toBe(0);expect(f.requests).toEqual([]);
});

test('standing admission snapshots authenticated envelope before asynchronous health and receipt callbacks cannot wake early',async()=>{
  let checking=false,entered!:()=>void,release!:()=>void,wakes=0;
  const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const original='Fix the test failure in 707-Labs/new-app';
  let f:ReturnType<typeof engineeringFixture>;
  f=engineeringFixture({standingEngineeringEnabled:true,checkHostHealth:async()=>{if(checking){entered();await gate;}return healthy;},
    conversation:{ready:()=>true,close:()=>({drained:true}),async respond(input,deliver,signal){
      expect(input.text).toBe(original);expect(input.channel).toBe('D0FIXTURE1');expect(input.eventId).toBe('EvFixture1');
      expect((await submitConversationEngineering(input.engineering,ordinaryAudience(input),'707-Labs/new-app',signal,()=>{})).ok).toBeTrue();
      expect(wakes).toBe(0);expect(f.fake.sends).toHaveLength(1);await deliver('Queued.');input.onEngineeringOutcome?.('reply_committed');
    }}},async request=>{const receipt=f.issue(request);await f.service.deliverEngineeringReceipt(receipt);expect(wakes).toBe(0);return receipt;});
  f.ingress.start=()=>{wakes++;};await f.service.start();checking=true;
  const envelope=dm({text:original}),running=f.fake.emit(envelope);await waiting;
  Object.assign(envelope.payload.event,{text:'Fix 707-Labs/other',channel:'D0FOREIGN',user:GARY_SLACK.benId});envelope.payload.event_id='EvChanged';
  release();await running;expect(wakes).toBe(1);expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.task).toBe(original);expect(f.requests[0]!.authority.requesterId).toBe(GARY_SLACK.tannerId);
  expect(f.fake.sends.at(-1)!.channel).toBe('D0FIXTURE1');
});

test('real conversation committed answer permits wake; swallowed clean error notice cancels pending; unknown cleanup stays fenced',async()=>{
  for(const result of ['answer','clean_error','unknown_cleanup'] as const) {
    const dir=realpathSync(mkdtempSync(join(tmpdir(),'gary-standing-conversation-')));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
    const config={version:1 as const,runId:'standing-conversation',campaignId:'standing-conversation',allocationId:'local:standing-conversation',contextDirectory:dir};
    const ledger=new SpendLedger(':memory:');cleanups.push(()=>ledger.close());ledger.createCampaign(config.campaignId,5);ledger.enrollTicket(config.campaignId,config.allocationId,5);
    let wakes=0,cancels=0;
    const conversation=createSlackConversation({config,ledger,reply:async turn=>{
      expect((await submitConversationEngineering(turn.engineering,turn.authority!,'707-Labs/new-app',turn.signal,turn.assertActive)).ok).toBeTrue();
      if(result!=='answer')throw new DMReplyError('dm_reply_rejected',result==='clean_error');
      return 'Engineering task is queued.';
    }});cleanups.push(()=>{conversation.close();});
    const f=engineeringFixture({standingEngineeringEnabled:true,conversation});
    f.ingress.start=()=>{wakes++;};f.ingress.cancelPending=receipt=>{expect(receipt.taskId).toBe('engineering-offline-fixture');cancels++;};
    await f.service.start();await f.fake.emit(dm({text:'Fix 707-Labs/new-app'}));
    expect(f.requests).toHaveLength(1);expect(wakes).toBe(result==='answer'?1:0);expect(cancels).toBe(result==='clean_error'?1:0);
    const context=new Database(join(dir,'context.sqlite'),{readonly:true});
    expect(context.query('SELECT state,cleanup FROM events').get()).toEqual({state:result==='answer'?'sent':'failed',cleanup:result==='unknown_cleanup'?0:1});context.close();
    if(result!=='answer')expect(f.fake.sends.at(-1)!.text).toContain('worker has not started');
    if(result==='clean_error')expect(conversation.ready()).toBeTrue(); // Global readiness cannot distinguish this failed turn.
    await f.service.deliverEngineeringReceipt(f.issue(f.requests[0]!));expect(wakes).toBe(result==='answer'?1:0);
  }
});

test('engineering claims the authenticated message before admission, dedupes events/messages, and skips chat budget',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  let f:ReturnType<typeof engineeringFixture>;f=engineeringFixture({},async request=>{entered();await gate;return f.issue(request);});
  await f.service.start();const first=f.fake.emit(engineeringMessage({thread_ts:'1791417500.000001'}));await started;
  await Promise.all([f.fake.emit(engineeringMessage({thread_ts:'1791417500.000001'})),
    f.fake.emit(engineeringMessage({thread_ts:'1791417500.000001'},{event_id:'EvRedelivered'})),
    f.fake.emit(engineeringMessage({ts:'1791417600.000003',text:'!engineer 707-Labs/other conflicting message'}))]);
  expect(f.requests).toHaveLength(1);expect(f.chats).toBe(0);expect(f.fake.sends).toHaveLength(1);
  const request=f.requests[0]!;expect(request).toMatchObject({eventId:'EvFixture1',repository:'707-Labs/gary',task:'fix the fixture\nRun the offline checks.',
    authority:{authenticated:true,requesterId:GARY_SLACK.tannerId,teamId:GARY_SLACK.teamId,surface:'private_dm',channelId:'D0FIXTURE1',threadTs:'1791417500.000001'}});
  expect(Object.isFrozen(request)).toBe(true);expect(Object.isFrozen(request.authority)).toBe(true);
  expect(request.requestId).toBe('slack-engineering-'+createHash('sha256').update(request.messageKey).digest('hex'));
  expect(f.db.query('SELECT state,task_id FROM gary_slack_engineering_ingress').get()).toEqual({state:'pending',task_id:null});
  expect(JSON.stringify(f.db.query('SELECT * FROM gary_slack_engineering_ingress').all())).not.toContain('fix the fixture');
  release();await first;expect(f.fake.sends[1]).toEqual({channel:'D0FIXTURE1',threadTs:'1791417500.000001',text:'Engineering request accepted.'});
  expect(f.db.query('SELECT state,task_id FROM gary_slack_engineering_ingress').get()).toEqual({state:'bound',task_id:'engineering-offline-fixture'});
  const final=f.issue(request,'final');expect(await f.service.deliverEngineeringReceipt(final)).toBe('sent');
  expect(f.fake.sends[2]?.threadTs).toBe('1791417500.000001');expect(f.chats).toBe(0);
  expect(f.db.query('SELECT status FROM gary_slack_dm_outbox ORDER BY rowid').all()).toEqual([{status:'sent'},{status:'sent'}]);
});

test('engineering rejects nonowner/nonprivate/foreign/slash envelopes before admission or chat',async()=>{
  const f=engineeringFixture();await f.service.start();
  for(const event of [{user:GARY_SLACK.benId},{channel:'D0FOREIGN'},{channel:'C0APPROVED'},{channel_type:'mpim'},{bot_id:'B0BOT123'},{subtype:'message_changed'},
    {team:'T0FOREIGN'},{ts:'invalid'},{thread_ts:'invalid'},{type:'app_mention'}])await f.fake.emit(engineeringMessage(event));
  for(const payload of [{team_id:'T0FOREIGN'},{api_app_id:'A0FOREIGN'},{context_team_id:'T0FOREIGN'},{is_ext_shared_channel:true}])await f.fake.emit(engineeringMessage({},payload));
  await f.fake.emit({type:'slash_commands',payload:{...engineeringMessage().payload,command:'/engineer'}});
  expect(f.requests).toEqual([]);expect(f.chats).toBe(0);expect(f.fake.sends).toHaveLength(1);
  expect(f.db.query('SELECT * FROM gary_slack_engineering_ingress').all()).toEqual([]);
});

test('malformed, disabled, and unavailable explicit engineering commands never fall through into a paid chat',async()=>{
  const f=engineeringFixture();await f.service.start();let index=0;
  for(const text of ['!engineer','!engineer other-org/repo task','!engineer 707-Labs/gary','!engineer 707-Labs/gary bad\0task','!engineer 707-Labs/gary '+ 'x'.repeat(16_001)]) {
    index++;await f.fake.emit(engineeringMessage({text,ts:'1791417600.'+String(index).padStart(6,'0')},{event_id:'EvMalformed'+index}));
  }
  expect(f.requests).toHaveLength(0);expect(f.chats).toBe(0);expect(f.fake.sends.slice(1).every(s=>s.text.startsWith('Use !engineer'))).toBe(true);
  f.enabled=false;await f.fake.emit(engineeringMessage({ts:'1791417600.000009'},{event_id:'EvUnavailable'}));
  expect(f.requests).toHaveLength(0);expect(f.fake.sends.at(-1)?.text).toContain('unavailable');
  let chats=0;const disabled=fixture({tannerDirectMessages:true,checkConversationHealth:()=>true,conversation:{ready:()=>true,close:()=>({drained:true}),async respond(){chats++;}}});
  await disabled.service.start();await disabled.fake.emit(engineeringMessage());expect(chats).toBe(0);expect(disabled.fake.sends.at(-1)?.text).toContain('unavailable');
  expect(disabled.db.query("SELECT name FROM sqlite_master WHERE name='gary_slack_engineering_ingress'").all()).toEqual([]);
});

test('bounded admission rejection needs no fabricated task and preserves the dedupe fence',async()=>{
  const f=engineeringFixture({},async()=>({kind:'rejected',code:'budget_unavailable'}));await f.service.start();await f.fake.emit(engineeringMessage());
  expect(f.db.query('SELECT state,task_id FROM gary_slack_engineering_ingress').get()).toEqual({state:'rejected',task_id:null});
  expect(f.fake.sends.at(-1)?.text).toContain('approved budget is unavailable');expect(f.chats).toBe(0);
  await f.fake.emit(engineeringMessage({},{event_id:'EvAnotherEvent'}));expect(f.requests).toHaveLength(1);
});

test('unknown admission survives restart and unverified or cross-request receipts never gain delivery authority',async()=>{
  for(const failure of ['throws','unverified','cross_request'] as const){
    let f:ReturnType<typeof engineeringFixture>;f=engineeringFixture({},async request=>{
      if(failure==='throws')throw new Error('offline admission outcome uncertain');
      const receipt=f.issue(request);if(failure==='unverified')f.receipts.clear();
      return failure==='cross_request'?{...receipt,requestId:'slack-engineering-'+'a'.repeat(64)}:receipt;
    });await f.service.start();await f.fake.emit(engineeringMessage());
    expect(f.db.query('SELECT state,task_id FROM gary_slack_engineering_ingress').get()).toEqual({state:'unknown',task_id:null});
    expect(f.fake.sends.at(-1)?.text).toContain("couldn't confirm");const final=f.issue(f.requests[0]!,'final');
    expect(await f.service.deliverEngineeringReceipt(final)).toBe('not_sent');await f.service.stop();
    const restarted=engineeringFixture({db:f.db});await restarted.service.start();await restarted.fake.emit(engineeringMessage({},{event_id:'EvAfterRestart'}));
    expect(restarted.requests).toEqual([]);expect(restarted.fake.sends).toEqual([]);
  }
});

test('unknown acknowledgement does not block verified final; identical receipts dedupe and changed receipts never send',async()=>{
  const f=engineeringFixture();await f.service.start();f.fake.send=async()=>({ok:false,outcome:'unknown',code:'offline_timeout'});
  await f.fake.emit(engineeringMessage());expect(f.db.query('SELECT state FROM gary_slack_engineering_ingress').get()).toEqual({state:'bound'});
  const request=f.requests[0]!,ack=f.issue(request);expect(await f.service.deliverEngineeringReceipt(ack)).toBe('unknown');expect(f.fake.sends).toHaveLength(2);
  f.fake.send=async args=>({ok:true,channel:args.channel,ts:'1791417600.000010'});
  const final=f.issue(request,'final');expect(await f.service.deliverEngineeringReceipt(final)).toBe('sent');expect(await f.service.deliverEngineeringReceipt(final)).toBe('sent');
  const changed=f.issue(request,'final',{text:'different final body'});expect(await f.service.deliverEngineeringReceipt(changed)).toBe('unknown');
  expect(await f.service.deliverEngineeringReceipt({...final,taskId:'engineering-foreign'})).toBe('not_sent');
  expect(await f.service.deliverEngineeringReceipt({...final,requestId:'slack-engineering-'+'c'.repeat(64)})).toBe('not_sent');
  expect(f.fake.sends).toHaveLength(3);expect(f.db.query('SELECT status FROM gary_slack_dm_outbox ORDER BY rowid').all()).toEqual([{status:'unknown'},{status:'sent'}]);
});

test('final cannot precede durable admission and delivery serialization keeps acknowledgement before final',async()=>{
  let f:ReturnType<typeof engineeringFixture>;f=engineeringFixture({},async request=>{
    expect(await f.service.deliverEngineeringReceipt(f.issue(request,'final'))).toBe('not_sent');return f.issue(request);
  });await f.service.start();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  f.fake.send=async args=>{if(args.text==='Engineering request accepted.'){entered();await gate;}return{ok:true,channel:args.channel,ts:'1791417600.000011'};};
  const incoming=f.fake.emit(engineeringMessage());await started;const final=f.service.deliverEngineeringReceipt(f.issue(f.requests[0]!,'final'));
  await Promise.resolve();expect(f.fake.sends).toHaveLength(2);release();await incoming;expect(await final).toBe('sent');
  expect(f.fake.sends.slice(1).map(s=>s.text)).toEqual(['Engineering request accepted.','Engineering task completed.']);
});

test('runner wakes once only after verified durable binding and may immediately queue final delivery',async()=>{
  const f=engineeringFixture();let starts=0,final:Promise<string>|undefined;
  f.ingress.start=receipt=>{
    starts++;expect(f.db.query('SELECT state,task_id FROM gary_slack_engineering_ingress').get()).toEqual({state:'bound',task_id:receipt.taskId});
    expect(f.fake.sends).toHaveLength(1);final=f.service.deliverEngineeringReceipt(f.issue(f.requests[0]!,'final'));
  };
  await f.service.start();await f.fake.emit(engineeringMessage());expect(await final).toBe('sent');
  expect(f.fake.sends.slice(1).map(s=>s.text)).toEqual(['Engineering request accepted.','Engineering task completed.']);
  expect(await f.service.deliverEngineeringReceipt(f.issue(f.requests[0]!))).toBe('sent');expect(starts).toBe(1);
  await f.fake.emit(engineeringMessage({},{event_id:'EvDuplicateWake'}));expect(starts).toBe(1);
});

test('engineering verification cannot lend authority after runtime revocation or move receipt delivery to another destination',async()=>{
  const f=engineeringFixture();await f.service.start();await f.fake.emit(engineeringMessage());const final=f.issue(f.requests[0]!,'final');
  expect(await f.service.deliverEngineeringReceipt({...final,channel:'D0FOREIGN'} as EngineeringReceipt)).toBe('not_sent');
  f.ingress.verifyReceipt=async()=>{f.enabled=false;return true;};
  expect(await f.service.deliverEngineeringReceipt(final)).toBe('not_sent');expect(f.fake.sends).toHaveLength(2);
  expect(f.db.query('SELECT final_sha256 FROM gary_slack_engineering_ingress').get()).toEqual({final_sha256:null});
});

test('engineering rechecks authority before each physical send and stop drains retained final delivery callbacks',async()=>{
  const f=engineeringFixture();await f.service.start();await f.fake.emit(engineeringMessage());const request=f.requests[0]!;
  const final=f.issue(request,'final',{text:'& fixture '.repeat(3000)});expect(renderSlackReplyParts(final.text).length).toBeGreaterThan(1);
  f.fake.send=async args=>{f.enabled=false;return{ok:true,channel:args.channel,ts:'1791417600.000012'};};
  expect(await f.service.deliverEngineeringReceipt(final)).toBe('unknown');expect(f.fake.sends).toHaveLength(3);
  expect(f.db.query("SELECT status,error_code FROM gary_slack_dm_outbox WHERE delivery_key LIKE '%:final'").get()).toEqual({status:'unknown',error_code:'engineering_authority_unavailable'});
  const g=engineeringFixture();await g.service.start();await g.fake.emit(engineeringMessage());let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  g.fake.send=async args=>{entered();await gate;return{ok:true,channel:args.channel,ts:'1791417600.000013'};};
  const gFinal=g.issue(g.requests[0]!,'final'),sending=g.service.deliverEngineeringReceipt(gFinal);await started;
  let stopped=false;const stopping=g.service.stop().then(()=>stopped=true);await Promise.resolve();expect(stopped).toBe(false);
  release();await Promise.all([sending,stopping]);expect(stopped).toBe(true);g.db.close();
  expect(await g.service.deliverEngineeringReceipt(gFinal)).toBe('not_sent');
});

test('engineering injection requires explicit owner DM and separate trusted runtime health before schema changes',()=>{
  const f=fixture();const engineeringIngress:EngineeringIngress={async admit(){return{kind:'rejected',code:'unavailable'};},verifyReceipt:()=>false};
  for(const extra of [{},{tannerDirectMessages:true as const},{tannerDirectMessages:true as const,checkConversationHealth:()=>true},
    {tannerDirectMessages:true as const,checkConversationHealth:()=>true,checkEngineeringHealth:()=>true,approvedChannelIds:['C0APPROVED']}])
    expect(()=>createSlackService({db:f.db,transport:f.fake.transport,checkHostHealth:()=>healthy,engineeringIngress,...extra})).toThrow('engineering_ingress_boundary_rejected');
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name='gary_slack_engineering_ingress'").all()).toEqual([]);
});

test('ordinary chat admission pauses independently while engineering ack and final remain deliverable',async()=>{
  let allowChat=false;
  const f=engineeringFixture({checkConversationAdmission:()=>allowChat});await f.service.start();
  await f.fake.emit(dm({text:'Ordinary question'}, {event_id:'EvChatBefore'}));expect(f.chats).toBe(0);
  await f.fake.emit(engineeringMessage());expect(f.requests).toHaveLength(1);expect(f.fake.sends).toHaveLength(2);
  expect(await f.service.deliverEngineeringReceipt(f.issue(f.requests[0]!,'final'))).toBe('sent');
  allowChat=true;await f.fake.emit(dm({text:'Another question',ts:'1791417600.000004'},{event_id:'EvChatAfter'}));expect(f.chats).toBe(1);
});

test('engineering status reads only exact bound private thread, remains available while busy and dedupes',async()=>{
  const f=engineeringFixture({checkConversationAdmission:()=>false});await f.service.start();
  const thread='1791417600.000001';await f.fake.emit(engineeringMessage({ts:thread}));const request=f.requests[0]!;
  const status=engineeringMessage({text:'!engineer status',ts:'1791417600.000002',thread_ts:thread},{event_id:'EvStatus1'});
  const before=f.fake.sends.length;await f.fake.emit(status);await f.fake.emit(status);
  expect(f.fake.sends).toHaveLength(before+1);expect(f.fake.sends.at(-1)?.text).toContain('Recorded engineering status: queued.');
  expect(f.fake.sends.at(-1)?.text).toContain('does not confirm current worker activity');
  expect(f.requests).toHaveLength(1);expect(f.chats).toBe(0);
  f.issue(request,'final',{status:'cleanup_unknown'});
  await f.fake.emit(engineeringMessage({text:'!engineer status',ts:'1791417600.000003',thread_ts:thread},{event_id:'EvStatus2'}));
  expect(f.fake.sends.at(-1)?.text).toContain('Recorded engineering status: cleanup_unknown.');
  await f.fake.emit(engineeringMessage({text:'!engineer status',ts:'1791417600.000004'},{event_id:'EvStatusOtherThread'}));
  expect(f.fake.sends.at(-1)?.text).toBe('No engineering task is recorded for this DM thread.');
  const count=f.fake.sends.length;
  await f.fake.emit(engineeringMessage({text:'!engineer status',user:GARY_SLACK.benId,ts:'1791417600.000005',thread_ts:thread},{event_id:'EvStatusOtherUser'}));
  await f.fake.emit(engineeringMessage({text:'!engineer status',channel:'D0OTHER999',ts:'1791417600.000006',thread_ts:thread},{event_id:'EvStatusOtherDm'}));
  expect(f.fake.sends).toHaveLength(count);expect(f.requests).toHaveLength(1);expect(f.chats).toBe(0);
});

test('engineering status rejects forged, cross-task and changed binding receipts without exposing text',async()=>{
  for(const mode of ['forged','cross_task','binding_changed'] as const){
    const f=engineeringFixture();await f.service.start();await f.fake.emit(engineeringMessage({ts:'1791417600.000001'}));
    const receipt=f.issue(f.requests[0]!,'final');
    f.ingress.readReceipt=()=>{
      if(mode==='binding_changed')f.db.query("UPDATE gary_slack_engineering_ingress SET thread_ts='1791417000.000001'").run();
      return{...receipt,...(mode==='cross_task'?{taskId:'foreign-task'}:{}),...(mode==='forged'?{text:'secret unverified details'}:{})};
    };
    await f.fake.emit(engineeringMessage({text:'!engineer status',ts:'1791417600.000009',thread_ts:'1791417600.000001'},{event_id:'EvStatusInvalid'}));
    expect(f.fake.sends.at(-1)?.text).toBe('The engineering status record could not be verified.');
    expect(f.fake.sends.at(-1)?.text).not.toContain('secret');expect(f.requests).toHaveLength(1);expect(f.chats).toBe(0);
  }
});
