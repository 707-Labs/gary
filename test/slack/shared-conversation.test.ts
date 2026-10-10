import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackSharedConversation, loadSlackSharedConversationConfig, fingerprintSlackSharedConversationConfig,
  SHARED_CONVERSATION_POLICY as POLICY, type SlackSharedConversationInput, type SlackSharedMetadata } from '../../src/slack/shared-conversation.ts';
import { DMReplyError, type DMTurn } from '../../src/hermes/dm-conversation.ts';
import { SpendLedger } from '../../src/spend.ts';
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();});
const signal=new AbortController().signal;
const sent=async()=> 'sent' as const;
function fixture(){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'gary-shared-context-')));chmodSync(dir,0o700);cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'shared.json'),raw={version:1,runId:'hermes-shared-20261008',campaignId:'hermes-shared-20261008',allocationId:'local:hermes-shared-20261008',
    appId:POLICY.appId,teamId:POLICY.teamId,botUserId:POLICY.botUserId,trigger:'explicit_mention'};
  writeFileSync(path,JSON.stringify(raw),{mode:0o600});
  const config=loadSlackSharedConversationConfig(path),ledger=new SpendLedger(':memory:');cleanups.push(()=>ledger.close());
  ledger.createCampaign(config.campaignId,5);ledger.enrollTicket(config.campaignId,config.allocationId,5);
  const metadata:SlackSharedMetadata={memberInfo:async id=>({id,teamId:POLICY.teamId,deleted:false,isBot:false,isAppUser:false,isRestricted:false,isUltraRestricted:false,isStranger:false,observedAt:Date.now()}),
    channelInfo:async id=>({id,teamId:POLICY.teamId,isMember:true,isArchived:false,isPrivate:false,isShared:false,isExtShared:false,isOrgShared:false,isPendingExtShared:false,observedAt:Date.now()})};
  return{dir,path,raw,config,ledger,metadata};
}
const mention=(n:number,overrides:Partial<SlackSharedConversationInput>={}):SlackSharedConversationInput=>({type:'app_mention',appId:POLICY.appId,teamId:POLICY.teamId,botUserId:POLICY.botUserId,
  requesterId:'U0MEMBER11',eventId:'EvShared'+n,channel:'C0CHANNEL1',ts:'1791417600.'+String(n).padStart(6,'0'),threadTs:'1791417600.'+String(n).padStart(6,'0'),text:`<@${POLICY.botUserId}> fabricated channel phrase`,...overrides});
