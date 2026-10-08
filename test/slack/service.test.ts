import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackService, GARY_SLACK, READY_DM_TEXT, type SlackHostHealth, type SlackService, type SlackServiceOptions } from '../../src/slack/service.ts';
import type { SlackTransport } from '../../src/slack/transport.ts';

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
type SendArgs=Parameters<SlackTransport['sendMessage']>[0];
const healthy:SlackHostHealth={ready:true,hermesCanarySucceeded:true,receiptId:'canary-action-123:deployment-456'};
function fakeTransport() {
  const sends:SendArgs[]=[];let callback:((event:unknown)=>void|Promise<void>)|undefined;
  let connected=false,starts=0,stops=0;
  const identity={appId:GARY_SLACK.appId as string,teamId:GARY_SLACK.teamId as string,botUserId:GARY_SLACK.botUserId as string};
  let send:SlackTransport['sendMessage']=async args=>({ok:true,channel:args.channel.startsWith('U')?'D0FIXTURE1':args.channel,ts:'1791417600.000001'});
  const transport:SlackTransport={
    async identity(){return {...identity};},socketHealthy(){return connected;},
    async sendMessage(args,signal){sends.push({...args});return send(args,signal);},
    async start(handler){starts++;callback=handler;connected=true;},async stop(){stops++;connected=false;},
  };
  return {transport,sends,identity,emit:(event:unknown)=>Promise.resolve(callback?.(event)),
    set connected(value:boolean){connected=value;},set send(value:SlackTransport['sendMessage']){send=value;},
    get starts(){return starts;},get stops(){return stops;}};
}
function fixture(extra:Partial<SlackServiceOptions>={}) {
  const db=extra.db??new Database(':memory:',{strict:true});if(!extra.db)cleanups.push(()=>db.close());
  const fake=fakeTransport();let health={...healthy},healthCalls=0;
  const service=createSlackService({db,transport:fake.transport,checkHostHealth:async()=>{healthCalls++;return {...health};},...extra});
  cleanups.push(()=>service.stop().catch(()=>{}));
  return {db,fake,service,set health(value:SlackHostHealth){health=value;},get healthCalls(){return healthCalls;}};
}
function envelope(overrides:Record<string,unknown>={},payloadOverrides:Record<string,unknown>={}) {
  return {type:'events_api',envelope_id:'socket-envelope-1',payload:{type:'event_callback',team_id:GARY_SLACK.teamId,api_app_id:GARY_SLACK.appId,
    event_id:'EvFixture1',event:{type:'app_mention',user:GARY_SLACK.tannerId,channel:'C0APPROVED',ts:'1791417600.000002',text:`<@${GARY_SLACK.botUserId}> status`,...overrides},...payloadOverrides}};
}
function rows(db:Database):any[]{return db.query('SELECT * FROM gary_slack_outbox ORDER BY rowid').all();}

test('construction validates policy without schema mutation, socket startup or sends',()=>{
  const f=fixture();expect(f.db.query("SELECT name FROM sqlite_master WHERE name='gary_slack_outbox'").all()).toEqual([]);
  expect(f.fake.starts).toBe(0);expect(f.fake.sends).toEqual([]);expect(f.service.health.readyDelivery).toBe('none');
  for(const policy of [{approvedChannelIds:['D0PRIVATE']},{approvedChannelIds:['C0APPROVED','C0APPROVED']},{allowedUserIds:['U0STRANGER']}]) {
    expect(()=>createSlackService({db:f.db,transport:f.fake.transport,checkHostHealth:()=>healthy,...policy})).toThrow('allowlist');
  }
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
