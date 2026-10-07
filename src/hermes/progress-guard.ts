/** Pure task-progress accounting. Only the host supplies evidence; no I/O or ledger mutation. */
import { createHash } from 'node:crypto';

export interface ProgressScope {
  taskId: string;
  workspaceId: string;
  ownerEpoch: string;
  allocationId: string;
}
export interface ProgressPolicy {
  maxModelRequests: number;
  maxModelRequestsWithoutProgress: number;
  maxSuccessfulToolCalls: number;
  toolRepeatWindow: number;
  maxRepeatedToolCalls: number;
}
export interface TrustedProgressSnapshot {
  scope: ProgressScope;
  /** Fresh, strictly increasing host observation sequence, including unchanged snapshots. */
  sequence: number;
  /** Must come from the canonical allocation, never from runtime/model assertions. */
  allocationState: 'active' | 'exhausted' | 'closed';
  workspace: {
    baselineDigest: string;
    currentDigest: string;
    /** Host hashes the net task-relevant source/acceptance-test diff against baseline.
     * Exclude generated/cache files, timestamps, HEAD-only changes and unrelated edits. */
    taskDiff: null | { digest: string; changedFileCount: number; acceptanceIds: readonly string[] };
  };
  testRuns: readonly {
    runId: string;
    origin: 'task' | 'baseline' | 'external';
    status: 'passed' | 'failed' | 'incomplete';
    workspaceDigest: string;
    taskDiffDigest: string | null;
    acceptanceIds: readonly string[];
  }[];
}
export type ProgressStopReason = 'model_request_limit' | 'no_verified_progress' | 'repetitive_tool_calls'
  | 'successful_tool_limit' | 'allocation_inactive' | 'scope_mismatch' | 'stale_snapshot'
  | 'invalid_snapshot' | 'evidence_unavailable' | 'invalid_tool_observation' | 'cancelled';
export interface ProgressCounters {
  /** Validated request admissions, not paid calls; the ledger can still refuse later. */
  modelRequests: number;
  requestsWithoutProgress: number;
  successfulToolCalls: number;
  repeatedToolCalls: number;
  maxObservedRepeatedToolCalls: number;
  diffAdvances: number;
  testAdvances: number;
  progressAdvances: number;
  snapshotsObserved: number;
}
export interface ProgressGuardState {
  stopped: boolean;
  stopReason: ProgressStopReason | null;
  counters: Readonly<ProgressCounters>;
  budgetMayReopen: false;
  finishApproved: false;
  publicationApproved: false;
}
export class ProgressGuardStop extends Error {
  constructor(readonly reason: ProgressStopReason) {
    super('progress_guard_stopped:' + reason);
    this.name = 'ProgressGuardStop';
  }
}
export interface ProductiveProgressGuard {
  /** Call once before each validated model request, before the existing spend reservation.
   * An admission is not evidence of a paid attempt or a successful provider response. */
  beforeModelRequest(signal?: AbortSignal): Promise<void>;
  /** Only host-confirmed successful invocations. This records repetition, never progress.
   * Fresh evidence is checked before the next model request, so a real edit may clear it. */
  observeSuccessfulTool(name: string, args: unknown): void;
  readonly state: ProgressGuardState;
}
export interface ProgressGuardOptions {
  scope: ProgressScope;
  acceptanceIds: readonly string[];
  /** All limits are mandatory policy choices; there is no production default. */
  policy: ProgressPolicy;
  /** Existing work/tests at admission are consumed as baseline and grant no allowance. */
  baseline: TrustedProgressSnapshot;
  /** Must capture canonical ownership/allocation and workspace/test evidence freshly.
   * Worker/model-supplied claims or tool success strings are not acceptable sources.
   * Honor the signal for any host I/O. A late result is ignored after cancellation;
   * this callback must be read-only because the guard cannot undo side effects. */
  readTrustedSnapshot(signal?: AbortSignal): TrustedProgressSnapshot | Promise<TrustedProgressSnapshot>;
}
const digestPattern = /^[a-f0-9]{64}$/;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const digest = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ids = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 128 && value.every(id) && new Set(value).size === value.length;
const scopeKeys = ['taskId', 'workspaceId', 'ownerEpoch', 'allocationId'] as const;
function validScope(value: unknown): value is ProgressScope {
  return object(value) && scopeKeys.every(key => id(value[key]));
}
function validSnapshot(value: unknown): value is TrustedProgressSnapshot {
  if (!object(value) || !validScope(value.scope) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
      || !['active', 'exhausted', 'closed'].includes(String(value.allocationState)) || !object(value.workspace)
      || !digest(value.workspace.baselineDigest) || !digest(value.workspace.currentDigest)
      || !Array.isArray(value.testRuns) || value.testRuns.length > 1024) return false;
  const diff = value.workspace.taskDiff;
  if (diff !== null && (!object(diff) || !digest(diff.digest) || !Number.isSafeInteger(diff.changedFileCount)
      || (diff.changedFileCount as number) < 1 || !ids(diff.acceptanceIds))) return false;
  return value.testRuns.every(test => object(test) && id(test.runId)
    && ['task', 'baseline', 'external'].includes(String(test.origin))
    && ['passed', 'failed', 'incomplete'].includes(String(test.status))
    && digest(test.workspaceDigest) && (test.taskDiffDigest === null || digest(test.taskDiffDigest)) && ids(test.acceptanceIds));
}
function validPolicy(value: ProgressPolicy): boolean {
  return ['maxModelRequests', 'maxModelRequestsWithoutProgress', 'maxSuccessfulToolCalls', 'toolRepeatWindow', 'maxRepeatedToolCalls']
    .every(key => Number.isSafeInteger(value[key as keyof ProgressPolicy]) && value[key as keyof ProgressPolicy] >= 1 && value[key as keyof ProgressPolicy] <= 10000)
    && value.maxModelRequestsWithoutProgress <= value.maxModelRequests && value.toolRepeatWindow <= 256
    && value.toolRepeatWindow <= value.maxSuccessfulToolCalls && value.maxRepeatedToolCalls <= value.toolRepeatWindow;
}
function toolSignature(name: string, args: unknown): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) || !object(args)) throw new Error('invalid');
  // Sort object keys only. Never normalize shell commands, paths, string case,
  // whitespace or array order: those can change the operation's meaning.
  const canonical = (value: unknown, depth: number): string => {
    if (depth > 64) throw new Error('invalid');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(entry => canonical(entry, depth + 1)).join(',') + ']';
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) throw new Error('invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return '{' + Object.keys(descriptors).sort().map(key => {
      const entry = descriptors[key]!;
      if (!Object.hasOwn(entry, 'value') || !entry.enumerable) throw new Error('invalid');
      return JSON.stringify(key) + ':' + canonical(entry.value, depth + 1);
    }).join(',') + '}';
  };
  const encoded = name + ':' + canonical(args, 0);
  if (Buffer.byteLength(encoded) > 131072) throw new Error('invalid');
  return createHash('sha256').update(encoded).digest('hex');
}

