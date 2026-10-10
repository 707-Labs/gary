/** Conversation access to the existing controller. No dispatch, enrollment or stop reset. */
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { CODING_SPEND_RESERVE_POLICY, spendReservationMicros, type SpendLedger, type SpendStatus } from '../spend.ts';
import { HERMES_CODING_RUNTIME_POLICY } from './coding-runtime-policy.ts';
import { readRuntimeDiagnostic } from './runtime-diagnostics.ts';
import type { ProjectIntegrationBinding } from './project-integrations.ts';
import type { WorkProject } from './work-context.ts';

export interface ConversationControllerRuntime {
  loopState: 'disabled' | 'idle' | 'polling' | 'stopped';
  /** Host lifetime/route readiness, distinct from publication readiness. */
  dispatchReady: boolean;
}
export interface ConversationControllerOptions {
  db: Database;
  ledger: Pick<SpendLedger, 'status' | 'canDispatch' | 'hasCodingReviewReserve'>;
  teamId: string; ownerUserId: string;
  projects: readonly (WorkProject & { sharedChannelIds: readonly string[] })[];
  activation?: { issueId: string; repo: string; policyFingerprint: string; allowedActionTypes: ReadonlySet<string> };
  runtime(): ConversationControllerRuntime;
  /** Wake only the existing serial loop; true acknowledges the wake, not dispatch. */
  wake?: () => boolean;
}
type Ticket = { linear_id: string; identifier: string; terminal_state: string | null;
  classification: string | null; classification_confidence: number | null; classification_scope: string | null };
type Action = { id: number; action_type: string; completed_at: string | null; success: number | null;
  outcome: string; started_at: string; error_message: string | null; owner_action: number | null };
type Trial = { phase: string; policy_fingerprint: string; campaign_id: string; cap_micros: number;
  classify_action: number; code_action: number | null; confidence: number | null; scope: string | null };
const OUTCOMES = new Set(['unknown','handled','pr_opened','no_changes','agent_failed','blocked','timeout',
  'check_failed','review_failed','escalated','rate_limited','budget_exhausted','error']);
const ACTIONS = new Set(['classify','start_coding','fix_ci_failure','respond_to_pr_review','pickup_ticket',
  'revisit_code','wait_for_blocker','answer_mention','write_answer','bounce','nudge_reviewer']);
const finite = (value: string | null) => value !== null && /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : null;
const time = (value: string | null) => value && value.length <= 32 && /^\d{4}-\d{2}-\d{2}[T ][\d:.+-]+Z?$/.test(value) ? value : null;
function diagnostic(raw: string | null) {
  const prefix = 'coding trial stopped; diagnostic=';
  if (!raw?.startsWith(prefix) || raw.length > 2048) return null;
  try { return readRuntimeDiagnostic(JSON.parse(raw.slice(prefix.length))) ?? null; } catch { return null; }
}
function allocation(status: SpendStatus | null, ledger: ConversationControllerOptions['ledger'], issueId: string) {
  if (!status) return null;
  const codingReviewReserve = ledger.hasCodingReviewReserve(issueId);
  const minimumCodingHeadroom = spendReservationMicros('deepseek') + CODING_SPEND_RESERVE_POLICY.workFloorMicros;
  return { state: status.state, terminalReason: finite(status.terminalReason), capMicros: status.capMicros,
    chargedMicros: status.chargedMicros, remainingMicros: status.remainingMicros,
    unresolvedAttempts: status.unknownAttempts, attemptCount: status.attemptCount,
    codingReviewReserve, nextRequestFits: ledger.canDispatch(issueId),
    nextCodingRequestPreservesReserve: codingReviewReserve && status.remainingMicros >= minimumCodingHeadroom
      && status.campaignCapMicros - status.campaignChargedMicros >= minimumCodingHeadroom,
    meaning: 'Existing issue allocation; reservations and campaign headroom are rechecked by the controller before every paid request.' };
}

