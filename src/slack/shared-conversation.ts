/** Isolated context for explicitly mentioned shared-channel turns; no DM or coding authority. */
import { Database } from 'bun:sqlite';
import { hasSlackUserMention } from './mentions.ts';
import { createSlackIngressEmitter, type SlackIngressObserver } from './ingress-diagnostics.ts';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DM_CONVERSATION_POLICY, DMReplyError, exactDMAllocation, type DMTurn, type DMText } from '../hermes/dm-conversation.ts';
import type { SlackMemberMetadata, SlackChannelMetadata } from './transport.ts';
import type { SpendLedger } from '../spend.ts';

export const SHARED_CONVERSATION_POLICY=Object.freeze({...DM_CONVERSATION_POLICY,version:1,profile:'workspace_channel',trigger:'explicit_mention',metadataMaxAgeMs:15_000,
  appId:'A0C7QFW3PEG',teamId:'T0AA24R7VUZ',botUserId:'U0C7NPEUG1F',codingDispatch:'disabled',conversationRequesters:'active_internal_full_members'} as const);
const POLICY=SHARED_CONVERSATION_POLICY;
export interface SlackSharedConversationConfig { readonly version:1; readonly runId:string; readonly campaignId:string; readonly allocationId:string; readonly contextDirectory:string;
  readonly appId:string;readonly teamId:string;readonly botUserId:string;readonly trigger:'explicit_mention' }
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function privatePath(path:string, directory:boolean):void {
  const s=lstatSync(path);
  if(s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==(directory?0o700:0o600)
    ||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1)||realpathSync(path)!==path)throw new Error('dm_private_path_rejected');
}
export function loadSlackSharedConversationConfig(path:string):SlackSharedConversationConfig {
  if(!isAbsolute(path)||normalize(path)!==path||/[\0\r\n]/.test(path))throw new Error('dm_config_rejected');
  privatePath(dirname(path),true);privatePath(path,false);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let source:string;
  try {const stat=fstatSync(fd);if(stat.size>2048||stat.ino!==lstatSync(path).ino)throw new Error('dm_config_rejected');source=readFileSync(fd,'utf8');}finally{closeSync(fd);}
  const value=JSON.parse(source),keys=[...source.matchAll(/"([^"\\]*)"\s*:/g)].map(match=>match[1]);
  if(!value||typeof value!=='object'||Array.isArray(value)||keys.length!==8||new Set(keys).size!==8
    ||Object.keys(value).sort().join(',')!=='allocationId,appId,botUserId,campaignId,runId,teamId,trigger,version'||value.version!==1
    ||value.teamId!==POLICY.teamId||value.appId!==POLICY.appId||value.botUserId!==POLICY.botUserId||value.trigger!=='explicit_mention'
    ||value.runId!=='hermes-shared-20261008'||value.campaignId!==value.runId||value.allocationId!=='local:hermes-shared-20261008')throw new Error('dm_config_rejected');
  return Object.freeze({version:1,teamId:value.teamId,appId:value.appId,botUserId:value.botUserId,trigger:value.trigger,runId:value.runId,campaignId:value.campaignId,allocationId:value.allocationId,contextDirectory:dirname(path)});
}
export function fingerprintSlackSharedConversationConfig(config:SlackSharedConversationConfig):string {
  return hash(JSON.stringify({version:config.version,runId:config.runId,campaignId:config.campaignId,allocationId:config.allocationId,
    contextDirectory:config.contextDirectory,appId:config.appId,teamId:config.teamId,botUserId:config.botUserId,trigger:config.trigger,policy:POLICY}));
}
export interface SlackSharedConversationInput { type:'app_mention'; appId:string;teamId:string;botUserId:string;requesterId:string;eventId:string;channel:string;ts:string;threadTs:string;text:string }
export interface SlackSharedMetadata {
  memberInfo(userId:string,signal?:AbortSignal):Promise<SlackMemberMetadata>;
  channelInfo(channelId:string,signal?:AbortSignal):Promise<SlackChannelMetadata>;
}
function memberAllowed(input:SlackSharedConversationInput,member:SlackMemberMetadata,now:number):boolean {
  return member.id===input.requesterId&&member.teamId===POLICY.teamId&&member.deleted===false&&member.isBot===false&&member.isAppUser===false
    &&member.isRestricted===false&&member.isUltraRestricted===false&&member.isStranger===false&&fresh(member.observedAt,now);
}
const fresh=(at:number,now:number)=>Number.isFinite(at)&&at<=now&&now-at<=POLICY.metadataMaxAgeMs;
function channelAllowed(input:SlackSharedConversationInput,channel:SlackChannelMetadata,now:number):boolean {
  return channel.id===input.channel&&channel.teamId===POLICY.teamId&&channel.isMember===true&&channel.isArchived===false
    &&typeof channel.isPrivate==='boolean'&&channel.isShared===false&&channel.isExtShared===false&&channel.isOrgShared===false
    &&channel.isPendingExtShared===false&&fresh(channel.observedAt,now);
}
export function sharedMetadataAllowed(input:SlackSharedConversationInput,member:SlackMemberMetadata,channel:SlackChannelMetadata,now=Date.now()):boolean {
  return memberAllowed(input,member,now)&&channelAllowed(input,channel,now);
}
export type DMDelivery=(text:string,kind?:'answer'|'notice')=>Promise<'sent'|'unknown'|'not_sent'>;
export interface SlackSharedConversation {
  respond(input:SlackSharedConversationInput,deliver:DMDelivery,signal:AbortSignal,isAvailable?:()=>boolean):Promise<void>;
  close():{drained:boolean};
  ready():boolean;
}
interface Session { history:string; turns:number; blocked:number }
export function createSlackSharedConversation(options:{config:SlackSharedConversationConfig;ledger:SpendLedger;metadata:SlackSharedMetadata;onIngressDiagnostic?:SlackIngressObserver;reply:(turn:DMTurn)=>Promise<string>}):SlackSharedConversation {
  const observe=createSlackIngressEmitter('shared',options.onIngressDiagnostic);
  const {config,ledger}=options,owner=randomUUID(),fingerprint=fingerprintSlackSharedConversationConfig(config),file=join(config.contextDirectory,'shared-context.sqlite');
  privatePath(config.contextDirectory,true);
  try {const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  privatePath(file,false);
  const db=new Database(file,{strict:true});
  let closed=false,queued=0,admitting=0,tail:Promise<void>=Promise.resolve();
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    if((db.query('PRAGMA synchronous').get() as any)?.synchronous!==2||(db.query('PRAGMA journal_mode').get() as any)?.journal_mode!=='delete')throw new Error('dm_context_not_durable');
    db.exec(`CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL,blocked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (session_key TEXT PRIMARY KEY,history TEXT NOT NULL,turns INTEGER NOT NULL,blocked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices (event_key TEXT PRIMARY KEY,message_key TEXT NOT NULL UNIQUE,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (event_key TEXT PRIMARY KEY,message_key TEXT NOT NULL UNIQUE,session_key TEXT NOT NULL,owner TEXT NOT NULL,
      requester_id TEXT NOT NULL,team_id TEXT NOT NULL,channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','sent','failed','unknown')),input_sha256 TEXT NOT NULL,worker_name TEXT,cleanup INTEGER NOT NULL DEFAULT 0,error_code TEXT);`);
    db.query('INSERT OR IGNORE INTO control VALUES (1,?,0)').run(fingerprint);
    if((db.query('SELECT fingerprint FROM control WHERE id=1').get() as any)?.fingerprint!==fingerprint)throw new Error('dm_context_config_mismatch');
    privatePath(file,false);
  }catch(error){db.close();throw error;}
  const pending=()=>Number((db.query("SELECT count(*) AS n FROM events WHERE cleanup=0").get() as any).n);
  const blocked=()=>Boolean((db.query('SELECT blocked FROM control WHERE id=1').get() as any).blocked);
  // A prior owner may have left a native process or model dispatch in flight. Never take it over.
  if(pending())db.query('UPDATE control SET blocked=1 WHERE id=1').run();
  const allocationReady=()=>{const s=ledger.status(config.allocationId);return exactDMAllocation(s,config.allocationId,config.campaignId)&&s.unknownAttempts===0;};
  if(!allocationReady()){db.close();throw new Error('dm_budget_unavailable');}
  async function authorize(input:SlackSharedConversationInput,signal:AbortSignal):Promise<boolean> {
    try {const [member,channel]=await Promise.all([
      options.metadata.memberInfo(input.requesterId,signal).catch(error=>{observe('shared_member_lookup_failed');throw error;}),
      options.metadata.channelInfo(input.channel,signal).catch(error=>{observe('shared_channel_lookup_failed');throw error;})]);
      const now=Date.now();
      if(signal.aborted){observe('shared_health_rejected');return false;}
      if(!memberAllowed(input,member,now)){observe('shared_member_rejected');return false;}
      if(!channelAllowed(input,channel,now)){observe('shared_channel_rejected');return false;}
      observe('shared_metadata_allowed');return true;
    }catch{observe('shared_metadata_unavailable');return false;}
  }
  const encodedText=(input:SlackSharedConversationInput)=>JSON.stringify({senderId:input.requesterId,text:input.text});
  async function execute(input:SlackSharedConversationInput,key:string,sessionKey:string,deliver:DMDelivery,signal:AbortSignal,isAvailable:()=>boolean):Promise<void> {
    let cleanup=true,errorCode:string|null=null,reply:string|undefined;
    try {
      const session=db.query<Session,[string]>('SELECT history,turns,blocked FROM sessions WHERE session_key=?').get(sessionKey)!;
      if(!isAvailable()||signal.aborted||blocked()||session.blocked||!allocationReady()||!await authorize(input,signal)||!isAvailable())throw new DMReplyError('dm_turn_unavailable');
      const history=JSON.parse(session.history) as DMText[],text=encodedText(input);
      if(session.turns>=POLICY.maxTurns||Buffer.byteLength(JSON.stringify([...history,{role:'user',content:text}]))+POLICY.maxReplyBytes+100>POLICY.maxContextBytes)throw new DMReplyError('dm_context_limit');
      db.query("UPDATE events SET state='running' WHERE event_key=? AND owner=? AND state='queued'").run(key,owner);
      reply=await options.reply({requestId:randomUUID(),ownerId:owner,allocationId:config.allocationId,campaignId:config.campaignId,
        authority:Object.freeze({surface:'shared_channel',requesterId:input.requesterId,teamId:input.teamId,channelId:input.channel,threadTs:input.threadTs}),
        history,text,signal,
        assertActive:()=>{
          if(closed||!isAvailable()||blocked()||signal.aborted||(db.query('SELECT state,owner FROM events WHERE event_key=?').get(key) as any)?.owner!==owner
            ||(db.query('SELECT state FROM events WHERE event_key=?').get(key) as any)?.state!=='running')throw new DMReplyError('dm_owner_changed');
        },
        recordWorker:name=>{if(!/^gary-hermes-worker-[a-f0-9-]{36}$/.test(name))throw new DMReplyError('dm_worker_binding_rejected');
          const result=db.query("UPDATE events SET worker_name=? WHERE event_key=? AND owner=? AND state='running' AND worker_name IS NULL").run(name,key,owner);
          if(result.changes!==1)throw new DMReplyError('dm_worker_binding_rejected');}
      });
      if(!isAvailable()||signal.aborted||blocked()||!allocationReady()||!await authorize(input,signal)||!isAvailable())throw new DMReplyError('dm_turn_unavailable');
      if(typeof reply!=='string'||!reply.trim()||Buffer.byteLength(reply)>POLICY.maxReplyBytes)throw new DMReplyError('dm_reply_rejected');
      const next=[...history,{role:'user',content:text},{role:'assistant',content:reply}];
      if(Buffer.byteLength(JSON.stringify(next))>POLICY.maxContextBytes)throw new DMReplyError('dm_context_limit');
      let delivery:'sent'|'unknown'|'not_sent'='unknown';
      try {delivery=await deliver(reply,'answer');}catch{/* An ambiguous send is never retried. */}
      db.transaction(()=>{
        if(delivery==='sent')db.query('UPDATE sessions SET history=?,turns=turns+1 WHERE session_key=?').run(JSON.stringify(next),sessionKey);
        else db.query('UPDATE sessions SET blocked=1 WHERE session_key=?').run(sessionKey);
        db.query('UPDATE events SET state=?,cleanup=1,error_code=? WHERE event_key=? AND owner=?').run(delivery==='sent'?'sent':delivery==='unknown'?'unknown':'failed',delivery==='sent'?null:'dm_delivery_'+delivery,key,owner);
      }).immediate();
      return;
    }catch(error){
      errorCode=error instanceof DMReplyError?error.code:'dm_turn_failed';cleanup=error instanceof DMReplyError?error.cleanupConfirmed:false;
      db.transaction(()=>{
        db.query('UPDATE sessions SET blocked=1 WHERE session_key=?').run(sessionKey);
        db.query("UPDATE events SET state='failed',cleanup=?,error_code=? WHERE event_key=? AND owner=?").run(cleanup?1:0,errorCode,key,owner);
        if(!cleanup||ledger.status(config.allocationId)?.unknownAttempts)db.query('UPDATE control SET blocked=1 WHERE id=1').run();
      }).immediate();
      if(!signal.aborted&&isAvailable()&&await authorize(input,signal))try {await deliver("I couldn't complete that reply. This thread is paused, and I won't retry the message automatically.",'notice');}catch{/* No retry. */}
    }
  }
  async function admit(input:SlackSharedConversationInput,deliver:DMDelivery,signal:AbortSignal,isAvailable:()=>boolean=()=>true):Promise<void> {
    if(closed||!isAvailable()||signal.aborted||input.type!=='app_mention'||input.appId!==POLICY.appId||input.teamId!==POLICY.teamId||input.botUserId!==POLICY.botUserId
      ||typeof input.requesterId!=='string'||! /^[UW][A-Z0-9]{5,32}$/.test(input.requesterId)||input.requesterId===POLICY.botUserId||input.requesterId==='USLACKBOT'
      ||typeof input.text!=='string'||!input.text.trim()||!hasSlackUserMention(input.text,POLICY.botUserId)||!/^Ev[A-Za-z0-9]{1,80}$/.test(input.eventId)
      ||!/^[CG][A-Z0-9]{5,32}$/.test(input.channel)||!/^\d{10,16}\.\d{6}$/.test(input.ts)||!/^\d{10,16}\.\d{6}$/.test(input.threadTs)){observe('shared_input_rejected');return Promise.resolve();}
    const scope=POLICY.appId+':'+POLICY.teamId;
    const key=config.runId+':'+scope+':'+input.eventId,messageKey=scope+':'+input.channel+':'+input.ts,sessionKey=scope+':'+input.channel+':'+input.threadTs;
    const duplicate=()=>db.query('SELECT 1 FROM events WHERE event_key=? OR message_key=?').get(key,messageKey)
      ||db.query('SELECT 1 FROM notices WHERE event_key=? OR message_key=?').get(key,messageKey);
    const notice=(reason:string):Promise<void>=>{
      observe('shared_admission_rejected');
      const claimed=db.transaction(()=>{if(duplicate()||Number((db.query('SELECT count(*) AS n FROM notices').get() as any).n)>=POLICY.maxNotices)return false;
        db.query('INSERT INTO notices VALUES (?,?,?)').run(key,messageKey,reason);return true;}).immediate();
      return claimed?deliver("I can't answer this message within the current conversation limits. No model call was made.",'notice').then(()=>{},()=>{}):Promise.resolve();
    };
    if(duplicate()){observe('shared_duplicate');return Promise.resolve();}
    if(!await authorize(input,signal)||!isAvailable()||closed)return Promise.resolve();
    if(queued>=POLICY.maxQueued||blocked()||!allocationReady()||Buffer.byteLength(encodedText(input))>POLICY.maxInputBytes)return notice('shared_admission_limit');
    const accepted=db.transaction(()=>{
      if(duplicate()||db.query("SELECT 1 FROM events WHERE cleanup=0 AND owner<>?").get(owner)
        ||Number((db.query('SELECT count(*) AS n FROM events').get() as any).n)>=POLICY.maxAcceptedEvents)return false;
      const session=db.query<Session,[string]>('SELECT history,turns,blocked FROM sessions WHERE session_key=?').get(sessionKey);
      if(session?.blocked||session&&session.turns>=POLICY.maxTurns)return false;
      if(!session){
        // An explicit mention in an older thread starts empty local context; no history fetch.
        if(Number((db.query('SELECT count(*) AS n FROM sessions').get() as any).n)>=POLICY.maxSessions)return false;
        db.query("INSERT INTO sessions VALUES (?,'[]',0,0)").run(sessionKey);
      }
      db.query("INSERT INTO events(event_key,message_key,session_key,owner,requester_id,team_id,channel_id,thread_ts,state,input_sha256) VALUES (?,?,?,?,?,?,?,?,'queued',?)").run(key,messageKey,sessionKey,owner,input.requesterId,input.teamId,input.channel,input.threadTs,hash(input.text));
      return true;
    }).immediate();
    if(!accepted)return notice('shared_session_limit');
    observe('shared_claimed');
    queued++;
    const run=tail.then(()=>execute(input,key,sessionKey,deliver,signal,isAvailable));
    tail=run.catch(()=>{db.query('UPDATE control SET blocked=1 WHERE id=1').run();}).finally(()=>{queued--;});
    return tail;
  }
  function respond(input:SlackSharedConversationInput,deliver:DMDelivery,signal:AbortSignal,isAvailable:()=>boolean=()=>true):Promise<void> {
    if(closed||admitting>=POLICY.maxQueued)return Promise.resolve();
    admitting++;return admit(input,deliver,signal,isAvailable).finally(()=>{admitting--;});
  }
  return {respond,ready:()=>!closed&&!blocked()&&allocationReady(),close(){if(closed)throw new Error('dm_context_already_closed');if(queued||admitting)throw new Error('dm_context_not_drained');
    const drained=pending()===0;closed=true;db.close();return {drained};}};
}
