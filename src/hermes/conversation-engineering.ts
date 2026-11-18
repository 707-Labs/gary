/** Ephemeral host authority. This capability is never serialized into a model prompt or tool arguments. */
import type { ProjectAudience, ProjectToolResult } from './project-assistant.ts';

export interface ConversationEngineeringCapability { readonly kind: 'host_conversation_engineering' }
type Submission = (repository: string, signal: AbortSignal, assertActive: () => void) => Promise<ProjectToolResult>;
const capabilities = new WeakMap<object, { audience: Readonly<ProjectAudience>; submit: Submission }>();
const sameAudience = (a: ProjectAudience, b: ProjectAudience) => a.surface === 'private_dm' && b.surface === a.surface
  && a.requesterId === b.requesterId && a.teamId === b.teamId && a.channelId === b.channelId && a.threadTs === b.threadTs;

/** Called by authenticated host ingress only, never from a model-facing RPC. */
export function createConversationEngineeringCapability(audience: ProjectAudience, submit: Submission): ConversationEngineeringCapability {
  if (audience.surface !== 'private_dm') throw new Error('engineering_private_message_required');
  const capability = Object.freeze({ kind: 'host_conversation_engineering' as const });
  capabilities.set(capability, { audience: Object.freeze({ ...audience }), submit });
  return capability;
}
export function hasConversationEngineeringCapability(value: unknown, audience: ProjectAudience): value is ConversationEngineeringCapability {
  const record = value && typeof value === 'object' ? capabilities.get(value) : undefined;
  return !!record && sameAudience(record.audience, audience);
}
export async function submitConversationEngineering(value: unknown, audience: ProjectAudience, repository: unknown,
  signal: AbortSignal | undefined, assertActive: (() => void) | undefined): Promise<ProjectToolResult> {
  if (!hasConversationEngineeringCapability(value, audience) || !signal || !assertActive) return { ok: false, dataOnly: true, error: 'engineering_unavailable' };
  if (typeof repository !== 'string' || !/^707-Labs\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository)) return { ok: false, dataOnly: true, error: 'invalid_arguments' };
  signal.throwIfAborted(); assertActive();
  return capabilities.get(value)!.submit(repository, signal, assertActive);
}

/** Conservative request recognition, not a natural-language authorization oracle.
 * Ambiguity asks the owner to clarify. Only current-message prose supplies intent/scope;
 * quoted material, code, history and model-selected task prose never supply a grant. */
export function ordinaryEngineeringScope(originalText: string): { repository: string } | null {
  if (!originalText.trim() || Buffer.byteLength(originalText) > 16_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(originalText)) return null;
  const prose = originalText.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ').replace(/`[^`\n]*(?:`|$)/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'[^'\n]*'(?!\w)/g, ' ')
    .replace(/<https:\/\/github\.com\/(707-Labs\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:\/[^>|\s]*)?(?:\|[^>]*)?>/gi, '$1')
    .replace(/https:\/\/github\.com\/(707-Labs\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:\/[^\s<>]*)?/gi, '$1')
    .trim();
  // A restriction or hypothetical anywhere in the direct prose makes automatic admission ambiguous.
  if (/\b(?:not|never|don't|don’t|do\s+not|cannot|can't|can’t|won't|won’t|without|unless|if|after|before|once|until|when|whenever|upon|approval|approve|permission|confirmation|later|tomorrow|tonight|morning|afternoon|evening|weekend|sometime|eventually|wait|pending|defer|deferred|postpone|delay|hold|schedule|scheduled|hypothetically|suppose|example|quoted|quote|said|says|suggest|should\s+(?:i|we|you)|would\s+(?:i|we))\b/i.test(prose)
    || /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+(?:week|month|year)|in\s+(?:[\w-]+\s+){0,4}(?:seconds?|minutes?|hours?|days?|weeks?|months?|moments?|secs?|mins?|hrs?|bit|while)|at\s+(?:\d[^\s]*|noon|midnight|dawn|dusk)|on\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|from\s+now|\d{4}-\d{2}-\d{2})\b/i.test(prose)) return null;
  const imperative = /^(?:(?:hey\s+)?gary[,!:]?\s+)?(?:(?:please|can\s+you|could\s+you|would\s+you|i\s+(?:want|need)\s+you\s+to)\s+)?(?:please\s+)?(?:fix|implement|add|update|change|refactor|repair|remove|build|write|test|investigate|debug|improve)\b/i;
  if (!imperative.test(prose)) return null;
  // All explicit org/repo references must agree, including a foreign scope later in the request.
  const references = [...prose.matchAll(/(?:https:\/\/github\.com\/)?\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})\b/g)]
    .map(match => match[1]!.replace(/\.git$/i, ''));
  const repositories = [...new Set(references.filter(value => /^707-Labs\//i.test(value)).map(value => '707-Labs/' + value.split('/')[1]))];
  if (repositories.length !== 1) return null;
  // A file extension cannot distinguish a path from another org/repo name.
  // Quote source paths as code so ambiguous prose never broadens admission.
  if (references.some(value => !/^707-Labs\//i.test(value))) return null;
  // GitHub links to another owner are not silently treated as this repository's authority.
  if (/https:\/\/github\.com\/(?!707-Labs\/)/i.test(prose)) return null;
  return { repository: repositories[0]! };
}
