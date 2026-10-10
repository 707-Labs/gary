/** Native-tool protocol for an already-owned engineering session. No launcher or default activation.
 * A trusted model transport registers observed calls; worker frames cannot invent calls/authority.
 * The transport capability is out-of-band, never put in model schemas or frame logs. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fingerprintJson } from './audit-trace.ts';

export interface EngineeringProtocolBinding { taskId: string; sessionId: string; ownerEpoch: string; deadlineMs: number }
export interface EngineeringProtocolReceipt {
  id: string; taskId: string; sessionId: string; ownerEpoch: string; turnId: string;
  kind: string; callId: string | null; digest: string;
}
export interface EngineeringProtocolOptions {
  binding: EngineeringProtocolBinding;
  transportCapability: string;
  allowedTools: readonly string[];
  assertOwner(): void;
  /** append must durably record BEFORE returning. It must not store model text or commands. */
  append(receipt: Readonly<EngineeringProtocolReceipt>): void;
  execute(operation: string, args: Readonly<Record<string, unknown>>, context: {
    toolCallId: string; admissionId: string; toolName: string;
    originalArgs: Readonly<Record<string, unknown>>;
  }): Promise<Record<string, unknown>>;
  close(): Promise<{ cleanupConfirmed: boolean }>;
  fence(reason: string): void;
  now?: () => number;
  /** Trusted pinned-native normalization only. Default requires unchanged arguments. */
  normalizeArguments?: (name: string, args: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /** Host-selected native postprocessing contract; raw remains compatible with older fixtures. */
  resultPresentation?: 'native_batch';
}
export interface ObservedNativeToolCall { turnId: string; toolCallId: string; toolName: string; originalArgs: Record<string, unknown> }
interface ActiveCall extends ObservedNativeToolCall { admissionId: string; operationReceipts: string[]; operations: Set<string> }
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const OPERATIONS = new Set(['execute', 'poll', 'cancel', 'write', 'close']);
function fail(code: string): never { throw new Error('engineering_protocol:' + code); }
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)); }
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, 'value'))) fail('shape');
}
function validId(value: unknown): asserts value is string { if (typeof value !== 'string' || !ID.test(value)) fail('identity'); }
function snapshot<T>(value: T): T {
  if (fingerprintJson(value).bytes > 2 * 1024 * 1024) fail('frame_too_large');
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(copy); return copy;
}

