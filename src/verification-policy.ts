/** Fixed host-selected verification limits. No model input can create a long-test grant. */
import { randomUUID } from 'node:crypto';
import type { ExecResult, RunOpts } from './executors/index.ts';
import { throwIfExpired } from './deadline.ts';

export type LongTestCommand = 'bun run ci:full' | 'bun run check';
export interface LongTestPolicy {
  readonly version: 1;
  readonly commands: Readonly<Record<LongTestCommand, { readonly timeoutMs: number; readonly maxStarts: number }>>;
  readonly pollWaitMs: 20000;
  readonly heartbeatMs: 1000;
  readonly maxPolls: 96;
}
export interface VerificationPolicy extends LongTestPolicy {
  readonly publicationCommand: 'bun run ci:full';
  readonly genericCommandDefaultTimeoutMs: 120000;
  readonly genericCommandTimeoutMs: 900000;
}
/** Provisional finite ceilings; a green pinned baseline must fit before paid activation. */
export const CODING_VERIFICATION_POLICY: VerificationPolicy = Object.freeze({
  version: 1,
  publicationCommand: 'bun run ci:full',
  commands: Object.freeze({
    'bun run ci:full': Object.freeze({ timeoutMs: 1_800_000, maxStarts: 4 }),
    'bun run check': Object.freeze({ timeoutMs: 600_000, maxStarts: 8 }),
  }),
  pollWaitMs: 20000, heartbeatMs: 1000, maxPolls: 96,
  genericCommandDefaultTimeoutMs: 120000, genericCommandTimeoutMs: 900000,
});
const fail = (code: string): never => { throw new Error('verification_rejected:' + code); };
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_policy');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail('invalid_policy');
  return descriptor.value;
}
/** Detached transport-only snapshot: executable authority stays with the admitted host runner. */
export function snapshotLongTestPolicy(value: LongTestPolicy): LongTestPolicy {
  for (const key of ['version', 'pollWaitMs', 'heartbeatMs', 'maxPolls'] as const) {
    if (own(value, key) !== CODING_VERIFICATION_POLICY[key]) fail('invalid_policy');
  }
  const commands = own(value, 'commands');
  if (!commands || typeof commands !== 'object' || Object.keys(commands).length !== 2) fail('invalid_policy');
  for (const command of Object.keys(CODING_VERIFICATION_POLICY.commands) as LongTestCommand[]) {
    const entry = own(commands, command);
    if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 2) fail('invalid_policy');
    for (const key of ['timeoutMs', 'maxStarts'] as const) {
      if (own(entry, key) !== CODING_VERIFICATION_POLICY.commands[command][key]) fail('invalid_policy');
    }
  }
  return Object.freeze({ version: 1, commands: CODING_VERIFICATION_POLICY.commands,
    pollWaitMs: 20000, heartbeatMs: 1000, maxPolls: 96 });
}
export interface ActionVerification {
  readonly policy: VerificationPolicy;
  /** First binding fixes the action deadline; subsequent invocations may only narrow it. */
  bindDeadline(deadlineMs: number, signal?: AbortSignal): void;
  /** Recognize the original command BEFORE a trusted caller adds its shell wrapper. */
  run(command: string, opts: RunOpts, invoke: (boundedOpts: RunOpts) => Promise<ExecResult>): Promise<ExecResult>;
  snapshot(): Readonly<{ deadlineMs: number | null; counts: Readonly<Record<LongTestCommand, number>> }>;
}
export function createActionVerification(options: { policy: VerificationPolicy; assertActive(): void; testJobContext?: Omit<NonNullable<RunOpts['testJob']>, 'jobId' | 'requestId'> }): ActionVerification {
  snapshotLongTestPolicy(options.policy);
  for (const key of ['publicationCommand', 'genericCommandDefaultTimeoutMs', 'genericCommandTimeoutMs'] as const) {
    if (own(options.policy, key) !== CODING_VERIFICATION_POLICY[key]) fail('invalid_policy');
  }
  const assertActive = options.assertActive;
  const testJobContext = options.testJobContext ? Object.freeze({...options.testJobContext}) : undefined;
  if (typeof assertActive !== 'function') fail('invalid_owner');
  const policy = CODING_VERIFICATION_POLICY;
  let deadlineMs: number | null = null, signal: AbortSignal | undefined, busy = false;
  const counts: Record<LongTestCommand, number> = { 'bun run ci:full': 0, 'bun run check': 0 };
  const active = () => {
    assertActive();
    if (deadlineMs === null) fail('unbound_action');
    throwIfExpired({ deadlineMs: deadlineMs!, ...(signal ? { signal } : {}) });
  };
  return Object.freeze({
    policy,
    bindDeadline(next: number, nextSignal?: AbortSignal) {
      assertActive();
      if (!Number.isFinite(next) || next <= Date.now() || (deadlineMs !== null && next > deadlineMs)) fail('invalid_action_deadline');
      deadlineMs = next;
      if (nextSignal) signal = signal ? AbortSignal.any([signal, nextSignal]) : nextSignal;
      active();
    },
    async run(command: string, opts: RunOpts, invoke: (boundedOpts: RunOpts) => Promise<ExecResult>) {
      active();
      if (busy) fail('concurrent_verification');
      if (typeof command !== 'string' || typeof invoke !== 'function') fail('invalid_command');
      if ((opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0))
          || (opts.deadlineMs !== undefined && !Number.isFinite(opts.deadlineMs))) fail('invalid_command_deadline');
      const known = Object.hasOwn(policy.commands, command) ? command as LongTestCommand : undefined;
      if (known && (opts.cwd !== undefined || opts.env !== undefined)) fail('long_test_context_override');
      const ceiling = known ? policy.commands[known].timeoutMs : policy.genericCommandTimeoutMs;
      const timeoutMs = Math.min(ceiling, opts.timeoutMs ?? (known ? ceiling : policy.genericCommandDefaultTimeoutMs));
      const operationDeadline = Math.min(deadlineMs!, Date.now() + timeoutMs, opts.deadlineMs ?? Infinity);
      const cancellation = new AbortController();
      const signals = [signal, opts.signal, cancellation.signal].filter((item): item is AbortSignal => item !== undefined);
      const bounded: RunOpts = { ...opts, timeoutMs, deadlineMs: operationDeadline,
        ...(signals.length ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) } : {}) };
      if (known && testJobContext) {
        if (opts.testJob && (opts.testJob.journal !== testJobContext.journal
            || ['taskId','actionId','ownerEpoch'].some(key => opts.testJob![key as 'taskId'] !== testJobContext[key as 'taskId']))) fail('test_job_binding');
        bounded.testJob = Object.freeze(opts.testJob ? {...opts.testJob} : {...testJobContext,jobId:randomUUID(),requestId:randomUUID()});
      }
      throwIfExpired(bounded);
      if (known && counts[known] >= policy.commands[known].maxStarts) fail('test_start_limit');
      if (known) counts[known]++;
      busy = true;
      // The host gate has no native poller. Keep its owner/deadline checks alive too.
      const heartbeat = setInterval(() => {
        try { active(); throwIfExpired(bounded); } catch { cancellation.abort(new Error('verification_owner_or_deadline_inactive')); }
      }, policy.heartbeatMs);
      try {
        const result = await invoke(bounded);
        active();
        throwIfExpired(bounded);
        if (result.timedOut && result.exitCode === 0) fail('invalid_test_result');
        return result;
      } finally { clearInterval(heartbeat); busy = false; }
    },
    snapshot: () => Object.freeze({ deadlineMs, counts: Object.freeze({ ...counts }) }),
  });
}