test('strict config binds exact workspace/app/bot/trigger and private file independently of DM config',()=>{
  const f=fixture();expect(fingerprintSlackSharedConversationConfig(f.config)).toMatch(/^[a-f0-9]{64}$/);
  for(const value of [{...f.raw,teamId:'TFOREIGN'},{...f.raw,trigger:'ambient'},{...f.raw,dmContext:'/private/dm'}, {...f.raw,allocationId:'local:hermes-dm-20261008-tanner'}]){
    writeFileSync(f.path,JSON.stringify(value));expect(()=>loadSlackSharedConversationConfig(f.path)).toThrow();
  }
  writeFileSync(f.path,JSON.stringify(f.raw));chmodSync(f.path,0o644);expect(()=>loadSlackSharedConversationConfig(f.path)).toThrow('private_path');
});
test('context is scoped to app/team/channel/thread, sender IDs remain data, and private DM storage is never read',async()=>{
  const f=fixture(),turns:DMTurn[]=[];writeFileSync(join(f.dir,'context.sqlite'),'private DM secret must never be parsed',{mode:0o600});
  const shared=createSlackSharedConversation({...f,reply:async turn=>{turns.push(turn);return 'shared reply';}});
  await shared.respond(mention(1),sent,signal);
  await shared.respond(mention(2,{threadTs:mention(1).ts,requesterId:'U0MEMBER22'}),sent,signal);
  await shared.respond(mention(1,{eventId:'EvOtherChannel',channel:'C0CHANNEL2'}),sent,signal);
  await shared.respond(mention(3),sent,signal);
  expect(turns).toHaveLength(4);expect(JSON.parse(turns[0]!.text)).toEqual({senderId:'U0MEMBER11',text:mention(1).text});
  expect(JSON.parse(turns[1]!.text).senderId).toBe('U0MEMBER22');expect(turns[1]!.history).toHaveLength(2);
  expect(turns[2]!.history).toEqual([]);expect(turns[3]!.history).toEqual([]);expect(JSON.stringify(turns)).not.toContain('private DM secret');
  expect(shared.close()).toEqual({drained:true});expect(statSync(join(f.dir,'shared-context.sqlite')).mode&0o777).toBe(0o600);
  const db=new Database(join(f.dir,'shared-context.sqlite'));expect((db.query('SELECT requester_id FROM events ORDER BY rowid').all() as any[]).map(x=>x.requester_id)).toEqual(['U0MEMBER11','U0MEMBER22','U0MEMBER11','U0MEMBER11']);db.close();
});
test('guest, deactivated, app/bot, foreign-team, stranger and missing/stale metadata reject before claim/provider',async()=>{
  for(const bad of [{isRestricted:true},{isUltraRestricted:true},{deleted:true},{isBot:true},{isAppUser:true},{teamId:'TFOREIGN'},{isStranger:true},{isRestricted:undefined},{observedAt:0},{observedAt:Date.now()+60000}]){
    const f=fixture(),original=f.metadata.memberInfo;f.metadata.memberInfo=async id=>({...await original(id),...bad} as any);let calls=0;
    const shared=createSlackSharedConversation({...f,reply:async()=>{calls++;return 'forbidden';}});await shared.respond(mention(1),async()=>{throw new Error('unauthorized send');},signal);shared.close();
    expect(calls).toBe(0);const db=new Database(join(f.dir,'shared-context.sqlite'));expect(db.query('SELECT * FROM events').all()).toEqual([]);db.close();
  }
});
test('Slack Connect, org sharing, pending sharing, foreign context team, nonmember/archive/unknown channels reject before claim',async()=>{
  for(const bad of [{isShared:true},{isExtShared:true},{isOrgShared:true},{isPendingExtShared:true},{teamId:'TFOREIGN'},{isMember:false},{isArchived:true},{isShared:undefined},{observedAt:0}]){
    const f=fixture(),original=f.metadata.channelInfo;f.metadata.channelInfo=async id=>({...await original(id),...bad} as any);let calls=0,sends=0;
    const shared=createSlackSharedConversation({...f,reply:async()=>{calls++;return 'forbidden';}});await shared.respond(mention(1),async()=>{sends++;return 'sent';},signal);shared.close();expect(calls).toBe(0);expect(sends).toBe(0);
    const db=new Database(join(f.dir,'shared-context.sqlite'));expect(db.query('SELECT * FROM events').all()).toEqual([]);db.close();
  }
});
test('only a mention opens a thread; malformed/foreign/DM/bot events and replies outside a joined thread cannot create state',async()=>{
  const f=fixture();let reads=0,calls=0;f.metadata.memberInfo=async()=>{reads++;throw new Error('not called');};
  const shared=createSlackSharedConversation({...f,reply:async()=>{calls++;return 'forbidden';}});
  for(const bad of [{type:'message'},{appId:'AFOREIGN'},{teamId:'TFOREIGN'},{botUserId:'UFOREIGN'},{requesterId:POLICY.botUserId},{channel:'D0PRIVATE1'},{text:'plain followup'},{ts:'invalid'}])await shared.respond(mention(1,bad as any),sent,signal);
  // A thread_reply is never a thread root, never carries a mention, and never finds a session nobody opened.
  for(const bad of [{},{text:'plain followup'},{text:'plain followup',threadTs:'1791400000.000001'}])await shared.respond(mention(1,{type:'thread_reply',...bad}),sent,signal);
  expect(shared.joined('C0CHANNEL1','1791400000.000001')).toBe(false);
  expect(reads).toBe(0);expect(calls).toBe(0);shared.close();
  const db=new Database(join(f.dir,'shared-context.sqlite'));
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:0});expect(db.query('SELECT count(*) AS n FROM notices').get()).toEqual({n:0});db.close();
});
test('plain replies continue a joined thread with history and member checks; limits stay silent for replies and notice only mentions',async()=>{
  const f=fixture(),turns:DMTurn[]=[],notices:string[]=[];let guestReads=0,lookups=0;const member=f.metadata.memberInfo,channel=f.metadata.channelInfo;
  f.metadata.channelInfo=async id=>{lookups++;return channel(id);};
  const deliver=async(text:string,kind?:'answer'|'notice')=>{if(kind==='notice')notices.push(text);return 'sent' as const;};
  const shared=createSlackSharedConversation({...f,reply:async turn=>{turns.push(turn);return 'reply '+turns.length;}});
  const root=mention(1),follow=(n:number,overrides:Partial<SlackSharedConversationInput>={})=>mention(n,{type:'thread_reply',threadTs:root.threadTs,requesterId:'U0MEMBER22',text:'what are you working on now?',...overrides});
  await shared.respond(follow(0),deliver,signal);expect(shared.joined(root.channel,root.threadTs)).toBe(false);expect(turns).toHaveLength(0);
  await shared.respond(root,deliver,signal);expect(shared.joined(root.channel,root.threadTs)).toBe(true);
  await shared.respond(follow(2),deliver,signal);
  expect(turns).toHaveLength(2);expect(turns[1]!.history).toHaveLength(2);expect(JSON.parse(turns[1]!.text)).toEqual({senderId:'U0MEMBER22',text:'what are you working on now?'});
  expect(turns[1]!.authority).toMatchObject({surface:'shared_channel',requesterId:'U0MEMBER22',channelId:root.channel,threadTs:root.threadTs});
  // Replayed message, mention-bearing reply (routed as app_mention), other channel, guest sender: no turn, no notice.
  await shared.respond(follow(2,{eventId:'EvReplay'}),deliver,signal);
  await shared.respond(follow(3,{text:`<@${POLICY.botUserId}> mentioned replies arrive as app_mention`}),deliver,signal);
  await shared.respond(follow(4,{channel:'C0CHANNEL2'}),deliver,signal);
  f.metadata.memberInfo=async id=>{guestReads++;return {...await member(id),isRestricted:true};};await shared.respond(follow(5),deliver,signal);f.metadata.memberInfo=member;
  expect(guestReads).toBe(1);expect(turns).toHaveLength(2);expect(notices).toEqual([]);
  // A paused thread drops replies silently and without a metadata lookup; an explicit mention there still gets the bounded notice.
  await shared.respond(follow(6),async()=> 'unknown',signal);expect(turns).toHaveLength(3);expect(shared.joined(root.channel,root.threadTs)).toBe(false);
  let seen=lookups;await shared.respond(follow(7),deliver,signal);expect(notices).toEqual([]);expect(lookups).toBe(seen);
  await shared.respond(mention(8,{threadTs:root.threadTs}),deliver,signal);expect(notices).toHaveLength(1);expect(turns).toHaveLength(3);expect(lookups).toBe(seen+1);
  const other=mention(9);await shared.respond(other,deliver,signal);expect(turns).toHaveLength(4);expect(shared.joined(other.channel,other.threadTs)).toBe(true);
  // An exhausted allocation is a local fact: every thread stops counting as joined and replies cost nothing.
  f.ledger.markTerminal(f.config.allocationId,'operator_stop');expect(shared.joined(other.channel,other.threadTs)).toBe(false);
  seen=lookups;await shared.respond(follow(10,{threadTs:other.threadTs}),deliver,signal);expect(notices).toHaveLength(1);expect(lookups).toBe(seen);
  await shared.respond(mention(11,{threadTs:other.threadTs}),deliver,signal);expect(notices).toHaveLength(2);expect(turns).toHaveLength(4);expect(lookups).toBe(seen+1);
  shared.close();
});
test('mention in an existing thread starts empty context and durable event/message dedupe survives restart',async()=>{
  const f=fixture(),turns:DMTurn[]=[];const reply=async(turn:DMTurn)=>{turns.push(turn);return 'answer';};let shared=createSlackSharedConversation({...f,reply});
  const first=mention(1,{threadTs:'1791400000.000001'});await shared.respond(first,sent,signal);expect(turns[0]?.history).toEqual([]);shared.close();
  shared=createSlackSharedConversation({...f,reply});await shared.respond(first,sent,signal);await shared.respond({...first,eventId:'EvSameMessage'},sent,signal);
  await shared.respond(mention(2,{threadTs:first.threadTs}),sent,signal);expect(turns).toHaveLength(2);expect(turns[1]?.history).toHaveLength(2);shared.close();
});
test('metadata changes after queueing or inference suppress spend/delivery and never retain unauthorized reply',async()=>{
  for(const when of [2,3]){
    const f=fixture(),original=f.metadata.channelInfo;let checks=0,calls=0,sends=0;
    f.metadata.channelInfo=async id=>({...await original(id),isExtShared:++checks>=when});
    const shared=createSlackSharedConversation({...f,reply:async()=>{calls++;return 'must not be sent';}});
    await shared.respond(mention(1),async()=>{sends++;return 'sent';},signal);expect(calls).toBe(when===2?0:1);expect(sends).toBe(0);shared.close();
    const db=new Database(join(f.dir,'shared-context.sqlite'));expect((db.query('SELECT history FROM sessions').get() as any).history).toBe('[]');db.close();
  }
});
test('trusted composition revocation is checked around awaits and only four admissions can be live',async()=>{
  const f=fixture();let allowed=true,calls=0;const original=f.metadata.channelInfo;
  f.metadata.channelInfo=async id=>{allowed=false;return original(id);};
  const shared=createSlackSharedConversation({...f,reply:async()=>{calls++;return 'forbidden';}});
  await shared.respond(mention(1),sent,signal,()=>allowed);expect(calls).toBe(0);shared.close();
  const g=fixture();let resolve!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>resolve=r),started=new Promise<void>(r=>entered=r);let active=0,max=0;
  const queued=createSlackSharedConversation({...g,reply:async()=>{calls++;max=Math.max(max,++active);entered();await gate;active--;return 'answer';}});
  const jobs=[1,2,3,4,5].map(n=>queued.respond(mention(n),sent,signal));await started;expect(()=>queued.close()).toThrow('not_drained');resolve();await Promise.all(jobs);expect(calls).toBe(4);expect(max).toBe(1);queued.close();
});
test('unknown delivery or native cleanup never replays an event or becomes confirmed thread history',async()=>{
  for(const cleanupUnknown of [false,true]){
    const f=fixture();let calls=0;const reply=async()=>{calls++;if(cleanupUnknown)throw new DMReplyError('dm_native_reply_unconfirmed',false);return 'unconfirmed';};
    let shared=createSlackSharedConversation({...f,reply});await shared.respond(mention(1),async()=> 'unknown',signal);expect(shared.close().drained).toBe(!cleanupUnknown);
    shared=createSlackSharedConversation({...f,reply});await shared.respond(mention(1),sent,signal);expect(calls).toBe(1);expect(shared.ready()).toBe(!cleanupUnknown);shared.close();
    const db=new Database(join(f.dir,'shared-context.sqlite'));expect((db.query('SELECT history FROM sessions').get() as any).history).toBe('[]');db.close();
  }
});
test('exhausted shared allocation sends bounded typed notices with no inference and revoked membership still sends nothing',async()=>{
  const f=fixture();let calls=0;const notices:Array<{text:string;kind?:string}>=[];
  const shared=createSlackSharedConversation({...f,reply:async()=>{calls++;return 'forbidden';}});
  f.ledger.markTerminal(f.config.allocationId,'operator_stop');expect(shared.ready()).toBe(false);
  const deliver=async(text:string,kind?:'answer'|'notice')=>{notices.push({text,...(kind?{kind}:{})});return 'sent' as const;};
  await shared.respond(mention(1),deliver,signal);await shared.respond(mention(1),deliver,signal);await shared.respond(mention(1,{eventId:'EvNoticeAlias'}),deliver,signal);
  expect(notices).toHaveLength(1);expect(notices[0]?.kind).toBe('notice');expect(notices[0]?.text).toContain('No model call');expect(calls).toBe(0);
  const original=f.metadata.memberInfo;f.metadata.memberInfo=async id=>({...await original(id),deleted:true});await shared.respond(mention(2),deliver,signal);
  expect(notices).toHaveLength(1);expect(calls).toBe(0);shared.close();
});