export function createConversationController(options: ConversationControllerOptions) {
  const { db, ledger } = options;
  const registry = new Map(options.projects.map(p => [p.id, Object.freeze({ ...p, sharedChannelIds: [...p.sharedChannelIds] })]));
  const activation = options.activation && Object.freeze({ ...options.activation, allowedActionTypes: new Set(options.activation.allowedActionTypes) });
  if (registry.size !== options.projects.length || options.projects.some(p => !/^707-Labs\/[a-z0-9-]+$/.test(p.repo)
    || !/^[A-Z][A-Z0-9]{1,15}$/.test(p.teamKey))) throw new Error('controller_registry_rejected');
  const read = (ticket: Ticket, project: WorkProject, runtime: ConversationControllerRuntime) => {
    const action = db.query<Action, [string]>(`SELECT a.id,a.action_type,a.completed_at,a.started_at,a.success,a.outcome,a.error_message,
      o.action_id AS owner_action FROM actions a LEFT JOIN hermes_action_owners o ON o.action_id=a.id
      WHERE a.ticket_linear_id=? ORDER BY a.id DESC LIMIT 1`).get(ticket.linear_id);
    const trial = db.query<Trial, [string]>('SELECT phase,policy_fingerprint,campaign_id,cap_micros,classify_action,code_action,confidence,scope FROM hermes_coding_trials WHERE issue_id=?').get(ticket.linear_id);
    const spend = ledger.status(ticket.linear_id);
    const budget = allocation(spend, ledger, ticket.linear_id);
    const unfinished = !!db.query<{ n: number }, [string]>('SELECT count(*) n FROM actions WHERE ticket_linear_id=? AND completed_at IS NULL').get(ticket.linear_id)?.n;
    const anotherOwner = !!db.query<{ n: number }, []>(`SELECT count(*) n FROM hermes_action_owners o LEFT JOIN actions a ON a.id=o.action_id WHERE a.id IS NULL OR a.completed_at IS NULL`).get()?.n;
    const anotherTrial = !!db.query<{ n: number }, [string]>("SELECT count(*) n FROM hermes_coding_trials WHERE issue_id<>? AND phase<>'closed'").get(ticket.linear_id)?.n;
    let blockedReason: string | null = null;
    if (ticket.terminal_state !== null) blockedReason = 'ticket_terminal';
    else if (trial?.phase === 'closed') blockedReason = 'trial_closed';
    else if (!activation) blockedReason = 'controller_not_activated';
    else if (activation.issueId !== ticket.linear_id || activation.repo !== project.repo) blockedReason = 'outside_current_admission';
    else if (trial && trial.policy_fingerprint !== activation.policyFingerprint) blockedReason = 'trial_policy_changed';
    else if (!spend) blockedReason = 'allocation_not_enrolled';
    else if (spend.state !== 'active') blockedReason = 'allocation_' + spend.state;
    else if (spend.unknownAttempts !== 0) blockedReason = 'unresolved_spend';
    else if (!spend.draftPr || !budget!.codingReviewReserve || spend.capMicros > HERMES_CODING_RUNTIME_POLICY.maxAllocationMicros) blockedReason = 'allocation_policy_mismatch';
    else if (trial && (trial.campaign_id !== spend.campaignId || trial.cap_micros !== spend.capMicros)) blockedReason = 'trial_allocation_changed';
    else if (!budget!.nextRequestFits) blockedReason = 'insufficient_reserved_headroom';
    else if (!budget!.nextCodingRequestPreservesReserve) blockedReason = 'protected_coding_reserve_would_be_consumed';
    else if (unfinished || trial?.phase === 'coding' || trial?.phase === 'classifying') blockedReason = 'unfinished_action_not_reclaimable';
    else if (anotherOwner) blockedReason = 'unfinished_canonical_owner';
    else if (anotherTrial) blockedReason = 'other_trial_unfinished';
    else if (!trial && (ticket.classification !== null || action)) blockedReason = 'already_attempted_without_current_trial';
    else if (trial && (trial.phase !== 'classified' || trial.code_action !== null || action?.id !== trial.classify_action
      || action.success !== 1 || action.outcome !== 'handled' || !action.completed_at || ticket.classification !== 'CODE'
      || ticket.classification_confidence !== trial.confidence || ticket.classification_scope !== trial.scope)) blockedReason = 'classification_changed_or_consumed';
    else if (!activation.allowedActionTypes.has(trial ? 'start_coding' : 'classify')) blockedReason = 'action_not_admitted';
    else if (runtime.loopState === 'disabled' || runtime.loopState === 'stopped' || !runtime.dispatchReady) blockedReason = 'controller_not_ready';
    return { ticket: ticket.identifier, source: 'gary_canonical_database_and_existing_spend_ledger',
      terminalState: finite(ticket.terminal_state), trialPhase: trial && ['classifying','classified','coding','closed'].includes(trial.phase) ? trial.phase : null,
      latestAction: action ? { id: action.id, type: ACTIONS.has(action.action_type) ? action.action_type : 'unknown',
        outcome: OUTCOMES.has(action.outcome) ? action.outcome : 'unknown', success: action.success === 1 ? true : action.success === 0 ? false : null,
        startedAt: time(action.started_at), completedAt: time(action.completed_at), recordedOwner: action.owner_action !== null,
        diagnostic: diagnostic(action.error_message) } : null,
      workerState: unfinished ? 'unfinished_record_liveness_unknown' : 'not_observed',
      budget, admission: { matchesCurrentIssue: activation?.issueId === ticket.linear_id && activation.repo === project.repo,
        handoffEligible: blockedReason === null, blockedReason,
        note: 'Eligibility is a local preflight. The existing loop still verifies current assignment, blockers, human signature, action cache and exact budget; no work is promised.' } };
  };
  return async (binding: ProjectIntegrationBinding, request: Readonly<{ operation: 'status' | 'handoff'; ticket?: string; requestId: string }>, signal?: AbortSignal) => {
    const cancelled = () => { if (signal?.aborted) throw new Error('operation_cancelled'); };
    cancelled();
    const project = registry.get(binding.projectId), a = binding.audience;
    if (!project || project.repo !== binding.repo || project.teamKey !== binding.teamKey || a.teamId !== options.teamId
      || (a.surface === 'private_dm' ? a.requesterId !== options.ownerUserId : a.surface !== 'shared_channel' || !project.sharedChannelIds.includes(a.channelId))) throw new Error('controller_scope_denied');
    if (!['status','handoff'].includes(request.operation) || (request.ticket !== undefined && !new RegExp('^' + project.teamKey + '-[0-9]+$').test(request.ticket))) throw new Error('invalid_arguments');
    if (request.operation === 'handoff' && (a.requesterId !== options.ownerUserId || !request.ticket)) throw new Error('controller_handoff_denied');
    const runtime = options.runtime();
    if (!['disabled','idle','polling','stopped'].includes(runtime.loopState) || typeof runtime.dispatchReady !== 'boolean') throw new Error('controller_state_unavailable');
    const tickets = request.ticket
      ? db.query<Ticket, [string]>('SELECT linear_id,identifier,terminal_state,classification,classification_confidence,classification_scope FROM tickets WHERE identifier=? LIMIT 2').all(request.ticket)
      : db.query<Ticket, [string]>(`SELECT linear_id,identifier,terminal_state,classification,classification_confidence,classification_scope FROM tickets WHERE identifier LIKE ? ORDER BY last_polled_at DESC,identifier LIMIT 25`).all(project.teamKey + '-%');
    if (request.ticket && tickets.length > 1) throw new Error('controller_ticket_ambiguous');
    const items = tickets.filter(t => new RegExp('^' + project.teamKey + '-[0-9]+$').test(t.identifier)).slice(0,24).map(t => read(t,project,runtime));
    const common = { observedAt: new Date().toISOString(), project: project.id, runtime,
      runtimeMeaning: 'Current host poll-loop readiness, not worker liveness or publication approval.', items,
      truncated: tickets.length > 24 };
    if (request.operation === 'status') return { ...common, status: 'observed' };
    const item = items[0], ticket = tickets[0];
    if (!item || !ticket) return { ...common, status: 'blocked', reason: 'ticket_not_recorded_in_controller',
      note: 'No existing canonical admission could be established for this ticket. No enrollment or retry was created.' };
    if (item.admission.blockedReason) return { ...common, status: 'blocked', reason: item.admission.blockedReason };
    if (!options.wake) return { ...common, status: 'blocked', reason: 'controller_wake_unavailable' };
    if (typeof request.requestId !== 'string' || request.requestId.length < 1 || request.requestId.length > 512) throw new Error('invalid_arguments');
    cancelled();
    const key = createHash('sha256').update(JSON.stringify([a.teamId,a.surface,a.requesterId,a.channelId,a.threadTs,project.id,ticket.linear_id,request.requestId])).digest('hex');
    const payload = JSON.stringify({ version: 1, key, issueId: ticket.linear_id, project: project.id, intent: 'reconsider_on_existing_poll_loop' });
    db.exec('PRAGMA synchronous=FULL');
    if (db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous !== 2) throw new Error('controller_receipt_durability_unavailable');
    // Existing event log is an intent receipt only. The canonical action/owner and
    // trial fences still decide dispatch. No new queue, allocation or retry owner.
    const recorded = db.transaction(() => {
      const old = db.query<{ id: number }, [string,string]>("SELECT id FROM events WHERE ticket_linear_id=? AND event_type='conversation_controller_handoff' AND payload_json=? LIMIT 1").get(ticket.linear_id,payload);
      if (old) return { id: old.id, duplicate: true };
      const result = db.query("INSERT INTO events(ticket_linear_id,event_type,payload_json) VALUES(?,'conversation_controller_handoff',?)").run(ticket.linear_id,payload);
      return { id: Number(result.lastInsertRowid), duplicate: false };
    }).immediate();
    if (recorded.duplicate) return { ...common, status: 'reconsideration_already_recorded', receiptId: recorded.id,
      note: 'An intent was already recorded. This does not establish dispatch; inspect status for the actual action.' };
    const accepted = options.wake();
    return { ...common, status: accepted ? 'reconsideration_requested' : 'blocked', receiptId: recorded.id,
      ...(accepted ? {} : { reason: 'controller_stopped_before_wake' }),
      note: 'Only the existing poll loop was notified. No action was queued or started by this tool, and no stop or allocation was changed.' };
  };
}
