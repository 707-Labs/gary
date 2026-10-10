/** Host Slack service; optional tightly scoped Tanner DM conversation, no coding dispatch. */
import { createHash, randomUUID } from 'node:crypto';
import { hasSlackUserMention } from './mentions.ts';
import { createSlackIngressEmitter, slackEnvelopeShape, type SlackIngressObserver } from './ingress-diagnostics.ts';
import type { DB } from '../state/db.ts';
import type { SlackTransport, SlackFrameInfo } from './transport.ts';
import type { SlackConversation } from './conversation.ts';
import type { SlackSharedConversation, DMDelivery } from './shared-conversation.ts';
import type { SlackAlertIntake } from './alert-intake.ts';

export const GARY_SLACK = Object.freeze({ appId:'A0C7QFW3PEG', teamId:'T0AA24R7VUZ', botUserId:'U0C7NPEUG1F',
  tannerId:'U0A9M5W16F8', benId:'U0A97PBGXE3', readyRequest:'Sentinel_ecc85c3dae948191965308b6414c1165' });
export const READY_DM_TEXT = "i'm gary. the Hermes runtime is up and running, and its readiness canary passed. coding work still goes through the approved Linear flow.";
export const READONLY_READY_DM_TEXT = "i'm gary. the Hermes runtime is up, my read-only model/tool check passed, and this Slack connection is verified. coding still follows the approved Linear flow.";
const READY_STATUS = "i'm gary. the Hermes runtime has passed its current readiness checks. this Slack connection only reports status; please use the normal approved Linear flow for coding work.";
const NOT_READY_STATUS = "i'm gary. the Hermes runtime has not passed its current readiness checks. this Slack connection only reports status; please use the normal approved Linear flow for coding work. i haven't started a task from this message.";
export const PRIVATE_DM_STATUS = "i got your message. this private DM connection is working. i can report runtime status here; coding work still goes through the approved Linear flow. i haven't started a task from this message.";
const CHANNEL = /^[CG][A-Z0-9]{5,32}$/;
const TIMESTAMP = /^\d{10,16}\.\d{6}$/;
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const object = (value:unknown):value is Record<string,unknown> => value !== null && typeof value==='object' && !Array.isArray(value);

export type SlackReadinessKind = 'coding_publication'|'readonly_runtime';
export type SlackHostHealth = {
  /** Trusted host evidence, never inferred from model text or actions.success alone. */
  kind?:'coding_publication';
  ready:boolean;
  hermesCanarySucceeded:boolean;
  readonlyCanarySucceeded?:never;
  /** Opaque deployment/canary receipt identifier. No prompts or credentials. */
  receiptId:string;
} | {
  kind:'readonly_runtime';
  ready:boolean;
  readonlyCanarySucceeded:boolean;
  hermesCanarySucceeded?:never;
  receiptId:string;
};
export interface SlackServiceOptions {
  db:DB;
  onIngressDiagnostic?:SlackIngressObserver;
  transport:SlackTransport;
  checkHostHealth():SlackHostHealth|Promise<SlackHostHealth>;
  /** Empty by default: no shared-channel replies until explicitly approved. */
  approvedChannelIds?:readonly string[];
  /** Only Tanner and optionally explicitly approved Ben. Default Tanner. */
  allowedUserIds?:readonly string[];
  /** Explicitly approved Tanner-only status replies; no model or history access. */
  tannerDirectMessages?:true;
  conversation?:SlackConversation;
  sharedConversation?:SlackSharedConversation;
  /** Separate deterministic producer intake: no conversation, coding or spend authority. */
  alertIntake?:SlackAlertIntake;
  /** Trusted exact-release/runtime composition proof; never coding/publication authority. */
  checkConversationHealth?():boolean;
}
export interface SlackServiceHealth {
  running:boolean; identityVerified:boolean; socketHealthy:boolean; hostReady:boolean;
  /** Which proof passed; readonly runtime health supplies no coding/publication authority. */
  readinessKind:SlackReadinessKind|null;
  readinessReceiptId:string|null; readyDelivery:'none'|'sent'|'unknown'|'not_sent';
}
export interface SlackService {
  start():Promise<SlackServiceHealth>;
  stop():Promise<void>;
  refreshHealth():Promise<SlackServiceHealth>;
  readonly health:SlackServiceHealth;
}
interface OutboxRow { status:'sent'|'unknown'|'not_sent'; }

