/** Host-only diagnostics: finite values, no message bodies, IDs, credentials or raw errors. */
import { log } from '../logger.ts';
import { classifySlackUserMentions } from './mentions.ts';

export const SLACK_INGRESS_STAGES=[
  'transport_envelope','transport_frame_rejected','transport_protocol_rejected','transport_hello',
  'service_envelope','service_envelope_rejected','service_payload_rejected','service_event_not_mention',
  'shared_bot_rejected','shared_shape_rejected','shared_mention_rejected','shared_scope_rejected',
  'shared_duplicate','shared_health_rejected','shared_dispatch','shared_input_rejected',
  'shared_metadata_unavailable','shared_member_lookup_failed','shared_channel_lookup_failed','shared_member_rejected','shared_channel_rejected','shared_metadata_allowed',
  'shared_claimed','shared_admission_rejected','diagnostics_limited',
] as const;
type Component='transport'|'service'|'shared';
type Stage=typeof SLACK_INGRESS_STAGES[number];
const BOOLEAN_FIELDS=['hasEnvelopeId','hasPayload','hasEvent','hasEventId','hasAppId','hasPayloadTeam','hasUser','hasChannel','hasText','hasTs','hasThreadTs',
  'hasBotId','hasSubtype','hasEventTeam','hasContextTeam','hasExternalHint',
  'canonicalMention','labeledMention','payloadAppMatches','payloadTeamMatches','eventTeamMatches','contextTeamMatches'] as const;
type Shape=Partial<Record<typeof BOOLEAN_FIELDS[number],boolean>> & {
  envelopeKind?:'events_api'|'hello'|'disconnect'|'other'|'missing';
  payloadKind?:'event_callback'|'other'|'missing';
  eventKind?:'app_mention'|'message'|'other'|'missing';
};
export type SlackIngressDiagnostic=Readonly<{component:Component;stage:Stage}&Shape>;
export type SlackIngressObserver=(diagnostic:SlackIngressDiagnostic)=>void|Promise<void>;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Runtime allowlist also protects the logging seam if a caller passes extra fields. */
export function sanitizeSlackIngressDiagnostic(value:unknown):SlackIngressDiagnostic|null {
  if(!object(value)||typeof value.component!=='string'||!['transport','service','shared'].includes(value.component)
    ||!SLACK_INGRESS_STAGES.includes(value.stage as Stage))return null;
  const safe:Record<string,unknown>={component:value.component,stage:value.stage};
  for(const key of BOOLEAN_FIELDS)if(typeof value[key]==='boolean')safe[key]=value[key];
  for(const [key,allowed] of [['envelopeKind',['events_api','hello','disconnect','other','missing']],
    ['payloadKind',['event_callback','other','missing']],['eventKind',['app_mention','message','other','missing']]] as const){
    if(typeof value[key]==='string'&&(allowed as readonly string[]).includes(value[key] as string))safe[key]=value[key];
  }
  return Object.freeze(safe) as SlackIngressDiagnostic;
}
export function slackEnvelopeShape(value:unknown,expected:Readonly<{appId:string;teamId:string;botUserId:string}>):Shape {
  const envelope=object(value)?value:{},payload=object(envelope.payload)?envelope.payload:{},event=object(payload.event)?payload.event:{};
  const mention=typeof event.text==='string'?classifySlackUserMentions(event.text,expected.botUserId):{canonical:false,labeled:false};
  const kind=(value:unknown,allowed:readonly string[])=>value===undefined?'missing':allowed.includes(value as string)?value:'other';
  return {envelopeKind:kind(envelope.type,['events_api','hello','disconnect']) as NonNullable<Shape['envelopeKind']>,
    payloadKind:kind(payload.type,['event_callback']) as NonNullable<Shape['payloadKind']>,eventKind:kind(event.type,['app_mention','message']) as NonNullable<Shape['eventKind']>,
    hasEnvelopeId:envelope.envelope_id!==undefined,hasPayload:object(envelope.payload),hasEvent:object(payload.event),
    hasEventId:payload.event_id!==undefined,hasAppId:payload.api_app_id!==undefined,hasPayloadTeam:payload.team_id!==undefined,
    hasUser:event.user!==undefined,hasChannel:event.channel!==undefined,hasText:event.text!==undefined,hasTs:event.ts!==undefined,
    hasThreadTs:event.thread_ts!==undefined,hasBotId:event.bot_id!==undefined,hasSubtype:event.subtype!==undefined,
    hasEventTeam:event.team!==undefined,hasContextTeam:payload.context_team_id!==undefined,hasExternalHint:payload.is_ext_shared_channel!==undefined,
    canonicalMention:mention.canonical,labeledMention:mention.labeled,payloadAppMatches:payload.api_app_id===expected.appId,
    payloadTeamMatches:payload.team_id===expected.teamId,eventTeamMatches:event.team===expected.teamId,contextTeamMatches:payload.context_team_id===expected.teamId};
}
export function createSlackIngressEmitter(component:Component,observer?:SlackIngressObserver):(stage:Stage,shape?:Shape)=>void {
  let count=0;
  return(stage,shape)=>{
    if(!observer||count>256)return;
    const diagnostic=sanitizeSlackIngressDiagnostic(count++===256?{component,stage:'diagnostics_limited'}:{...shape,component,stage});
    if(!diagnostic)return;
    try {const pending=observer(diagnostic);if(pending)void Promise.resolve(pending).catch(()=>{});}catch{/* Observability cannot affect admission. */}
  };
}
export function logSlackIngressDiagnostic(value:SlackIngressDiagnostic):void {
  const safe=sanitizeSlackIngressDiagnostic(value);if(safe)log.info('slack ingress',safe);
}
