/** Host-owned engineering model route. Inert until explicitly constructed by the host.
 * The native worker receives neither provider credentials nor spending authority.
 * Request intents are durable and single-use; an ambiguous response fences the task. */
import { assertEngineeringContinuationBaseline, type EngineeringContinuationBaseline } from './engineering-continuation-budget.ts';
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { SpendLedger, spendReservationMicros } from '../spend.ts';
import { createModelTransport } from './model-transport.ts';
import { assertEngineeringRequestAllowed, engineeringAcceptancePolicySha256,
  type EngineeringTaskPolicy, type EngineeringRequestAttempt, type EngineeringRequestRole } from './engineering-policy.ts';
import { EngineeringProtocol, type EngineeringProtocolBinding } from './engineering-protocol.ts';
import { fingerprintJson } from './audit-trace.ts';
import { canonicalizeConversation, sameConversation, type ConversationMessage } from './conversation.ts';

type Json = Record<string, unknown>;
interface RequestRow { request_id: string; role: EngineeringRequestRole; max_tokens: number;
  state: 'in_flight' | 'settled' | 'unknown'; ledger_attempt: number | null; receipt_hash: string | null }
interface LedgerRow { id: number; ticket_id: string; provider: string; model: string; max_tokens: number;
  reserved_micros: number; charged_micros: number; state: string; reason: string | null; details_json: string | null }
export interface EngineeringModelOptions {
  binding: EngineeringProtocolBinding;
  policy: EngineeringTaskPolicy;
  allocationId: string;
  continuationBaseline?: EngineeringContinuationBaseline;
  ledger: SpendLedger;
  /** Dedicated engineering state, opened by the trusted host; never a worker path. */
  journalDb: Database;
  /** Read access to the SAME canonical spend database backing ledger. */
  spendDb: Database;
  protocol: EngineeringProtocol;
  /** Exact host-reviewed native schemas and host-owned system message. */
  tools: readonly Json[];
  systemPrompt: string;
  providerApiKey: string;
  fetch(request: Request): Promise<Response>;
  assertOwner(): void;
  fence(reason: string): void;
}
export interface EngineeringModelAdapter {
  /** Host-derived launcher limits; worker arguments never select a policy. */
  readonly nativeLimits: Readonly<{ policyVersion: 1 | 2; model: 'deepseek-v4-pro'; maxIterations: number; maxTokens: number }>;
  beginTurn(turn: { turnId: string; prompt: string; history?: readonly ConversationMessage[] }): void;
  handle(body: unknown, signal: AbortSignal): Promise<{ status: number; body: Json }>;
  /** Called only AFTER EngineeringProtocol accepted the corresponding tool.end frame. */
  observeToolResult(toolCallId: string, resultHash: string): void;
  finishTurn(messages: unknown): readonly ConversationMessage[];
  history(): readonly ConversationMessage[];
  /** Fresh independent context, zero tools, exactly one 4090-token review request. */
  review(input: { prompt: string; systemPrompt: string; signal: AbortSignal }): Promise<{ status: number; body: Json }>;
  attempts(): readonly EngineeringRequestAttempt[];
}
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string): never { throw new Error('engineering_model:' + code); }
const hash = (v: unknown) => fingerprintJson(v).sha256;
const copy = <T>(v: T): T => { fingerprintJson(v); return structuredClone(v); };