test('labeled mentions reach the same durable shared admission; diagnostics cannot change authorization',async()=>{
  const f=fixture(),records:any[]=[];let calls=0;
  const shared=createSlackSharedConversation({...f,onIngressDiagnostic:record=>{records.push(record);throw new Error('untrusted observer failure');},reply:async()=>{calls++;return 'safe fixture reply';}});
  const first=mention(1,{text:`<@${POLICY.botUserId}|Gary> synthetic-only-secret`});
  await shared.respond(first,sent,signal);await shared.respond({...first,eventId:'EvAlias'},sent,signal);
  expect(calls).toBe(1);expect(records.filter(r=>r.stage==='shared_claimed')).toHaveLength(1);expect(records.at(-1).stage).toBe('shared_duplicate');
  for(const text of [`<@${POLICY.botUserId}X>`,`<@U0OTHER11|${POLICY.botUserId}>`,`<<@${POLICY.botUserId}>>`])await shared.respond(mention(2,{text}),sent,signal);
  expect(calls).toBe(1);expect(records.at(-1).stage).toBe('shared_input_rejected');
  expect(JSON.stringify(records)).not.toContain('synthetic-only-secret');expect(shared.close()).toEqual({drained:true});
});
test('metadata lookup failures and policy denials have fixed diagnostics and no claim or provider call',async()=>{
  for(const reason of ['member_lookup','channel_lookup','member_policy','channel_policy']){
    const f=fixture(),records:any[]=[];let calls=0;
    const member=f.metadata.memberInfo,channel=f.metadata.channelInfo;
    if(reason==='member_lookup')f.metadata.memberInfo=async()=>{throw new Error('xoxb-private-raw-error');};
    if(reason==='channel_lookup')f.metadata.channelInfo=async()=>{throw new Error('xoxb-private-raw-error');};
    if(reason==='member_policy')f.metadata.memberInfo=async id=>({...await member(id),isRestricted:true});
    if(reason==='channel_policy')f.metadata.channelInfo=async id=>({...await channel(id),isExtShared:true});
    const shared=createSlackSharedConversation({...f,onIngressDiagnostic:record=>{records.push(record);},reply:async()=>{calls++;return 'never';}});
    await shared.respond(mention(1),async()=>{throw new Error('must not send');},signal);
    expect(calls).toBe(0);
    expect(records.some(r=>r.stage===({member_lookup:'shared_member_lookup_failed',channel_lookup:'shared_channel_lookup_failed',member_policy:'shared_member_rejected',channel_policy:'shared_channel_rejected'}[reason]))).toBe(true);
    expect(JSON.stringify(records)).not.toContain('xoxb-private-raw-error');shared.close();
    const db=new Database(join(f.dir,'shared-context.sqlite'));expect(db.query('SELECT count(*) AS n FROM events').get()).toEqual({n:0});db.close();
  }
});
