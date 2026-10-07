import { describe, expect, test } from 'bun:test';
import { createProgressGuard, ProgressGuardStop, type ProgressPolicy, type ProgressScope, type ProgressStopReason, type TrustedProgressSnapshot } from '../../src/hermes/progress-guard.ts';
import { SpendLedger } from '../../src/spend.ts';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const scope: ProgressScope = { taskId: 'task-1', workspaceId: 'workspace-1', ownerEpoch: 'owner-1', allocationId: 'ticket-1' };
// Explicit fixture policy only; these numbers are not deployment defaults.
const policy: ProgressPolicy = { maxModelRequests: 20, maxModelRequestsWithoutProgress: 3,
  maxSuccessfulToolCalls: 100, toolRepeatWindow: 10, maxRepeatedToolCalls: 5 };
const snapshot = (): TrustedProgressSnapshot => ({ scope: { ...scope }, sequence: 0, allocationState: 'active',
  workspace: { baselineDigest: hash(0), currentDigest: hash(0), taskDiff: null }, testRuns: [] });
function harness(config: Partial<ProgressPolicy> = {}, baseline = snapshot()) {
  const current = structuredClone(baseline);
  let reads = 0, unavailable = false;
  const options = { scope, acceptanceIds: ['shape', 'ordering'], policy: { ...policy, ...config }, baseline,
    readTrustedSnapshot() {
      if (unavailable) throw new Error('private diagnostics from trusted source');
      return { ...structuredClone(current), sequence: ++reads };
    } };
  const guard = createProgressGuard(options);
  const change = (n: number, acceptanceIds = ['shape']) => {
    current.workspace.currentDigest = hash(n);
    current.workspace.taskDiff = { digest: hash(100 + n), changedFileCount: 1, acceptanceIds };
  };
  const pass = (runId = 'test-1', acceptanceIds = ['shape']) => {
    current.testRuns = [{ runId, origin: 'task', status: 'passed', workspaceDigest: current.workspace.currentDigest,
      taskDiffDigest: current.workspace.taskDiff?.digest ?? null, acceptanceIds }];
  };
  return { guard, current, change, pass, options, get reads() { return reads; }, unavailable() { unavailable = true; } };
}
async function stopped(guard: ReturnType<typeof createProgressGuard>, reason: ProgressStopReason) {
  await expect(guard.beforeModelRequest()).rejects.toThrow('progress_guard_stopped:' + reason);
  expect(guard.state.stopReason).toBe(reason);
}