export class EngineeringProtocol {
  readonly binding: Readonly<EngineeringProtocolBinding>;
  readonly resultPresentation: 'raw' | 'native_batch';
  private readonly options: EngineeringProtocolOptions;
  private readonly observed = new Map<string, ObservedNativeToolCall>();
  private readonly consumed = new Set<string>();
  private readonly turns = new Set<string>();
  private active: ActiveCall | null = null;
  private turnId = '';
  private sequence = 0;
  private busy = false;
  private fenced = false;
  private closed = false;
  private operationCount = 0;
  private readonly operationIds = new Set<string>();
  private readonly processOwners = new Map<string, string>();
  private readonly presentations = new Map<string, { turnId: string; admissionId: string; rawResultHash: string }>();
  constructor(options: EngineeringProtocolOptions) {
    this.options = { ...options, allowedTools: Object.freeze([...options.allowedTools]) };
    this.binding = snapshot(options.binding);
    if (options.resultPresentation !== undefined && options.resultPresentation !== 'native_batch') fail('configuration');
    this.resultPresentation = options.resultPresentation ?? 'raw';
    for (const value of [this.binding.taskId, this.binding.sessionId, this.binding.ownerEpoch]) validId(value);
    if (!Number.isSafeInteger(this.binding.deadlineMs) || options.transportCapability.length < 32
        || !options.allowedTools.length || options.allowedTools.length > 64) fail('configuration');
    options.allowedTools.forEach(validId);
  }
  private live(): void {
    if (this.closed || this.fenced || (this.options.now ?? Date.now)() >= this.binding.deadlineMs) fail('inactive');
    this.options.assertOwner();
  }
  private record(kind: string, callId: string | null, value: unknown): string {
    const id = randomUUID();
    const receipt = Object.freeze({ ...this.binding, id, turnId: this.turnId, kind, callId, digest: fingerprintJson(value).sha256 });
    try { this.options.append(receipt); }
    catch { this.fenced = true; this.options.fence('receipt_persistence_failed'); fail('receipt_persistence_failed'); }
    return id;
  }
  /** Only the host model-response parser may call this. Worker protocol has no observe operation. */
  observeTurn(turnId: string): void {
    this.live(); validId(turnId);
    if (this.busy || this.active || this.presentations.size || [...this.observed.keys()].some(k => !this.consumed.has(k))) fail('turn_incomplete');
    if (this.turns.has(turnId) || this.turns.size >= 64) fail('turn_replay');
    this.turns.add(turnId); this.turnId = turnId;
    this.record('turn', null, { turnId });
  }
  observeToolCall(value: ObservedNativeToolCall): void {
    this.live(); const call = snapshot(value);
    for (const value of [call.turnId, call.toolCallId, call.toolName]) validId(value);
    if (call.turnId !== this.turnId || !object(call.originalArgs) || !this.options.allowedTools.includes(call.toolName)
        || this.observed.has(call.toolCallId) || this.observed.size >= 100) fail('observed_call');
    this.observed.set(call.toolCallId, call);
  }
  async accept(input: unknown, capability: string): Promise<Record<string, unknown>> {
    // Reject before parsing or invoking anything; equal-length comparison avoids timingSafeEqual throws.
    const a = Buffer.from(capability), b = Buffer.from(this.options.transportCapability);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'engineering_protocol:transport' };
    if (this.busy) return { ok: false, error: 'engineering_protocol:concurrent_frame' };
    this.busy = true;
    try {
      const frame = snapshot(input);
      if (!object(frame)) fail('shape');
      only(frame, ['protocol', 'taskId', 'sessionId', 'ownerEpoch', 'turnId', 'sequence', 'kind', 'payload']);
      if (frame.protocol !== 'gary.engineering.v1' || frame.taskId !== this.binding.taskId || frame.sessionId !== this.binding.sessionId
          || frame.ownerEpoch !== this.binding.ownerEpoch || frame.turnId !== this.turnId || !this.turnId
          || frame.sequence !== this.sequence + 1 || !object(frame.payload)) fail('binding_or_sequence');
      if (!['tool.begin', 'environment.operation', 'tool.end', 'tool.presentation', 'session.close'].includes(String(frame.kind))) fail('kind');
      // Consume before any effect. Failed/uncertain operations are never implicitly replayed.
      this.sequence++;
      const p = frame.payload;
      if (frame.kind === 'session.close') {
        only(p, []);
        if (this.closed) fail('closed');
        let receiptFailed = false;
        try { this.record('close_start', null, {}); } catch { receiptFailed = true; }
        let cleanup: { cleanupConfirmed: boolean };
        try { cleanup = await this.options.close(); }
        catch { this.fenced = true; this.options.fence('cleanup_unknown'); fail('cleanup_unknown'); }
        if (!object(cleanup) || cleanup.cleanupConfirmed !== true) { this.fenced = true; this.options.fence('cleanup_unknown'); fail('cleanup_unknown'); }
        this.closed = true; this.active = null;
        if (receiptFailed) fail('receipt_persistence_failed');
        const receiptId = this.record('close_confirmed', null, cleanup);
        return { ok: true, cleanupConfirmed: true, receiptId };
      }
      this.live();
      if (frame.kind === 'tool.presentation') {
        only(p, ['toolCallId', 'admissionId', 'rawResultHash', 'resultHash']);
        const expected = this.presentations.entries().next().value;
        if (this.resultPresentation !== 'native_batch' || this.active || !expected
            || p.toolCallId !== expected[0] || expected[1].turnId !== this.turnId
            || p.admissionId !== expected[1].admissionId || p.rawResultHash !== expected[1].rawResultHash
            || typeof p.resultHash !== 'string' || p.resultHash.length !== 64 || !/^[a-f0-9]{64}$/.test(p.resultHash)) fail('tool_presentation_binding');
        // This receipt authenticates only the model-facing representation of an
        // already completed call. It grants no execution or retry authority.
        const receiptId = this.record('tool_presentation', expected[0], p);
        this.presentations.delete(expected[0]);
        return { ok: true, receiptId };
      }
      if (frame.kind === 'tool.begin') {
        only(p, ['toolCallId', 'toolName', 'originalArgs', 'effectiveArgs']); validId(p.toolCallId);
        const call = this.observed.get(p.toolCallId);
        if (this.active || !call || this.consumed.has(call.toolCallId) || p.toolName !== call.toolName
            || fingerprintJson(p.originalArgs).sha256 !== fingerprintJson(call.originalArgs).sha256) fail('unobserved_or_replayed_call');
        const effective = this.options.normalizeArguments?.(call.toolName, call.originalArgs) ?? call.originalArgs;
        if (fingerprintJson(p.effectiveArgs).sha256 !== fingerprintJson(effective).sha256) fail('effective_arguments');
        this.consumed.add(call.toolCallId);
        const admissionId = randomUUID();
        const receiptId = this.record('tool_begin', call.toolCallId, { ...call, admissionId });
        this.active = { ...call, admissionId, operationReceipts: [], operations: new Set() };
        return { ok: true, admissionId, receiptId };
      }
      const call = this.active;
      if (!call || p.toolCallId !== call.toolCallId || p.admissionId !== call.admissionId) fail('tool_admission');
      if (frame.kind === 'environment.operation') {
        only(p, ['toolCallId', 'admissionId', 'operation', 'arguments']);
        if (typeof p.operation !== 'string' || !OPERATIONS.has(p.operation) || !object(p.arguments)) fail('operation');
        const args = p.arguments; validId(args.operationId);
        if (this.operationIds.has(args.operationId) || this.operationCount >= 1000) fail('operation_replay_or_limit');
        if (p.operation !== 'execute' && p.operation !== 'close') {
          validId(args.processId);
          // Background handles are session-bound, and later native process tools can use them.
          if (!this.processOwners.has(args.processId)) fail('unknown_process');
        }
        call.operations.add(args.operationId); this.operationIds.add(args.operationId); this.operationCount++;
        this.record('operation_start', call.toolCallId, { operation: p.operation, arguments: args });
        let result: Record<string, unknown>;
        try {
          result = await this.options.execute(p.operation, args, { toolCallId: call.toolCallId,
            admissionId: call.admissionId, toolName: call.toolName, originalArgs: call.originalArgs });
          this.live();
          if (!object(result)) fail('invalid_executor_result');
          result = snapshot(result);
          if (p.operation === 'execute') {
            validId(result.processId);
            if (this.processOwners.has(result.processId)) fail('duplicate_process');
            this.processOwners.set(result.processId, call.toolCallId);
          }
        } catch {
          this.record('operation_failed', call.toolCallId, { operationId: args.operationId });
          this.fenced = true; this.options.fence('operation_uncertain'); fail('operation_uncertain');
        }
        const receiptId = this.record('operation_result', call.toolCallId, result);
        call.operationReceipts.push(receiptId);
        return { ...result, ok: true, receiptId };
      }
      only(p, ['toolCallId', 'admissionId', 'status', 'resultHash', 'operationReceipts']);
      if (!['completed', 'failed'].includes(String(p.status)) || typeof p.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.resultHash)
          || fingerprintJson(p.operationReceipts).sha256 !== fingerprintJson(call.operationReceipts).sha256) fail('tool_result_binding');
      const receiptId = this.record('tool_' + p.status, call.toolCallId, { resultHash: p.resultHash, operationReceipts: call.operationReceipts });
      if (this.resultPresentation === 'native_batch') this.presentations.set(call.toolCallId,
        { turnId: this.turnId, admissionId: call.admissionId, rawResultHash: p.resultHash });
      this.active = null;
      return { ok: true, receiptId };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.message.startsWith('engineering_protocol:') ? error.message : 'engineering_protocol:rejected' };
    } finally { this.busy = false; }
  }
}
