/** Pure, zero-model contract for the explicitly bound Mulligan alert producer. */
import type { SlackChannelMetadata } from './transport.ts';

export const ALERT_INTAKE_POLICY = Object.freeze({
  version: 1, teamId: 'T0AA24R7VUZ', channelId: 'C0AKGTZM8KB', appId: 'A0C7QFW3PEG',
  botUserId: 'U0C7NPEUG1F', botId: 'B0C7FG7HSJ1', project: 'mulligan-labs',
  rawBytes: 65_536, normalizedBytes: 32_768, attachments: 10, fields: 24,
  fieldNameBytes: 64, fieldValueBytes: 4_096, titleBytes: 128, freeTextBytes: 8_192,
  maxAgeMs: 15 * 60_000, maxFutureMs: 60_000, metadataMaxAgeMs: 60_000,
} as const);
const P = ALERT_INTAKE_POLICY;

/** Both identities must come from reviewed raw producer evidence, never a display name. */
export interface AlertProducerBinding { readonly botId: string; readonly appId: string }
export interface AlertDecisionContext {
  readonly nowMs: number;
  readonly producer: AlertProducerBinding | null;
  /** Returned by the host's strict conversations.info validator, not from the message. */
  readonly channel: SlackChannelMetadata | null;
}
export type AlertOutcome = 'exceededCpu' | 'exceededMemory';
export interface AlertObservation { readonly attachmentIndex: number; readonly outcome: AlertOutcome }
export interface AlertEvidence {
  readonly teamId: typeof P.teamId;
  readonly channelId: typeof P.channelId;
  readonly eventId: string;
  readonly messageTs: string;
  /** A reviewed producer/channel mapping, not a project name asserted by alert text. */
  readonly project: typeof P.project;
  readonly observations: readonly AlertObservation[];
}
export type AlertRejectionReason = 'unbound_producer' | 'invalid_clock' | 'envelope_rejected'
  | 'wrong_scope' | 'producer_rejected' | 'message_rejected' | 'timestamp_rejected'
  | 'channel_rejected' | 'raw_size_rejected' | 'content_rejected' | 'content_size_rejected';
export type AlertDecision =
  | { readonly kind: 'rejected'; readonly reason: AlertRejectionReason }
  | { readonly kind: 'suppressed'; readonly reason: 'no_eligible_observation' }
  | { readonly kind: 'accepted'; readonly evidence: AlertEvidence; readonly advisory: string };

const rejected = (reason: AlertRejectionReason): AlertDecision => Object.freeze({ kind: 'rejected', reason });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const textWithin = (value: unknown, limit: number): value is string => typeof value === 'string' && bytes(value) <= limit;
const slackId = (value: unknown, prefix: string): value is string => typeof value === 'string' && new RegExp(`^${prefix}[A-Z0-9]{5,63}$`).test(value);

/** Defensive parsed-object bound; transport supplies the separate, trusted raw-frame byte count. */
function boundedJson(value: unknown, maximum: number): boolean {
  let cost = 0, nodes = 0;
  const seen = new Set<object>();
  const visit = (part: unknown, depth: number): boolean => {
    if (++nodes > 4_096 || depth > 16) return false;
    if (part === null || typeof part === 'boolean') cost += 5;
    else if (typeof part === 'number') { if (!Number.isFinite(part)) return false; cost += 24; }
    else if (typeof part === 'string') cost += bytes(part);
    else if (typeof part === 'object') {
      if (seen.has(part)) return false;
      seen.add(part);
      if (!Array.isArray(part) && Object.getPrototypeOf(part) !== Object.prototype && Object.getPrototypeOf(part) !== null) return false;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
        if (Array.isArray(part) && key === 'length') continue;
        if (!('value' in descriptor) || !descriptor.enumerable || bytes(key) > 256) return false;
        cost += bytes(key) + 4;
        if (cost > maximum || !visit(descriptor.value, depth + 1)) return false;
      }
    } else return false;
    return cost <= maximum;
  };
  if (!visit(value, 0)) return false;
  try { return bytes(JSON.stringify(value)) <= maximum; } catch { return false; }
}