describe('productive follow-through guard (trusted evidence fixtures; no filesystem or provider)', () => {
  test('simulated 49-call no-change run stops after configured allowance despite baseline tests and noop writes', async () => {
    const h = harness({ maxModelRequests: 60, maxModelRequestsWithoutProgress: 5, toolRepeatWindow: 20, maxRepeatedToolCalls: 20 });
    let accepted = 0, denied = 0;
    for (let i = 0; i < 49; i++) {
      h.pass('existing-test-' + i);
      try { await h.guard.beforeModelRequest(); accepted++; }
      catch (error) { expect(error).toBeInstanceOf(ProgressGuardStop); denied++; }
      h.guard.observeSuccessfulTool('write_file', { path: 'task.ts', content: 'unchanged' });
    }
    expect({ accepted, denied }).toEqual({ accepted: 5, denied: 44 });
    expect(h.guard.state).toMatchObject({ stopReason: 'no_verified_progress',
      counters: { modelRequests: 5, requestsWithoutProgress: 5, diffAdvances: 0, testAdvances: 0, progressAdvances: 0 },
      budgetMayReopen: false, finishApproved: false, publicationApproved: false });
    expect(h.reads).toBe(6);
  });

  test('new trusted task diff and a relevant passing test advance once without granting finish or publication', async () => {
    const h = harness();
    await h.guard.beforeModelRequest(); await h.guard.beforeModelRequest();
    h.change(1); h.pass();
    await h.guard.beforeModelRequest();
    expect(h.guard.state).toMatchObject({ stopped: false, counters: { modelRequests: 3, requestsWithoutProgress: 1,
      diffAdvances: 1, testAdvances: 1, progressAdvances: 1 }, budgetMayReopen: false, finishApproved: false, publicationApproved: false });
    // Fresh run IDs on the same diff/acceptance do not manufacture new progress.
    for (let i = 0; i < 2; i++) { h.pass('rerun-' + i); await h.guard.beforeModelRequest(); }
    await stopped(h.guard, 'no_verified_progress');
  });

  test('a stalled run after an initial edit and test eventually stops', async () => {
    const h = harness(); await h.guard.beforeModelRequest();
    h.change(1); await h.guard.beforeModelRequest();
    h.pass(); await h.guard.beforeModelRequest();
    await h.guard.beforeModelRequest(); await h.guard.beforeModelRequest();
    await stopped(h.guard, 'no_verified_progress');
    expect(h.guard.state.counters).toMatchObject({ modelRequests: 5, diffAdvances: 1, testAdvances: 1, progressAdvances: 2 });
  });

  test('existing baseline implementation and passed tests grant no new allowance', async () => {
    const baseline = snapshot(); baseline.workspace.currentDigest = hash(1);
    baseline.workspace.taskDiff = { digest: hash(101), changedFileCount: 1, acceptanceIds: ['shape'] };
    baseline.testRuns = [{ runId: 'already-passed', origin: 'task', status: 'passed', workspaceDigest: hash(1), taskDiffDigest: hash(101), acceptanceIds: ['shape'] }];
    const h = harness({}, baseline);
    for (let i = 0; i < 3; i++) await h.guard.beforeModelRequest();
    await stopped(h.guard, 'no_verified_progress');
    expect(h.guard.state.counters).toMatchObject({ diffAdvances: 0, testAdvances: 0, progressAdvances: 0 });
  });

  test('unrelated workspace changes and tests are not task delivery', async () => {
    const h = harness();
    h.change(1, ['unrelated']); h.pass('unrelated-test', ['unrelated']);
    await h.guard.beforeModelRequest();
    h.current.workspace.currentDigest = hash(2); h.current.workspace.taskDiff = null;
    h.pass('existing-file-test');
    await h.guard.beforeModelRequest(); await h.guard.beforeModelRequest();
    await stopped(h.guard, 'no_verified_progress');
    expect(h.guard.state.counters.progressAdvances).toBe(0);
  });

  test('baseline/external/failed/incomplete/stale-diff tests never advance', async () => {
    for (const mutation of [
      { origin: 'baseline' }, { origin: 'external' }, { status: 'failed' }, { status: 'incomplete' },
      { workspaceDigest: hash(99) }, { taskDiffDigest: hash(99) }, { taskDiffDigest: null }, { acceptanceIds: ['unrelated'] },
    ]) {
      const h = harness(); h.change(1); await h.guard.beforeModelRequest(); h.pass();
      h.current.testRuns = [{ ...h.current.testRuns[0]!, ...mutation } as TrustedProgressSnapshot['testRuns'][number]];
      await h.guard.beforeModelRequest();
      expect(h.guard.state.counters.testAdvances).toBe(0);
      expect(h.guard.state.counters.requestsWithoutProgress).toBe(2);
    }
  });

  test('revert and reapply the same diff do not repeatedly reset the allowance', async () => {
    const h = harness(); h.change(1); await h.guard.beforeModelRequest();
    h.current.workspace.currentDigest = hash(0); h.current.workspace.taskDiff = null;
    await h.guard.beforeModelRequest(); h.change(1); await h.guard.beforeModelRequest();
    await stopped(h.guard, 'no_verified_progress');
    expect(h.guard.state.counters.diffAdvances).toBe(1);
  });

  test('exact repeated tool signatures stop; key order is irrelevant and arguments never reach diagnostics', async () => {
    const h = harness({ maxModelRequestsWithoutProgress: 20, maxRepeatedToolCalls: 3 });
    await h.guard.beforeModelRequest();
    h.guard.observeSuccessfulTool('read_file', { path: 'SYNTHETIC_SECRET_PATH', offset: 0 });
    h.guard.observeSuccessfulTool('read_file', { offset: 0, path: 'SYNTHETIC_SECRET_PATH' });
    h.guard.observeSuccessfulTool('read_file', { path: 'SYNTHETIC_SECRET_PATH', offset: 0 });
    await stopped(h.guard, 'repetitive_tool_calls');
    expect(h.guard.state.counters).toMatchObject({ repeatedToolCalls: 3, successfulToolCalls: 3, progressAdvances: 0 });
    expect(JSON.stringify(h.guard.state)).not.toContain('SYNTHETIC_SECRET_PATH');
  });

  test('tool strings and array order retain their semantics; observation alone never asserts progress', async () => {
    const h = harness({ maxRepeatedToolCalls: 2 });
    for (const command of ['cat A', 'cat a', 'cat  A']) h.guard.observeSuccessfulTool('run_bash', { command });
    h.guard.observeSuccessfulTool('tool', { values: ['a', 'b'] }); h.guard.observeSuccessfulTool('tool', { values: ['b', 'a'] });
    await h.guard.beforeModelRequest();
    expect(h.guard.state.counters.repeatedToolCalls).toBe(1);
    expect(h.guard.state.counters.progressAdvances).toBe(0);
  });

  test('fresh verified change can clear repeated activity before the next model call', async () => {
    const h = harness({ maxRepeatedToolCalls: 2 });
    h.guard.observeSuccessfulTool('write_file', { path: 'task.ts', content: 'implementation' });
    h.guard.observeSuccessfulTool('write_file', { path: 'task.ts', content: 'implementation' });
    expect(h.guard.state.counters.progressAdvances).toBe(0);
    h.change(1); await h.guard.beforeModelRequest();
    expect(h.guard.state).toMatchObject({ stopped: false, counters: { diffAdvances: 1, repeatedToolCalls: 0, maxObservedRepeatedToolCalls: 2 } });
  });

  test('absolute cap still stops a run with continually changing trusted diffs', async () => {
    const h = harness({ maxModelRequests: 5 });
    for (let i = 1; i <= 5; i++) { h.change(i); h.pass('test-' + i); await h.guard.beforeModelRequest(); }
    h.change(6); h.pass('test-6'); await stopped(h.guard, 'model_request_limit');
    expect(h.guard.state.counters.modelRequests).toBe(5);
  });

  test('terminal stop latches even if later snapshots claim progress or active allocation', async () => {
    const h = harness(); h.current.allocationState = 'exhausted';
    await stopped(h.guard, 'allocation_inactive');
    h.current.allocationState = 'active'; h.change(1); h.pass();
    await stopped(h.guard, 'allocation_inactive');
    expect(h.guard.state.counters.modelRequests).toBe(0);
    expect(h.reads).toBe(1);
  });

  test('recreating progress accounting cannot reopen a real exhausted ledger allocation', async () => {
    const ledger = new SpendLedger(':memory:');
    try {
      ledger.createCampaign('fixture', 1); ledger.enrollTicket('fixture', 'ticket-1', 1);
      let providerCalls = 0;
      const fetch = ledger.guardedFetch('deepseek', (async () => { providerCalls++; return Response.json({}); }) as unknown as typeof globalThis.fetch);
      await expect(ledger.withSpendScope('ticket-1', () => fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-pro', max_tokens: 128, messages: [{ role: 'user', content: 'offline fixture' }] }),
      }))).rejects.toThrow();
      const before = ledger.status('ticket-1')!;
      expect(before.state).toBe('exhausted');
      for (let reset = 0; reset < 3; reset++) {
        const h = harness();
        const guard = createProgressGuard({ ...h.options, readTrustedSnapshot: () => ({ ...snapshot(), sequence: 1, allocationState: ledger.status('ticket-1')!.state }) });
        await stopped(guard, 'allocation_inactive');
        expect(guard.state.budgetMayReopen).toBe(false);
      }
      expect(ledger.status('ticket-1')).toEqual(before);
      expect(providerCalls).toBe(0);
    } finally { ledger.close(); }
  });

  test('fresh evidence is bound to task, workspace, owner, allocation and baseline', async () => {
    for (const field of ['taskId', 'workspaceId', 'ownerEpoch', 'allocationId'] as const) {
      const h = harness(); h.current.scope[field] = 'wrong'; await stopped(h.guard, 'scope_mismatch');
    }
    const h = harness(); h.current.workspace.baselineDigest = hash(33); await stopped(h.guard, 'scope_mismatch');
  });

  test('stale/unavailable/malformed snapshots fail closed without exposing private source errors', async () => {
    const h = harness();
    const stale = createProgressGuard({ ...h.options, readTrustedSnapshot: () => snapshot() });
    await stopped(stale, 'stale_snapshot');
    h.unavailable(); await stopped(h.guard, 'evidence_unavailable');
    expect(JSON.stringify(h.guard.state)).not.toContain('private');
    const malformed = createProgressGuard({ ...h.options, readTrustedSnapshot: () => ({ modelClaims: 'done' }) as unknown as TrustedProgressSnapshot });
    await stopped(malformed, 'invalid_snapshot');
  });

  test('in-flight snapshot callbacks serialize admissions and honor the same bound', async () => {
    const h = harness({ maxModelRequestsWithoutProgress: 1 });
    const results = await Promise.allSettled([h.guard.beforeModelRequest(), h.guard.beforeModelRequest(), h.guard.beforeModelRequest()]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(h.guard.state.counters.modelRequests).toBe(1);
  });

  test('already-aborted admission reads nothing and latches cancellation', async () => {
    const h = harness(), controller = new AbortController(); controller.abort(new Error('private abort reason'));
    await expect(h.guard.beforeModelRequest(controller.signal)).rejects.toThrow('progress_guard_stopped:cancelled');
    expect(h.reads).toBe(0);
    expect(h.guard.state).toMatchObject({ stopReason: 'cancelled', counters: { modelRequests: 0, snapshotsObserved: 1 } });
    await stopped(h.guard, 'cancelled');
  });

  test('abort releases a hung snapshot callback and all queued admissions without accepting late progress', async () => {
    const h = harness(), controller = new AbortController();
    let release!: (value: TrustedProgressSnapshot) => void, enter!: () => void;
    let forwarded: AbortSignal | undefined, reads = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const guard = createProgressGuard({ ...h.options, readTrustedSnapshot(signal) {
      reads++; forwarded = signal; enter();
      return new Promise<TrustedProgressSnapshot>(resolve => { release = resolve; });
    } });
    const pending = guard.beforeModelRequest(controller.signal);
    const queued = guard.beforeModelRequest();
    const results = Promise.allSettled([pending, queued]);
    await entered; controller.abort();
    const outcome = await results;
    expect(outcome.map(value => value.status)).toEqual(['rejected', 'rejected']);
    expect(forwarded?.aborted).toBe(true);
    expect(reads).toBe(1);
    expect(guard.state).toMatchObject({ stopReason: 'cancelled', counters: { modelRequests: 0, progressAdvances: 0, snapshotsObserved: 1 } });
    h.change(1); h.pass();
    release({ ...structuredClone(h.current), sequence: 1 });
    await Promise.resolve(); await Promise.resolve();
    await stopped(guard, 'cancelled');
    expect(guard.state.counters).toMatchObject({ modelRequests: 0, diffAdvances: 0, testAdvances: 0, progressAdvances: 0, snapshotsObserved: 1 });
  });

  test('cancellation while queued unblocks an earlier snapshot that ignores abort', async () => {
    const h = harness(), controller = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const guard = createProgressGuard({ ...h.options, readTrustedSnapshot() {
      enter(); return new Promise<TrustedProgressSnapshot>(() => {});
    } });
    const first = guard.beforeModelRequest();
    await entered;
    const second = guard.beforeModelRequest(controller.signal);
    const results = Promise.allSettled([first, second]);
    controller.abort();
    expect((await results).map(value => value.status)).toEqual(['rejected', 'rejected']);
    expect(guard.state.stopReason).toBe('cancelled');
  });

  test('invalid tool evidence, bounded tool count and detached state cannot unlock the guard', async () => {
    for (const args of [{ value: Infinity }, { value: undefined }, { get path() { throw new Error('must not execute getter'); } }]) {
      const h = harness(); h.guard.observeSuccessfulTool('tool', args); await stopped(h.guard, 'invalid_tool_observation');
    }
    const h = harness({ maxSuccessfulToolCalls: 2, toolRepeatWindow: 2, maxRepeatedToolCalls: 2 });
    h.guard.observeSuccessfulTool('read_file', { path: 'one' }); h.guard.observeSuccessfulTool('read_file', { path: 'two' });
    expect(h.guard.state.stopReason).toBe('successful_tool_limit');
    h.guard.observeSuccessfulTool('read_file', { path: 'late' });
    expect(h.guard.state.counters.successfulToolCalls).toBe(2);
    await stopped(h.guard, 'successful_tool_limit');
    const state = h.guard.state; (state.counters as { modelRequests: number }).modelRequests = -100;
    expect(h.guard.state.counters.modelRequests).toBe(0);
  });

  test('policy is mandatory and invalid limits are rejected rather than silently defaulted', () => {
    const h = harness();
    for (const invalid of [undefined, {}, { ...policy, maxModelRequestsWithoutProgress: 0 }, { ...policy, maxRepeatedToolCalls: 99 }]) {
      expect(() => createProgressGuard({ ...h.options, policy: invalid as ProgressPolicy })).toThrow('invalid_progress_guard_configuration');
    }
  });
});