export function createSlackService(options:SlackServiceOptions):SlackService {
  if(options.tannerDirectMessages!==undefined&&options.tannerDirectMessages!==true)throw new Error('invalid_slack_dm_switch');
  if(options.conversation&&(!options.tannerDirectMessages||options.approvedChannelIds?.length))throw new Error('dm_conversation_boundary_rejected');
  if(options.sharedConversation&&options.approvedChannelIds?.length)throw new Error('shared_conversation_boundary_rejected');
  const observe=createSlackIngressEmitter('service',options.onIngressDiagnostic);
  const channels=[...(options.approvedChannelIds??[])], users=[...(options.allowedUserIds??[GARY_SLACK.tannerId])];
  if (channels.length>64 || new Set(channels).size!==channels.length || channels.some(id=>!CHANNEL.test(id))) throw new Error('invalid_slack_channel_allowlist');
  if (new Set(users).size!==users.length || users.some(id=>id!==GARY_SLACK.tannerId && id!==GARY_SLACK.benId)) throw new Error('invalid_slack_user_allowlist');
  const channelSet=new Set(channels), userSet=new Set(users);
  const cancellation=new AbortController(), pending=new Set<Promise<unknown>>();
  const readyKey=`ready:${GARY_SLACK.readyRequest}:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${GARY_SLACK.tannerId}`;
  let running=false, stopped=false, initialized=false, identityVerified=false, hostReady=false, receiptId:string|null=null;
  let readinessKind:SlackReadinessKind|null=null;
  let startPromise:Promise<SlackServiceHealth>|undefined, stopPromise:Promise<void>|undefined, refreshPromise:Promise<SlackServiceHealth>|undefined;
  const live=()=>running&&!stopped&&!cancellation.signal.aborted;
  const conversationAvailable=()=>{
    if(!live()||!identityVerified||!options.transport.socketHealthy())return false;
    try{return options.checkConversationHealth?options.checkConversationHealth()===true:hostReady&&readinessKind==='readonly_runtime';}catch{return false;}
  };
  function track<T>(promise:Promise<T>):Promise<T> {
    pending.add(promise);void promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;
  }
  function initialize():void {
    // Root calls start only after configuration validation. No schema mutation at import/construction.
    // The UNKNOWN claim must survive power loss before a message can leave
    // this process. WAL with NORMAL sync does not provide that guarantee.
    try {
      options.db.exec('PRAGMA synchronous = FULL');
      if(options.db.query<{synchronous:number},[]>('PRAGMA synchronous').get()?.synchronous!==2) {
        throw new Error('slack_durability_unverified');
      }
    } catch {throw new Error('slack_durability_unverified');}
    // A separate DM outbox leaves every historical ready/mention claim intact.
    for(const table of ['gary_slack_outbox',...(options.tannerDirectMessages?['gary_slack_dm_outbox']:[]),...(options.sharedConversation?['gary_slack_shared_outbox']:[])])options.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      delivery_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN (${table==='gary_slack_dm_outbox'?"'dm'":table==='gary_slack_shared_outbox'?"'shared'":"'ready','mention'"})),
      request_id TEXT NOT NULL, app_id TEXT NOT NULL, team_id TEXT NOT NULL, bot_user_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL, target_channel TEXT NOT NULL, thread_ts TEXT,
      content_sha256 TEXT NOT NULL, readiness_receipt_id TEXT, claim_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('unknown','sent','not_sent')),
      claimed_at TEXT NOT NULL, completed_at TEXT, slack_channel TEXT, slack_ts TEXT, error_code TEXT
    )`);
    options.alertIntake?.initialize();
    // Validate an idle store before opening ingress. Once connected, a valid
    // event may already be active while start() is awaiting host health.
    if(options.alertIntake&&!options.alertIntake.ready())throw new Error('alert_intake_not_ready');
    initialized=true;
  }
  function snapshot():SlackServiceHealth {
    const row=initialized ? options.db.query<OutboxRow,[string]>('SELECT status FROM gary_slack_outbox WHERE delivery_key = ?').get(readyKey) : null;
    return {running:live(),identityVerified:live()&&identityVerified,socketHealthy:live()&&options.transport.socketHealthy(),
      hostReady:live()&&hostReady,readinessKind:live()&&hostReady?readinessKind:null,
      readinessReceiptId:receiptId,readyDelivery:row?.status??'none'};
  }
  async function identity():Promise<boolean> {
    if(!live() || !options.transport.socketHealthy()) {identityVerified=false;return false;}
    try {
      const actual=await options.transport.identity(cancellation.signal);
      identityVerified=live()&&options.transport.socketHealthy()&&actual.appId===GARY_SLACK.appId
        && actual.teamId===GARY_SLACK.teamId&&actual.botUserId===GARY_SLACK.botUserId;
    } catch {identityVerified=false;}
    return identityVerified;
  }
  async function sendOnce(input:{key:string;kind:'ready'|'mention'|'dm'|'shared';requestId:string;recipient:string;channel:string;threadTs?:string;text:string}):Promise<void> {
    if(!live()||!identityVerified||!options.transport.socketHealthy())return;
    const table=input.kind==='dm'?'gary_slack_dm_outbox':input.kind==='shared'?'gary_slack_shared_outbox':'gary_slack_outbox';
    const claim=randomUUID();
    // An exclusive durable UNKNOWN claim precedes the network request. A process
    // crash, ambiguous response, or duplicate process can never trigger an automatic retry.
    const claimed=options.db.query(`INSERT OR IGNORE INTO ${table}
      (delivery_key,kind,request_id,app_id,team_id,bot_user_id,recipient_id,target_channel,thread_ts,
       content_sha256,readiness_receipt_id,claim_id,status,claimed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'unknown',?)`).run(input.key,input.kind,input.requestId,GARY_SLACK.appId,GARY_SLACK.teamId,
        GARY_SLACK.botUserId,input.recipient,input.channel,input.threadTs??null,hash(input.text),receiptId,claim,new Date().toISOString());
    if(claimed.changes!==1)return;
    let status:OutboxRow['status']='unknown',channel:string|null=null,ts:string|null=null,error:string|null='transport_unknown';
    try {
      if(!live()||!options.transport.socketHealthy()) {status='not_sent';error='service_stopped_before_send';}
      else {
        const result=await options.transport.sendMessage({channel:input.channel,text:input.text,
          ...(input.threadTs?{threadTs:input.threadTs}:{})},cancellation.signal);
        if(result.ok && typeof result.channel==='string' && TIMESTAMP.test(result.ts)
          && (input.kind==='ready'?/^D[A-Z0-9]{5,32}$/.test(result.channel):result.channel===input.channel)) {
          status='sent';channel=result.channel;ts=result.ts;error=null;
        } else if(!result.ok && result.outcome==='definitely_not_sent') {status='not_sent';error='transport_declined';}
      }
    } catch { /* Retain unknown. Never infer non-delivery from timeout or cancellation. */ }
    options.db.query(`UPDATE ${table} SET status=?, completed_at=?, slack_channel=?, slack_ts=?, error_code=?
      WHERE delivery_key=? AND claim_id=? AND status='unknown'`).run(status,new Date().toISOString(),channel,ts,error,input.key,claim);
  }
  /** Shared-channel delivery: one durable claim per event, then the row authenticates exactly what left. */
  function sharedDelivery(key:string,eventId:string,user:string,channel:string,threadTs:string):DMDelivery {
    return async (text,kind='answer')=>{
      if(!conversationAvailable()||(kind!=='answer'&&kind!=='notice')||(kind==='answer'&&!options.sharedConversation!.ready()))return 'not_sent';
      await sendOnce({key,kind:'shared',requestId:eventId,recipient:user,channel,threadTs,text});
      const row=options.db.query<{status:OutboxRow['status'];content_sha256:string;recipient_id:string;target_channel:string;thread_ts:string},[string]>(
        'SELECT status,content_sha256,recipient_id,target_channel,thread_ts FROM gary_slack_shared_outbox WHERE delivery_key=?').get(key);
      if(!row)return 'not_sent';
      if(row.content_sha256!==hash(text)||row.recipient_id!==user||row.target_channel!==channel||row.thread_ts!==threadTs)return 'unknown';
      return row.status;
    };
  }
  async function refresh():Promise<SlackServiceHealth> {
    if(!live())return snapshot();
    hostReady=false;receiptId=null;readinessKind=null;
    if(!await identity())return snapshot();
    try {
      const health:unknown=await options.checkHostHealth();
      if(live() && options.transport.socketHealthy() && object(health) && health.ready===true
        && typeof health.receiptId==='string' && RECEIPT.test(health.receiptId)) {
        // Proofs are deliberately disjoint. A readonly success cannot satisfy
        // the existing coding gate, and unknown or mixed variants fail closed.
        if(health.kind==='readonly_runtime' && health.readonlyCanarySucceeded===true && !('hermesCanarySucceeded' in health)) {
          readinessKind='readonly_runtime';
        } else if((health.kind===undefined || health.kind==='coding_publication') && health.hermesCanarySucceeded===true
          && !('readonlyCanarySucceeded' in health)) {
          readinessKind='coding_publication';
        }
        if(readinessKind!==null) {hostReady=true;receiptId=health.receiptId;}
      }
    } catch {hostReady=false;}
    if(hostReady) await sendOnce({key:readyKey,kind:'ready',requestId:GARY_SLACK.readyRequest,recipient:GARY_SLACK.tannerId,
      channel:GARY_SLACK.tannerId,text:readinessKind==='readonly_runtime'?READONLY_READY_DM_TEXT:READY_DM_TEXT});
    return snapshot();
  }
  function refreshHealth():Promise<SlackServiceHealth> {
    if(refreshPromise)return refreshPromise;
    refreshPromise=track(refresh()).finally(()=>{refreshPromise=undefined;});return refreshPromise;
  }
  async function mention(envelope:unknown,frame?:SlackFrameInfo):Promise<void> {
    observe('service_envelope',slackEnvelopeShape(envelope,GARY_SLACK));
    if(!live()||!object(envelope)||envelope.type!=='events_api'||!object(envelope.payload)){observe('service_envelope_rejected');return;}
    const payload=envelope.payload;
    if(payload.type!=='event_callback'||payload.team_id!==GARY_SLACK.teamId||payload.api_app_id!==GARY_SLACK.appId
      ||typeof payload.event_id!=='string'||!/^Ev[A-Za-z0-9]{1,80}$/.test(payload.event_id)||!object(payload.event)){observe('service_payload_rejected');return;}
    const event=payload.event;
    if(event.type!=='app_mention')observe('service_event_not_mention');
    if(event.type==='message') {
      // Exact channel routing precedes the private message path. The intake
      // validates its own producer/metadata and never receives a DM responder.
      if(event.channel==='C0AKGTZM8KB') {
        if(options.alertIntake&&conversationAvailable()) {
          const result=await options.alertIntake.handle(envelope,cancellation.signal,conversationAvailable,frame?.rawBytes);
          const stage=({ignored:'alert_ignored',unavailable:'alert_unavailable',rejected:'alert_rejected',suppressed:'alert_suppressed',
            duplicate:'alert_duplicate',conflict:'alert_conflict',limited:'alert_limited',busy:'alert_busy',drafted:'alert_drafted',
            sent:'alert_sent',not_sent:'alert_not_sent',halted:'alert_halted'} as const)[result.kind];
          if(stage)observe(stage);
        }
        return;
      }
      if(options.sharedConversation&&typeof event.channel==='string'&&CHANNEL.test(event.channel)) {
        // A threaded reply continues a conversation an explicit mention already opened. A message that
        // mentions Gary also arrives as app_mention and is routed only there, so nothing is answered twice.
        if(event.thread_ts===undefined||event.thread_ts===event.ts){observe('shared_thread_ignored');return;}
        if(event.bot_id!==undefined||event.subtype!==undefined||event.user===GARY_SLACK.botUserId||event.user==='USLACKBOT'){observe('shared_bot_rejected');return;}
        if(event.channel_type==='im'||event.channel_type==='mpim'||typeof event.user!=='string'||!/^[UW][A-Z0-9]{5,32}$/.test(event.user)
          ||typeof event.text!=='string'||!event.text.trim()||event.text.length>40_000
          ||typeof event.ts!=='string'||!TIMESTAMP.test(event.ts)||typeof event.thread_ts!=='string'||!TIMESTAMP.test(event.thread_ts)){observe('shared_thread_shape_rejected');return;}
        if(hasSlackUserMention(event.text,GARY_SLACK.botUserId)){observe('shared_thread_mention_deferred');return;}
        if((event.team!==undefined&&event.team!==GARY_SLACK.teamId)||(payload.context_team_id!==undefined&&payload.context_team_id!==GARY_SLACK.teamId)
          ||(payload.is_ext_shared_channel!==undefined&&payload.is_ext_shared_channel!==false)){observe('shared_scope_rejected');return;}
        const eventId=payload.event_id,channel=event.channel,user=event.user,ts=event.ts,threadTs=event.thread_ts;
        // Threads Gary never joined cost nothing: no identity refresh, outbox read or metadata lookup.
        if(!options.sharedConversation.joined(channel,threadTs)){observe('shared_thread_inactive');return;}
        const key=`shared:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${eventId}`;
        if(options.db.query('SELECT 1 FROM gary_slack_shared_outbox WHERE delivery_key=?').get(key)){observe('shared_duplicate');return;}
        await refreshHealth();
        if(!conversationAvailable()){observe('shared_health_rejected');return;}
        observe('shared_thread_dispatch');
        await options.sharedConversation.respond({type:'thread_reply',appId:GARY_SLACK.appId,teamId:GARY_SLACK.teamId,botUserId:GARY_SLACK.botUserId,
          requesterId:user,eventId,channel,ts,threadTs,text:event.text},sharedDelivery(key,eventId,user,channel,threadTs),cancellation.signal,conversationAvailable);
        return;
      }
      if(!options.tannerDirectMessages||event.channel_type!=='im'||event.user!==GARY_SLACK.tannerId
        ||event.bot_id!==undefined||event.subtype!==undefined||typeof event.channel!=='string'||!/^D[A-Z0-9]{5,32}$/.test(event.channel)
        ||typeof event.text!=='string'||!event.text.trim()||event.text.length>40_000
        ||typeof event.ts!=='string'||!TIMESTAMP.test(event.ts)
        ||(event.thread_ts!==undefined&&(typeof event.thread_ts!=='string'||!TIMESTAMP.test(event.thread_ts))))return;
      // The existing verified ready delivery binds this exact private conversation.
      // No conversations.history/info lookup, shared channels, or other users.
      const ready=options.db.query<{slack_channel:string},[string]>("SELECT slack_channel FROM gary_slack_outbox WHERE delivery_key=? AND status='sent'").get(readyKey);
      if(ready?.slack_channel!==event.channel)return;
      await refreshHealth();
      if(!live()||!identityVerified||!options.transport.socketHealthy())return;
      const eventId=payload.event_id,channel=event.channel,ts=event.ts,user=event.user,threadTs=(event.thread_ts??event.ts) as string;
      const key=`dm:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${eventId}`;
      if(options.conversation) {
        if(!conversationAvailable()||options.db.query('SELECT 1 FROM gary_slack_dm_outbox WHERE delivery_key=?').get(key))return;
        // Incoming text is passed only after every existing identity/channel/health gate.
        await options.conversation.respond({eventId,channel,ts,threadTs,text:event.text},async (text,kind='answer')=>{
          if(!conversationAvailable()||(kind!=='answer'&&kind!=='notice')||(kind==='answer'&&!options.conversation!.ready()))return 'not_sent';
          await sendOnce({key,kind:'dm',requestId:eventId,recipient:user,channel,threadTs,text});
          const row=options.db.query<{status:OutboxRow['status'];content_sha256:string;recipient_id:string;target_channel:string;thread_ts:string},[string]>('SELECT status,content_sha256,recipient_id,target_channel,thread_ts FROM gary_slack_dm_outbox WHERE delivery_key=?').get(key);
          if(!row)return 'not_sent';
          if(row.content_sha256!==hash(text)||row.recipient_id!==user||row.target_channel!==channel||row.thread_ts!==threadTs)return 'unknown';
          return row.status;
        },cancellation.signal,conversationAvailable);
      } else await sendOnce({key,kind:'dm',requestId:eventId,recipient:user,channel,threadTs,
        text:hostReady?PRIVATE_DM_STATUS:NOT_READY_STATUS});
      return;
    }
    if(options.sharedConversation&&event.type==='app_mention') {
      if(event.bot_id!==undefined||event.subtype!==undefined||event.user===GARY_SLACK.botUserId||event.user==='USLACKBOT'){observe('shared_bot_rejected');return;}
      if(typeof event.user!=='string'||!/^[UW][A-Z0-9]{5,32}$/.test(event.user)
        ||typeof event.channel!=='string'||!CHANNEL.test(event.channel)||typeof event.text!=='string'||!event.text.trim()
        ||event.text.length>40_000
        ||typeof event.ts!=='string'||!TIMESTAMP.test(event.ts)||(event.thread_ts!==undefined&&(typeof event.thread_ts!=='string'||!TIMESTAMP.test(event.thread_ts)))){observe('shared_shape_rejected');return;}
      if(!hasSlackUserMention(event.text,GARY_SLACK.botUserId)){observe('shared_mention_rejected');return;}
      if((event.team!==undefined&&event.team!==GARY_SLACK.teamId)||(payload.context_team_id!==undefined&&payload.context_team_id!==GARY_SLACK.teamId)
        ||(payload.is_ext_shared_channel!==undefined&&payload.is_ext_shared_channel!==false)){observe('shared_scope_rejected');return;}
      const eventId=payload.event_id,channel=event.channel,user=event.user,ts=event.ts,threadTs=(event.thread_ts??event.ts) as string;
      const key=`shared:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${eventId}`,oldKey=`mention:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${eventId}`;
      if(options.db.query('SELECT 1 FROM gary_slack_shared_outbox WHERE delivery_key=?').get(key)
        ||options.db.query('SELECT 1 FROM gary_slack_outbox WHERE delivery_key=?').get(oldKey)){observe('shared_duplicate');return;}
      await refreshHealth();
      if(!conversationAvailable()){observe('shared_health_rejected');return;}
      observe('shared_dispatch');
      await options.sharedConversation.respond({type:'app_mention',appId:GARY_SLACK.appId,teamId:GARY_SLACK.teamId,botUserId:GARY_SLACK.botUserId,
        requesterId:user,eventId,channel,ts,threadTs,text:event.text},sharedDelivery(key,eventId,user,channel,threadTs),cancellation.signal,conversationAvailable);
      return;
    }
    if(event.type!=='app_mention'||event.bot_id!==undefined||event.subtype!==undefined||typeof event.user!=='string'
      ||!userSet.has(event.user)||typeof event.channel!=='string'||!channelSet.has(event.channel)
      ||typeof event.text!=='string'||event.text.length>40_000||!hasSlackUserMention(event.text,GARY_SLACK.botUserId)
      ||typeof event.ts!=='string'||!TIMESTAMP.test(event.ts)
      ||(event.thread_ts!==undefined&&(typeof event.thread_ts!=='string'||!TIMESTAMP.test(event.thread_ts))))return;
    // Refresh trusted health only; incoming text never enters a model or becomes instructions.
    await refreshHealth();
    if(!live()||!identityVerified||!options.transport.socketHealthy())return;
    await sendOnce({key:`mention:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${payload.event_id}`,kind:'mention',
      requestId:payload.event_id,recipient:event.user,channel:event.channel,threadTs:(event.thread_ts??event.ts) as string,
      text:hostReady?(readinessKind==='readonly_runtime'?READONLY_READY_DM_TEXT:READY_STATUS):NOT_READY_STATUS});
  }
  function start():Promise<SlackServiceHealth> {
    if(stopped)return Promise.reject(new Error('slack_service_stopped'));
    if(startPromise)return startPromise;
    startPromise=(async()=>{
      initialize();
      try {
        await options.transport.start((envelope,frame)=>track(mention(envelope,frame)),cancellation.signal);
        if(stopped)return snapshot();
        running=true;return await refreshHealth();
      } catch {
        stopped=true;running=false;identityVerified=false;hostReady=false;cancellation.abort();
        try { await options.transport.stop(); }
        finally { await Promise.allSettled([...pending]); throw new Error('slack_service_start_failed'); }
      }
    })();return startPromise;
  }
  function stop():Promise<void> {
    if(stopPromise)return stopPromise;
    stopped=true;running=false;identityVerified=false;hostReady=false;cancellation.abort();
    stopPromise=(async()=>{
      let transportFailed=false;
      try { await options.transport.stop(); } catch { transportFailed=true; }
      finally {
        if(startPromise)await startPromise.catch(()=>{});
        await Promise.allSettled([...pending]);
      }
      if(transportFailed)throw new Error('slack_service_stop_failed');
    })();return stopPromise;
  }
  return {start,stop,refreshHealth,get health(){return snapshot();}};
}