function freshTimestamp(value: unknown, nowMs: number): value is string {
  if (typeof value !== 'string' || !/^\d{10}\.\d{6}$/.test(value)) return false;
  const [seconds, micros] = value.split('.');
  const at = BigInt(seconds!) * 1_000_000n + BigInt(micros!);
  const now = BigInt(nowMs) * 1_000n;
  return at >= now - BigInt(P.maxAgeMs) * 1_000n && at <= now + BigInt(P.maxFutureMs) * 1_000n;
}

function channelAllowed(channel: SlackChannelMetadata | null, now: number): boolean {
  return channel != null && channel.id === P.channelId && channel.teamId === P.teamId
    && channel.isMember === true && channel.isArchived === false && channel.isPrivate === false
    && channel.isShared === false && channel.isExtShared === false && channel.isOrgShared === false
    && channel.isPendingExtShared === false && Number.isSafeInteger(channel.observedAt)
    && channel.observedAt <= now && now - channel.observedAt <= P.metadataMaxAgeMs;
}

/** Only fixed contract enum values reach this draft: never raw Slack text, links or mentions. */
export function renderAlertAdvisory(observations: readonly AlertObservation[]): string {
  if (!observations.length || observations.length > P.attachments
    || observations.some(value => !Number.isInteger(value.attachmentIndex) || value.attachmentIndex < 0 || value.attachmentIndex >= P.attachments
      || (value.outcome !== 'exceededCpu' && value.outcome !== 'exceededMemory'))) throw new Error('alert_observation_rejected');
  const outcomes = observations.map(value => value.outcome === 'exceededCpu' ? '`exceededCpu`' : '`exceededMemory`').join(', ');
  return `Frontend resource exhaustion was reported (${outcomes}). Investigation is required. User impact and cause are unconfirmed. `
    + 'The alert is the only available evidence; production-log access is not enabled. '
    + 'Next check: correlate the invocation with retained failure records and an existing incident. No remediation performed.';
}