export function createEngineeringModelAdapter(input: EngineeringModelOptions): EngineeringModelAdapter {
  const options = { ...input, binding: Object.freeze({ ...input.binding }), tools: copy(input.tools) };
  const { binding, ledger, journalDb: db, spendDb, policy, allocationId } = options;
  const LIMITS = policy.acceptance;
  if (!(ledger instanceof SpendLedger) || ledger.databasePath !== spendDb.filename || policy.taskId !== binding.taskId
      || hash(options.protocol.binding) !== hash(binding) || !options.systemPrompt.trim()
      || Buffer.byteLength(options.systemPrompt) > 262_144 || options.tools.length > 64) fail('configuration');
  const names = options.tools.map(tool => {
    if (tool.type !== 'function' || !object(tool.function) || typeof tool.function.name !== 'string'
        || !object(tool.function.parameters)) fail('tool_schema');
    return tool.function.name;
  });
  if (new Set(names).size !== names.length) fail('tool_schema');
  const baseline = options.continuationBaseline;
  if (LIMITS.version === 2 ? (!baseline || baseline.baselineAttemptCount !== 6
      || baseline.baselineChargedMicros !== 232_012
      || baseline.budgetPolicySha256 !== engineeringAcceptancePolicySha256(2))
    : (baseline && (baseline.baselineAttemptCount !== 3 || baseline.budgetPolicySha256 !== undefined))) fail('policy_baseline_binding');
  if (baseline) assertEngineeringContinuationBaseline(baseline, spendDb, db, allocationId);
  const ownerToken = randomUUID();
  db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS engineering_model_owners (
      allocation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      owner_epoch TEXT NOT NULL, owner_token TEXT NOT NULL, policy_hash TEXT NOT NULL, fenced INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS engineering_model_requests (
      request_id TEXT PRIMARY KEY, allocation_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL,
      max_tokens INTEGER NOT NULL, state TEXT NOT NULL, request_hash TEXT NOT NULL,
      ledger_attempt INTEGER UNIQUE, receipt_hash TEXT, response_hash TEXT);`);
  if ((db.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous !== 2) fail('journal_not_durable');
  const baselineCount = baseline?.baselineAttemptCount ?? 0;
  const baselineCharged = baseline?.baselineChargedMicros ?? 0;
  if (baseline) db.exec('CREATE TABLE IF NOT EXISTS engineering_model_baselines(allocation_id TEXT PRIMARY KEY,receipt_hash TEXT NOT NULL,attempt_count INTEGER NOT NULL,charged_micros INTEGER NOT NULL)');
  const status = ledger.status(allocationId);
  if (!status || status.capMicros !== LIMITS.capMicros || status.campaignCapMicros !== LIMITS.capMicros
      || (baseline && status.campaignId !== baseline.campaignId) || status.state !== 'active' || status.terminalReason !== null || status.attemptCount !== baselineCount || status.chargedMicros !== baselineCharged
      || status.unknownAttempts !== 0 || (policy.publication === 'draft_pr' && !status.draftPr)
      || ledger.hasCodingReviewReserve(allocationId)) fail('allocation_binding');
  // One construction claims one owner permanently. Recovery never reopens this row.
  db.transaction(() => {
    options.assertOwner();
    if (db.query('SELECT 1 FROM engineering_model_owners WHERE allocation_id=? OR task_id=?').get(allocationId, binding.taskId)) fail('owner_already_claimed');
    if ((spendDb.query('SELECT count(*) n FROM spend_attempts WHERE ticket_id=?').get(allocationId) as { n: number }).n !== baselineCount) fail('ledger_binding');
    if (baseline) {
      assertEngineeringContinuationBaseline(baseline, spendDb, db, allocationId);
      db.query('INSERT INTO engineering_model_baselines VALUES(?,?,?,?)').run(allocationId, baseline.receiptSha256, baselineCount, baselineCharged);
    }
    db.query('INSERT INTO engineering_model_owners VALUES(?,?,?,?,?,?,0)').run(allocationId, binding.taskId,
      binding.sessionId, binding.ownerEpoch, ownerToken, policy.fingerprint);
  }).immediate();
  let busy = false, fenced = false, turnId = '', completedTurn = true, turnRequests = 0;
  let transcript: ConversationMessage[] = [];
  const pending = new Map<string, string | null>(), seenCalls = new Set<string>();
  const rows = (): RequestRow[] => db.query<RequestRow, [string]>(
    'SELECT request_id,role,max_tokens,state,ledger_attempt,receipt_hash FROM engineering_model_requests WHERE allocation_id=? ORDER BY rowid').all(allocationId);
  const attempts = () => rows().map(r => Object.freeze({ requestId: r.request_id, role: r.role, maxTokens: r.max_tokens, state: r.state }));
  const guard = () => {
    if (fenced || Date.now() >= binding.deadlineMs) fail('inactive');
    options.assertOwner();
    if (baseline) {
      assertEngineeringContinuationBaseline(baseline, spendDb, db, allocationId);
      const persisted = db.query('SELECT receipt_hash,attempt_count,charged_micros FROM engineering_model_baselines WHERE allocation_id=?').get(allocationId) as {receipt_hash:string;attempt_count:number;charged_micros:number}|null;
      if (!persisted || persisted.receipt_hash !== baseline.receiptSha256 || persisted.attempt_count !== baselineCount || persisted.charged_micros !== baselineCharged) fail('baseline_changed');
    }
    const row = db.query('SELECT owner_token,fenced FROM engineering_model_owners WHERE allocation_id=?').get(allocationId) as { owner_token: string; fenced: number } | null;
    if (!row || row.owner_token !== ownerToken || row.fenced) fail('owner_changed');
  };
  const fence = (reason: string) => {
    fenced = true;
    try { db.query('UPDATE engineering_model_owners SET fenced=1 WHERE allocation_id=? AND owner_token=?').run(allocationId, ownerToken); }
    finally { options.fence(reason); }
  };
  const receipt = (id: number): LedgerRow | null => spendDb.query<LedgerRow, [number]>(
    `SELECT a.*,r.reason,r.details_json FROM spend_attempts a LEFT JOIN spend_receipts r ON r.attempt_id=a.id WHERE a.id=?`).get(id);
  async function dispatch(body: Json, role: EngineeringRequestRole, signal: AbortSignal, requestTurn: string) {
    guard(); signal.throwIfAborted();
    const maxTokens = role === 'review' ? LIMITS.review.maxTokens : LIMITS.work.maxTokens;
    const requestId = randomUUID(), before = ledger.status(allocationId)!;
    const prior = rows();
    if (before.capMicros !== LIMITS.capMicros || before.campaignCapMicros !== LIMITS.capMicros
        || before.attemptCount !== baselineCount + prior.length || prior.some(r => r.state !== 'settled')) fail('ledger_history');
    const assertPrior = (currentAttempt: number | null = null) => {
      const canonicalIds = spendDb.query<{id:number},[string]>('SELECT id FROM spend_attempts WHERE ticket_id=? ORDER BY id').all(allocationId).slice(baselineCount);
      if (canonicalIds.length !== prior.length + (currentAttempt === null ? 0 : 1)
          || hash(rows().slice(0,prior.length)) !== hash(prior)
          || canonicalIds.slice(0,prior.length).some((r,i) => r.id !== prior[i]?.ledger_attempt)
          || (currentAttempt !== null && canonicalIds.at(-1)?.id !== currentAttempt)
          || prior.some(r => r.ledger_attempt === null || hash(receipt(r.ledger_attempt)) !== r.receipt_hash)) fail('ledger_history');
    };
    assertPrior();
    assertEngineeringRequestAllowed(policy, { requestId, role, maxTokens }, { attempts: attempts(),
      allocationActive: before.state === 'active' && before.terminalReason === null,
      taskRemainingMicros: before.remainingMicros, campaignRemainingMicros: before.campaignCapMicros - before.campaignChargedMicros,
      unresolvedAttempts: before.unknownAttempts });
    db.transaction(() => {
      guard();
      if (rows().length !== prior.length) fail('concurrent_request');
      db.query('INSERT INTO engineering_model_requests VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL)')
        .run(requestId, allocationId, requestTurn, role, maxTokens, 'in_flight', hash(body));
    }).immediate();
    let ledgerAttempt: number | null = null;
    const token = randomUUID();
    try {
      const transport = createModelTransport({ ledger, capability: { ticketId: allocationId, ownerId: binding.ownerEpoch,
        provider: 'deepseek', model: 'deepseek-v4-pro', deadlineMs: binding.deadlineMs,
        allowedToolNames: role === 'review' ? [] : names, signal }, bearerToken: token,
        providerApiKey: options.providerApiKey, thinking: 'disabled', assertOwner: guard,
        fetch: async request => {
          guard(); signal.throwIfAborted();
          const unresolved = ledger.unresolvedAttempts(allocationId);
          if (ledgerAttempt !== null || unresolved.length !== 1 || unresolved[0]!.state !== 'reserved') fail('physical_request_replay');
          ledgerAttempt = unresolved[0]!.id;
          const row = receipt(ledgerAttempt);
          if (!row || row.ticket_id !== allocationId || row.provider !== 'deepseek' || row.model !== 'deepseek-v4-pro'
              || row.max_tokens !== maxTokens || row.reserved_micros !== spendReservationMicros('deepseek', maxTokens)
              || row.state !== 'reserved' || row.reason !== null) fail('reservation_binding');
          const reservedStatus = ledger.status(allocationId)!;
          const reviewFloor = role !== 'review' && !prior.some(r => r.role === 'review') ? LIMITS.review.reservationMicros : 0;
          if (reservedStatus.attemptCount !== baselineCount + prior.length + 1
              || reservedStatus.chargedMicros !== before.chargedMicros + row.reserved_micros
              || reservedStatus.remainingMicros < reviewFloor
              || reservedStatus.campaignCapMicros - reservedStatus.campaignChargedMicros < reviewFloor) fail('reservation_headroom');
          assertPrior(ledgerAttempt);
          // Durable link to the canonical reservation BEFORE the physical network call.
          const changed = db.query('UPDATE engineering_model_requests SET ledger_attempt=? WHERE request_id=? AND state=\'in_flight\' AND ledger_attempt IS NULL').run(ledgerAttempt, requestId);
          if (changed.changes !== 1) fail('reservation_binding');
          guard(); return options.fetch(request);
        } });
      const response = await ledger.withReservationGuard(reservation => {
        guard(); signal.throwIfAborted();
        assertPrior();
        const current = reservation.status;
        if (reservation.ticketId !== allocationId || reservation.provider !== LIMITS.provider || reservation.model !== LIMITS.model
            || reservation.maxTokens !== maxTokens || current.attemptCount !== baselineCount + prior.length
            || current.chargedMicros !== before.chargedMicros) fail('reservation_history');
        // This check and the canonical insertion share the SAME SQLite writer lock.
        assertEngineeringRequestAllowed(policy, { requestId, role, maxTokens }, { attempts: prior.map(r => ({requestId:r.request_id,role:r.role,maxTokens:r.max_tokens,state:r.state})),
          allocationActive: current.state === 'active' && current.terminalReason === null,
          taskRemainingMicros: current.remainingMicros, campaignRemainingMicros: current.campaignCapMicros-current.campaignChargedMicros,
          unresolvedAttempts: current.unknownAttempts });
      }, () => ledger.withPaidRequestGuard(guard, () => transport(new Request('https://gary.invalid/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal }))));
      guard(); signal.throwIfAborted();
      const result = await response.json() as Json;
      if (!response.ok || ledgerAttempt === null) fail('transport_failed');
      assertPrior(ledgerAttempt);
      const row = receipt(ledgerAttempt), after = ledger.status(allocationId)!;
      if (!row || row.ticket_id !== allocationId || row.max_tokens !== maxTokens || row.state !== 'settled'
          || row.reason !== 'accepted' || row.details_json === null || after.attemptCount !== baselineCount + prior.length + 1
          || after.unknownAttempts !== 0 || after.chargedMicros - before.chargedMicros !== row.charged_micros) fail('receipt_unresolved');
      guard();
      const changed = db.query('UPDATE engineering_model_requests SET state=\'settled\',receipt_hash=?,response_hash=? WHERE request_id=? AND state=\'in_flight\' AND ledger_attempt=?')
        .run(hash(row), hash(result), requestId, ledgerAttempt);
      if (changed.changes !== 1) fail('receipt_persistence');
      return { status: response.status, body: result };
    } catch {
      try { db.query('UPDATE engineering_model_requests SET state=\'unknown\' WHERE request_id=?').run(requestId); }
      finally { fence('model_request_unresolved'); }
      fail('request_failed');
    }
  }
  function acceptHistory(value: unknown): ConversationMessage[] {
    const actual = canonicalizeConversation(value);
    if (!sameConversation(transcript, actual.slice(0, transcript.length))) fail('history_changed');
    const added = actual.slice(transcript.length);
    if (added.length !== pending.size) fail('tool_results_missing');
    const consumed = new Set<string>();
    for (const message of added) {
      const id = message.tool_call_id;
      if (message.role !== 'tool' || typeof id !== 'string' || consumed.has(id)
          || !pending.get(id) || hash(message.content) !== pending.get(id)) fail('tool_result_changed');
      consumed.add(id);
    }
    pending.clear(); transcript = actual; return actual;
  }
  return {
    nativeLimits: Object.freeze({ policyVersion: policy.acceptance.version, model: policy.acceptance.model,
      maxIterations: policy.acceptance.work.maxRequests, maxTokens: policy.acceptance.work.maxTokens }),
    beginTurn(turn) {
      guard();
      if (busy || !completedTurn || pending.size || !turn.prompt.trim() || Buffer.byteLength(turn.prompt) > 262_144) fail('turn_not_ready');
      if (turn.history !== undefined && !sameConversation(transcript, canonicalizeConversation(turn.history))) fail('history_changed');
      options.protocol.observeTurn(turn.turnId); turnId = turn.turnId;
      transcript.push({ role: 'user', content: turn.prompt }); completedTurn = false; turnRequests = 0;
    },
    async handle(raw, signal) {
      guard();
      if (busy || !turnId || completedTurn) fail('concurrent_or_inactive_turn');
      busy = true;
      try {
        const body = copy(raw);
        if (!object(body) || Object.keys(body).some(k => !['model','messages','tools','max_tokens','stream','temperature','tool_choice','parallel_tool_calls'].includes(k))
            || body.model !== LIMITS.model || body.max_tokens !== LIMITS.work.maxTokens || body.stream !== false
            || body.temperature !== 0.3 || (body.tool_choice !== undefined && body.tool_choice !== 'auto')
            || (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false)
            || hash(body.tools) !== hash(options.tools) || !Array.isArray(body.messages)
            || hash(body.messages[0]) !== hash({ role: 'system', content: options.systemPrompt })) fail('request_binding');
        acceptHistory(body.messages.slice(1));
        const result = await dispatch(body, 'work', signal, turnId);
        const choices = result.body.choices;
        if (!Array.isArray(choices) || choices.length !== 1 || !object(choices[0]) || !object(choices[0].message)) fail('response_binding');
        const message = choices[0].message;
        const next = canonicalizeConversation([...transcript, message], { requireResolved: false });
        for (const rawCall of (message.tool_calls ?? []) as Json[]) {
          const call = rawCall as { id: string; function: { name: string; arguments: string } };
          if (seenCalls.has(call.id)) fail('tool_call_replay');
          options.protocol.observeToolCall({ turnId, toolCallId: call.id, toolName: call.function.name, originalArgs: JSON.parse(call.function.arguments) });
          seenCalls.add(call.id); pending.set(call.id, null);
        }
        transcript = next; completedTurn = pending.size === 0; turnRequests++;
        return result;
      } catch (e) { if (!fenced) fence('model_context_rejected'); throw e; }
      finally { busy = false; }
    },
    observeToolResult(id, resultHash) {
      guard(); if (!pending.has(id) || pending.get(id) !== null || !/^[a-f0-9]{64}$/.test(resultHash)) fail('tool_result_binding');
      pending.set(id, resultHash);
    },
    finishTurn(messages) {
      guard(); if (busy || turnRequests === 0) fail('turn_without_model_result');
      acceptHistory(messages); completedTurn = true; return copy(transcript);
    },
    history: () => copy(transcript), attempts,
    async review({ prompt, systemPrompt, signal }) {
      guard(); if (busy || pending.size || !completedTurn || !prompt.trim() || !systemPrompt.trim()) fail('review_not_ready');
      busy = true;
      try { return await dispatch({ model: LIMITS.model, messages: [{ role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }], max_tokens: LIMITS.review.maxTokens, stream: false, temperature: 0.3 },
        'review', signal, 'independent-review'); }
      finally { busy = false; }
    },
  };
}