export function createProgressGuard(options: ProgressGuardOptions): ProductiveProgressGuard {
  if (!validScope(options.scope) || !ids(options.acceptanceIds) || !options.acceptanceIds.length
      || !options.policy || !validPolicy(options.policy) || typeof options.readTrustedSnapshot !== 'function') throw new Error('invalid_progress_guard_configuration');
  const scope = { ...options.scope }, policy = { ...options.policy }, acceptance = new Set(options.acceptanceIds);
  let stopped: ProgressStopReason | null = null;
  const counters: ProgressCounters = { modelRequests: 0, requestsWithoutProgress: 0, successfulToolCalls: 0,
    repeatedToolCalls: 0, maxObservedRepeatedToolCalls: 0, diffAdvances: 0, testAdvances: 0, progressAdvances: 0, snapshotsObserved: 0 };
  let sequence = -1, baselineDigest = '', serial: Promise<void> = Promise.resolve();
  const seenDiffs = new Set<string>(), seenTestEvidence = new Set<string>(), recentTools: string[] = [];
  const cancellation = new AbortController();
  const latch = (reason: ProgressStopReason) => { stopped ??= reason; cancellation.abort(); };
  const stop = (reason: ProgressStopReason): never => { latch(reason); throw new ProgressGuardStop(stopped!); };
  const readEvidence = async (signal: AbortSignal): Promise<TrustedProgressSnapshot> => {
    let abortRead = () => {};
    try {
      return await new Promise<TrustedProgressSnapshot>((resolve, reject) => {
        abortRead = () => reject(new ProgressGuardStop(stopped ?? 'cancelled'));
        signal.addEventListener('abort', abortRead, { once: true });
        if (signal.aborted) { abortRead(); return; }
        // Attach both settlement handlers even when the abort wins. A late
        // resolution/rejection is consumed and cannot reach progress accounting.
        Promise.resolve().then(() => {
          if (signal.aborted) throw new ProgressGuardStop(stopped ?? 'cancelled');
          return options.readTrustedSnapshot(signal);
        }).then(resolve, reject);
      });
    } catch { return stop(signal.aborted ? stopped ?? 'cancelled' : 'evidence_unavailable'); }
    finally { signal.removeEventListener('abort', abortRead); }
  };
  const currentDiff = (snapshot: TrustedProgressSnapshot) => {
    const diff = snapshot.workspace.taskDiff;
    return snapshot.workspace.currentDigest !== baselineDigest && diff && diff.acceptanceIds.some(value => acceptance.has(value)) ? diff : null;
  };
  const testEvidence = (snapshot: TrustedProgressSnapshot): string[] => {
    const diff = currentDiff(snapshot);
    if (!diff) return [];
    return snapshot.testRuns.filter(test => test.origin === 'task' && test.status === 'passed'
      && test.workspaceDigest === snapshot.workspace.currentDigest && test.taskDiffDigest === diff.digest)
      .flatMap(test => test.acceptanceIds.filter(value => acceptance.has(value)).map(value => diff.digest + ':' + value));
  };
  const bind = (snapshot: TrustedProgressSnapshot, initial: boolean) => {
    if (!validSnapshot(snapshot)) stop('invalid_snapshot');
    if (scopeKeys.some(key => snapshot.scope[key] !== scope[key])) stop('scope_mismatch');
    if (!initial && (snapshot.workspace.baselineDigest !== baselineDigest)) stop('scope_mismatch');
    if (snapshot.sequence <= sequence) stop('stale_snapshot');
    sequence = snapshot.sequence; counters.snapshotsObserved++;
    if (snapshot.allocationState !== 'active') stop('allocation_inactive');
  };
  try {
    bind(options.baseline, true);
    baselineDigest = options.baseline.workspace.baselineDigest;
    const diff = currentDiff(options.baseline);
    if (diff) seenDiffs.add(diff.digest);
    for (const evidence of testEvidence(options.baseline)) seenTestEvidence.add(evidence);
  } catch (error) { if (!(error instanceof ProgressGuardStop)) latch('invalid_snapshot'); }
  return {
    beforeModelRequest(signal) {
      // Listen before joining the queue: cancellation of a queued request also
      // revokes this admitted guard and unblocks an earlier hung snapshot read.
      const abort = () => latch('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const active = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
      const pending = serial.then(async () => {
        if (stopped) throw new ProgressGuardStop(stopped);
        const snapshot = await readEvidence(active);
        if (stopped) throw new ProgressGuardStop(stopped);
        bind(snapshot, false);
        let advanced = false;
        const diff = currentDiff(snapshot);
        if (diff && !seenDiffs.has(diff.digest)) {
          seenDiffs.add(diff.digest); counters.diffAdvances++; advanced = true;
        }
        for (const evidence of testEvidence(snapshot)) if (!seenTestEvidence.has(evidence)) {
          seenTestEvidence.add(evidence); counters.testAdvances++; advanced = true;
        }
        if (advanced) {
          counters.progressAdvances++; counters.requestsWithoutProgress = 0;
          recentTools.length = 0; counters.repeatedToolCalls = 0;
        }
        if (counters.modelRequests >= policy.maxModelRequests) stop('model_request_limit');
        if (counters.requestsWithoutProgress >= policy.maxModelRequestsWithoutProgress) stop('no_verified_progress');
        if (counters.successfulToolCalls >= policy.maxSuccessfulToolCalls) stop('successful_tool_limit');
        if (counters.repeatedToolCalls >= policy.maxRepeatedToolCalls) stop('repetitive_tool_calls');
        counters.modelRequests++; counters.requestsWithoutProgress++;
      });
      // Serialize fresh observations without allowing one rejected call to hide
      // the original latched stop reason from later callers.
      serial = pending.then(() => {}, () => {});
      return pending.finally(() => signal?.removeEventListener('abort', abort));
    },
    observeSuccessfulTool(name, args) {
      if (stopped) return;
      let signature: string;
      try { signature = toolSignature(name, args); } catch { latch('invalid_tool_observation'); return; }
      counters.successfulToolCalls++;
      if (counters.successfulToolCalls >= policy.maxSuccessfulToolCalls) { latch('successful_tool_limit'); return; }
      recentTools.push(signature);
      if (recentTools.length > policy.toolRepeatWindow) recentTools.shift();
      const counts = new Map<string, number>();
      for (const item of recentTools) counts.set(item, (counts.get(item) ?? 0) + 1);
      counters.repeatedToolCalls = Math.max(...counts.values());
      counters.maxObservedRepeatedToolCalls = Math.max(counters.maxObservedRepeatedToolCalls, counters.repeatedToolCalls);
    },
    get state(): ProgressGuardState {
      return { stopped: stopped !== null, stopReason: stopped, counters: { ...counters },
        budgetMayReopen: false, finishApproved: false, publicationApproved: false };
    },
  };
}