function inspectAlertEnvelope(envelope: unknown, context: Pick<AlertDecisionContext, 'nowMs' | 'producer'>): AlertDecision {
  if (!context || !Number.isSafeInteger(context.nowMs) || context.nowMs <= 0) return rejected('invalid_clock');
  const { producer, nowMs } = context;
  if (!producer || !slackId(producer.botId, 'B') || !slackId(producer.appId, 'A')
    || producer.botId === P.botId || producer.appId === P.appId) return rejected('unbound_producer');
  if (!boundedJson(envelope, P.rawBytes)) return rejected('raw_size_rejected');
  if (!object(envelope) || envelope.type !== 'events_api' || typeof envelope.envelope_id !== 'string'
    || !/^[A-Za-z0-9-]{1,128}$/.test(envelope.envelope_id) || !object(envelope.payload)) return rejected('envelope_rejected');
  const payload = envelope.payload;
  if (payload.type !== 'event_callback' || !slackId(payload.event_id, 'Ev') || !object(payload.event)) return rejected('envelope_rejected');
  const event = payload.event;
  if (payload.api_app_id !== P.appId || payload.team_id !== P.teamId || event.channel !== P.channelId
    || payload.is_ext_shared_channel !== false
    || ['context_team_id', 'source_team', 'user_team'].some(key => own(payload, key) && payload[key] !== P.teamId)
    || (own(payload, 'enterprise_id') && payload.enterprise_id !== null)
    || ['team', 'source_team', 'user_team'].some(key => own(event, key) && event[key] !== P.teamId)) return rejected('wrong_scope');
  if (own(payload, 'authorizations')) {
    const authorizations = payload.authorizations;
    if (!Array.isArray(authorizations) || authorizations.length !== 1 || !object(authorizations[0])
      || authorizations[0].team_id !== P.teamId || authorizations[0].user_id !== P.botUserId || authorizations[0].is_bot !== true
      || (own(authorizations[0], 'enterprise_id') && authorizations[0].enterprise_id !== null)) return rejected('wrong_scope');
  }
  if (event.bot_id !== producer.botId || event.app_id !== producer.appId || event.user === P.botUserId) return rejected('producer_rejected');
  if (own(event, 'bot_profile')) {
    const profile = event.bot_profile;
    if (!object(profile) || ['id', 'app_id', 'team_id'].some(key => own(profile, key)
      && profile[key] !== ({ id: producer.botId, app_id: producer.appId, team_id: P.teamId } as Record<string, string>)[key])) return rejected('producer_rejected');
  }
  if (event.type !== 'message' || event.channel_type !== 'channel' || event.subtype !== 'bot_message'
    || own(event, 'edited') || own(event, 'hidden') || own(event, 'message') || own(event, 'previous_message')
    || (own(event, 'user') && !slackId(event.user, 'U'))
    || (own(event, 'thread_ts') && event.thread_ts !== event.ts)) return rejected('message_rejected');
  if (!freshTimestamp(event.ts, nowMs) || !freshTimestamp(event.event_ts, nowMs)
    || !Number.isSafeInteger(payload.event_time) || !freshTimestamp(`${payload.event_time}.000000`, nowMs)) return rejected('timestamp_rejected');
  if (!boundedJson(event, P.normalizedBytes)) return rejected('content_size_rejected');
  if (own(event, 'text') && !textWithin(event.text, P.freeTextBytes)) return rejected('content_rejected');
  const leavesWithin = (value: unknown): boolean => typeof value === 'string' ? bytes(value) <= P.freeTextBytes
    : value !== null && typeof value === 'object' ? Object.values(value).every(leavesWithin) : true;
  if (!leavesWithin(event)) return rejected('content_rejected');
  const attachments = own(event, 'attachments') ? event.attachments : [];
  if (!Array.isArray(attachments) || attachments.length > P.attachments) return rejected('content_rejected');
  const observations: AlertObservation[] = [];
  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    if (!object(attachment)) return rejected('content_rejected');
    for (const [key, value] of Object.entries(attachment)) {
      if (typeof value === 'string' && !textWithin(value, key === 'title' ? P.titleBytes : P.freeTextBytes)) return rejected('content_rejected');
    }
    if (own(attachment, 'title') && typeof attachment.title !== 'string') return rejected('content_rejected');
    const fields = own(attachment, 'fields') ? attachment.fields : [];
    if (!Array.isArray(fields) || fields.length > P.fields) return rejected('content_rejected');
    const unique = new Map<string, string>();
    for (const field of fields) {
      if (!object(field) || !textWithin(field.title, P.fieldNameBytes) || !field.title.length
        || !textWithin(field.value, P.fieldValueBytes) || unique.has(field.title)
        || (own(field, 'short') && typeof field.short !== 'boolean')) return rejected('content_rejected');
      unique.set(field.title, field.value);
    }
    if (attachment.title !== '🚨 Error Alert' || unique.get('Event') !== 'runtime_failure' || unique.get('Worker') !== 'frontend') continue;
    const error = unique.get('Error');
    if (error === 'Workers runtime outcome: exceededCpu' || error === 'Workers runtime outcome: exceededMemory') {
      observations.push(Object.freeze({ attachmentIndex: index, outcome: error === 'Workers runtime outcome: exceededCpu' ? 'exceededCpu' : 'exceededMemory' }));
    }
  }
  if (!observations.length) return Object.freeze({ kind: 'suppressed', reason: 'no_eligible_observation' });
  const evidence: AlertEvidence = Object.freeze({ teamId: P.teamId, channelId: P.channelId, eventId: payload.event_id,
    messageTs: event.ts, project: P.project, observations: Object.freeze(observations) });
  const advisory = renderAlertAdvisory(observations);
  if (!boundedJson({ evidence, advisory }, P.normalizedBytes)) return rejected('content_size_rejected');
  return Object.freeze({ kind: 'accepted', evidence, advisory });
}

export type AlertPreflightDecision = { readonly kind: 'candidate' }
  | { readonly kind: 'rejected'; readonly reason: AlertRejectionReason };

/** Before metadata IO: reject malformed/unbound input; retain no message evidence. */
export function preflightAlertEnvelope(envelope: unknown, context: Pick<AlertDecisionContext, 'nowMs' | 'producer'>): AlertPreflightDecision {
  const inspected = inspectAlertEnvelope(envelope, context);
  if (inspected.kind === 'rejected') return inspected;
  // Valid noise still receives actual internal-channel validation before suppression.
  return Object.freeze({ kind: 'candidate' });
}

/** Revalidates the complete event after the host obtains real channel metadata. */
export function decideAlertEnvelope(envelope: unknown, context: AlertDecisionContext): AlertDecision {
  const inspected = inspectAlertEnvelope(envelope, context);
  if (inspected.kind === 'rejected') return inspected;
  if (!channelAllowed(context.channel, context.nowMs)) return rejected('channel_rejected');
  return inspected;
}
