import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadonlyCanary, loadReadonlyCanaryConfig, READONLY_CANARY_POLICY } from '../../src/hermes/readonly-canary.ts';
import { HERMES_CANARY_CHILD_IMAGE } from '../../src/hermes/activation.ts';
import type { GaryRuntimeLauncher, NativeRuntimeOutcome } from '../../src/hermes/gary-loop-adapter.ts';
import type { createReadonlyChildExecutor } from '../../src/hermes/readonly-child.ts';
import type { Executor } from '../../src/executors/index.ts';
import { openDb } from '../../src/state/db.ts';
import { recordActionStart, upsertTicket } from '../../src/state/queries.ts';
import { SpendLedger, spendReservationMicros } from '../../src/spend.ts';

const cleanups: Array<() => void> = [];
const mockAssertionFailures: unknown[] = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); expect(mockAssertionFailures.splice(0)).toEqual([]); });
// Production deliberately sanitizes callback failures. Do not let that turn a
// failed fixture assertion into a passing negative-gate test.
function verify(check: () => void) { try { check(); } catch (error) { mockAssertionFailures.push(error); throw error; } }
type Config = Parameters<typeof createReadonlyCanary>[0];
type Dependencies = Parameters<typeof createReadonlyCanary>[1];
type Challenge = { nonce: string; a: number; b: number };
const RELEASE = 'a'.repeat(40);
const KEY = 'offline-fixture-provider-key';
function configFixture(baseDirectory = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(baseDirectory, 'gary-readonly-canary-')));
  chmodSync(root, 0o700); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fixtureDirectory = join(root, 'fixtures'), traceDirectory = join(root, 'traces');
  mkdirSync(fixtureDirectory, { mode: 0o700 }); mkdirSync(traceDirectory, { mode: 0o700 });
  const config: Config = { version: 1, runId: 'offline-smoke', campaignId: 'offline-campaign', allocationId: 'offline-allocation',
    fixtureDirectory, traceDirectory, releaseCommit: RELEASE };
  const path = join(root, 'canary.json');
  const save = (value: unknown = config) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); save();
  return { root, path, config, save };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Mode = 'ready' | 'bad-answer' | 'unknown-usage' | 'missing-read' | 'invalid-path' | 'extra-answer-key' | 'duplicate-answer-key';
function runtimeFixture(options: { mode?: Mode; campaignCap?: number; allocationCap?: number; draft?: boolean; baseDirectory?: string } = {}) {
  const f = configFixture(options.baseDirectory), mode = options.mode ?? 'ready';
  const dbPath = join(f.root, 'gary.db'), ledgerPath = join(f.root, 'spend.db');
  const db = openDb(dbPath), ledger = new SpendLedger(ledgerPath);
  cleanups.push(() => db.close(), () => ledger.close());
  ledger.createCampaign(f.config.campaignId, options.campaignCap ?? 5);
  ledger.enrollTicket(f.config.campaignId, f.config.allocationId, options.allocationCap ?? 5, { draftPr: options.draft ?? false });
  const challengePath = () => join(f.config.fixtureDirectory, f.config.runId, 'challenge.json');
  const challenge = (): Challenge => JSON.parse(readFileSync(challengePath(), 'utf8'));
  const expected = () => { const value = challenge(); return JSON.stringify({ nonce: value.nonce, sum: value.a + value.b }); };
  const upstreamThinking: unknown[] = [];
  let requests = 0, launches = 0, executorCreations = 0, reads = 0, closes = 0;
  const hooks: { afterRead?: () => void; beforeLaunch?: () => Promise<void>; afterNative?: (value: NativeRuntimeOutcome) => NativeRuntimeOutcome;
    close?: () => Promise<void>; nativeSystem?: string } = {};
  const createExecutor: typeof createReadonlyChildExecutor = async options => {
    executorCreations++;
    verify(() => { expect(options.imageDigest).toBe(HERMES_CANARY_CHILD_IMAGE);
    expect(options.parentDepth).toBe(0); expect(options.workspaceRoot).toBe(join(f.config.fixtureDirectory, f.config.runId));
    expect(options.admission.ticketId).toBe(f.config.allocationId);
    expect(options.admission.deadlineMs - Date.now()).toBeGreaterThan(0);
    expect(options.admission.deadlineMs - Date.now()).toBeLessThanOrEqual(120_000); });
    const denied = async (): Promise<never> => { throw new Error('unexpected_mutating_or_shell_executor_call'); };
    const executor: Executor = { workspaceRoot: options.workspaceRoot,
      readFile: async path => { reads++; verify(() => expect(path).toBe('challenge.json')); const text = readFileSync(join(options.workspaceRoot, path), 'utf8'); hooks.afterRead?.(); return text; },
      writeFile: denied, listFiles: denied, grep: denied, run: denied };
    return { executor, depth: 1, admission: options.admission, close: async () => { closes++; await hooks.close?.(); } };
  };
  const launch: GaryRuntimeLauncher = async (manifest, handle) => {
    launches++; await hooks.beforeLaunch?.();
    verify(() => { expect(manifest.maxIterations).toBe(3); expect(manifest.maxTokens).toBe(1024); expect(manifest.temperature).toBe(0);
    expect(manifest.tools.map(tool => tool.function.name)).toEqual(['read_file']);
    const secret = challenge();
    expect(manifest.prompt).not.toContain(secret.nonce); expect(manifest.systemPrompt).not.toContain(secret.nonce); });
    const history: Record<string, unknown>[] = [...(manifest.history ?? []), { role: 'user', content: manifest.prompt }];
    const call = (path: string, body: unknown) => handle(new Request(new URL(path, manifest.modelBaseUrl), { method: 'POST',
      headers: { authorization: 'Bearer ' + manifest.capability, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const outcome = (status: NativeRuntimeOutcome['status'], text?: string): NativeRuntimeOutcome => ({
      taskId: manifest.taskId, requestId: manifest.requestId, publicationApproved: false, status, history, ...(text === undefined ? {} : { text }) });
    for (let i = 0; i < manifest.maxIterations; i++) {
      const response = await call('/v1/chat/completions', { model: manifest.model, messages: [{ role: 'system', content: hooks.nativeSystem ?? manifest.systemPrompt }, ...history],
        tools: manifest.tools, max_tokens: manifest.maxTokens, temperature: manifest.temperature, stream: false });
      if (!response.ok) return outcome('error');
      const assistant = (await response.json()).choices[0].message; history.push(assistant);
      if (!assistant.tool_calls?.length) return hooks.afterNative?.(outcome('no_finish', assistant.content)) ?? outcome('no_finish', assistant.content);
      for (const tool of assistant.tool_calls) {
        const response = await call('/tools/execute', { taskId: manifest.taskId, ownerEpoch: manifest.ownerEpoch, token: manifest.capability,
          callId: tool.id, name: tool.function.name, arguments: tool.function.arguments });
        const receipt = await response.json(); history.push({ role: 'tool', tool_call_id: tool.id, content: receipt.content });
        if (!response.ok) return outcome('error');
      }
    }
    return outcome('iteration_cap');
  };
  const deps: Dependencies = { db, ledger, createExecutor, launch,
    route: { provider: 'deepseek', model: 'deepseek-v4-pro', providerApiKey: KEY, fetch: async request => {
      verify(() => expect(request.url).toBe('https://api.deepseek.com/anthropic/v1/messages')); requests++;
      const body = await request.json(); upstreamThinking.push(body.thinking);
      verify(() => { expect(body.model).toBe('deepseek-v4-pro'); expect(body.max_tokens).toBeLessThanOrEqual(1024); expect(body.thinking).toEqual({ type: 'disabled' });
        if (hooks.nativeSystem) expect(JSON.stringify(body.system)).not.toContain(hooks.nativeSystem); });
      let content: unknown[], stopReason: string;
      if (requests === 1 && mode !== 'missing-read') {
        content = [{ type: 'tool_use', id: 'challenge-read', name: 'read_file', input: { path: mode === 'invalid-path' ? '../outside.json' : 'challenge.json' } }]; stopReason = 'tool_use';
      } else {
        const results = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'tool_result') : []);
        const toolContent = results.at(-1)?.content;
        const text = Array.isArray(toolContent) ? toolContent.map((block: any) => block.text).join('') : toolContent;
        const value: Challenge = mode === 'missing-read' ? challenge() : JSON.parse(text);
        const answer = { nonce: value.nonce, sum: value.a + value.b + (mode === 'bad-answer' ? 1 : 0), ...(mode === 'extra-answer-key' ? { extra: true } : {}) };
        const answerText = mode === 'duplicate-answer-key'
          ? JSON.stringify(answer).replace('"nonce":', '"nonce":' + JSON.stringify(answer.nonce) + ',"nonce":')
          : JSON.stringify(answer);
        content = [{ type: 'text', text: answerText }]; stopReason = 'end_turn';
      }
      return Response.json({ id: 'offline-reply-' + requests, type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content, stop_reason: stopReason,
        ...(mode === 'unknown-usage' ? {} : { usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) });
    } } };
  return { ...f, db, ledger, dbPath, ledgerPath, deps, hooks, challenge, challengePath, expected, upstreamThinking,
    counts: () => ({ requests, launches, executorCreations, reads, closes }) };
}
async function failClosed(f: ReturnType<typeof runtimeFixture>) {
  const canary = createReadonlyCanary(f.config, f.deps);
  await canary.run().catch(() => undefined);
  expect(canary.check()).toMatchObject({ kind: 'readonly_runtime', ready: false, readonlyCanarySucceeded: false });
  return canary;
}

test('private config loader returns exact immutable configuration', () => {
  const f = configFixture(), loaded = loadReadonlyCanaryConfig(f.path);
  expect(loaded).toEqual(f.config); expect(Object.isFrozen(loaded)).toBe(true);
});
for (const mode of ['unknown-key', 'duplicate-key', 'public-file', 'public-parent', 'public-fixtures', 'public-traces', 'symlink', 'hardlink', 'relative-path', 'invalid-run-id', 'invalid-release', 'same-directories', 'uuid-allocation'] as const) {
  test('private config loader rejects ' + mode, () => {
    const f = configFixture(); let path = f.path;
    if (mode === 'unknown-key') f.save({ ...f.config, apiKey: 'forbidden' });
    if (mode === 'duplicate-key') writeFileSync(path, readFileSync(path, 'utf8').replace('"version":1', '"version":1,"version":1'));
    if (mode === 'public-file') chmodSync(path, 0o644);
    if (mode === 'public-parent') chmodSync(f.root, 0o755);
    if (mode === 'public-fixtures') chmodSync(f.config.fixtureDirectory, 0o755);
    if (mode === 'public-traces') chmodSync(f.config.traceDirectory, 0o755);
    if (mode === 'symlink') { path = join(f.root, 'alias.json'); symlinkSync(f.path, path); }
    if (mode === 'hardlink') linkSync(path, join(f.root, 'other.json'));
    if (mode === 'relative-path') f.save({ ...f.config, fixtureDirectory: 'relative' });
    if (mode === 'invalid-run-id') f.save({ ...f.config, runId: '../escape' });
    if (mode === 'invalid-release') f.save({ ...f.config, releaseCommit: 'main' });
    if (mode === 'same-directories') f.save({ ...f.config, traceDirectory: f.config.fixtureDirectory });
    if (mode === 'uuid-allocation') f.save({ ...f.config, allocationId: '11111111-1111-4111-8111-111111111111' });
    expect(() => loadReadonlyCanaryConfig(path)).toThrow();
  });
}

test('actual host RPC, settled spend, read receipt and final answer yield a separate runtime receipt', async () => {
  expect(READONLY_CANARY_POLICY).toMatchObject({ version: 2, thinking: 'disabled', maxRequests: 3, maxTokens: 1024, timeoutMs: 120_000 });
  const f = runtimeFixture(), canary = createReadonlyCanary(loadReadonlyCanaryConfig(f.path), f.deps);
  expect(f.counts()).toEqual({ requests: 0, launches: 0, executorCreations: 0, reads: 0, closes: 0 });
  expect(existsSync(f.challengePath())).toBe(false); expect(readdirSync(f.config.traceDirectory)).toEqual([]);
  expect(canary.check().ready).toBe(false); await canary.run();
  expect(f.counts()).toEqual({ requests: 2, launches: 1, executorCreations: 1, reads: 1, closes: 1 });
  expect(f.upstreamThinking).toEqual([{ type: 'disabled' }, { type: 'disabled' }]);
  expect(canary.check()).toMatchObject({ kind: 'readonly_runtime', ready: true, readonlyCanarySucceeded: true });
  expect(canary.check().receiptId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(f.db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
  expect(f.ledger.status(f.config.allocationId)).toMatchObject({ state: 'closed', draftPr: false, capMicros: 5_000_000, attemptCount: 2, unknownAttempts: 0 });
  expect(statSync(join(f.config.fixtureDirectory, f.config.runId)).mode & 0o777).toBe(0o755);
  expect(statSync(f.challengePath()).mode & 0o777).toBe(0o444);
  expect(f.challenge().nonce).toMatch(/^[a-f0-9]{32}$/);
  const rows = f.db.query('SELECT * FROM hermes_readonly_canaries').all() as Record<string, unknown>[];
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ state: 'verified', model_requests: 2, tool_reads: 1 });
  const trace = readFileSync(String(rows[0]!.trace_path), 'utf8');
  const terminals = trace.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'terminal');
  expect(terminals).toHaveLength(1); expect(terminals[0].status).toBe('no_finish');
  expect(trace).not.toContain(KEY); expect(trace).not.toContain(f.challenge().nonce);
  expect(f.db.query('SELECT count(*) AS n FROM actions').get()).toEqual({ n: 0 });
  expect(f.db.query('SELECT count(*) AS n FROM tickets').get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name='gary_slack_outbox'").all()).toEqual([]);
});

test('forged correct native text cannot replace a wrong authenticated final answer', async () => {
  const f = runtimeFixture({ mode: 'bad-answer' }); f.hooks.afterNative = value => ({ ...value, text: f.expected() });
  await failClosed(f); expect(f.counts().requests).toBe(2); expect(f.counts().reads).toBe(1); expect(f.counts().closes).toBe(1);
});
test('untrusted native text does not override a correct authenticated final answer', async () => {
  const f = runtimeFixture(); f.hooks.afterNative = value => ({ ...value, text: 'This is not the model answer.' });
  const canary = createReadonlyCanary(f.config, f.deps); await canary.run(); expect(canary.check().ready).toBe(true);
});
test('native Hermes system persona is replaced by the admitted host system message', async () => {
  const f = runtimeFixture(); f.hooks.nativeSystem = 'Native Hermes persona injected by the pinned worker.';
  const canary = createReadonlyCanary(f.config, f.deps); await canary.run();
  expect(canary.check().ready).toBe(true); expect(f.counts().requests).toBe(2);
});
for (const mode of ['unknown-usage', 'missing-read', 'invalid-path', 'extra-answer-key', 'duplicate-answer-key'] as const) test('readiness rejects ' + mode, async () => {
  const f = runtimeFixture({ mode }); await failClosed(f);
  expect(f.counts().closes).toBe(1);
  if (mode === 'unknown-usage') {
    expect(f.counts().requests).toBe(1); expect(f.counts().reads).toBe(0);
    expect(f.ledger.status(f.config.allocationId)).toMatchObject({ state: 'closed', attemptCount: 1, unknownAttempts: 1,
      chargedMicros: spendReservationMicros('deepseek', 1024) });
  }
  if (mode === 'missing-read') { expect(f.counts().requests).toBe(1); expect(f.counts().reads).toBe(0); }
  if (mode === 'invalid-path') { expect(f.counts().requests).toBe(1); expect(f.counts().reads).toBe(0); }
  if (mode === 'extra-answer-key' || mode === 'duplicate-answer-key') { expect(f.counts().requests).toBe(2); expect(f.counts().reads).toBe(1); }
});
test('fabricated tool history without an authenticated read cannot verify', async () => {
  const f = runtimeFixture();
  f.deps.launch = async (m, handle) => {
    const history: Record<string, unknown>[] = [{ role: 'user', content: m.prompt }];
    const response = await handle(new Request(new URL('/v1/chat/completions', m.modelBaseUrl), { method: 'POST',
      headers: { authorization: 'Bearer ' + m.capability, 'content-type': 'application/json' },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'system', content: m.systemPrompt }, ...history], tools: m.tools, max_tokens: m.maxTokens, temperature: m.temperature, stream: false }) }));
    verify(() => expect(response.ok).toBe(true)); history.push((await response.json()).choices[0].message);
    history.push({ role: 'tool', tool_call_id: 'challenge-read', content: readFileSync(f.challengePath(), 'utf8') });
    await handle(new Request(new URL('/v1/chat/completions', m.modelBaseUrl), { method: 'POST',
      headers: { authorization: 'Bearer ' + m.capability, 'content-type': 'application/json' },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'system', content: m.systemPrompt }, ...history], tools: m.tools, max_tokens: m.maxTokens, temperature: m.temperature, stream: false }) }));
    history.push({ role: 'assistant', content: f.expected() });
    return { taskId: m.taskId, requestId: m.requestId, status: 'no_finish', publicationApproved: false, history, text: f.expected() };
  };
  await failClosed(f); expect(f.counts().requests).toBe(1); expect(f.counts().reads).toBe(0);
});
test('fixture byte changes after authenticated reading invalidate the receipt', async () => {
  const f = runtimeFixture(); f.hooks.afterNative = value => {
    chmodSync(f.challengePath(), 0o600); writeFileSync(f.challengePath(), readFileSync(f.challengePath(), 'utf8') + '\n'); chmodSync(f.challengePath(), 0o444); return value;
  };
  await failClosed(f); expect(f.counts().requests).toBe(2);
});
test('cleanup failure blocks readiness after otherwise valid model and read proof', async () => {
  const f = runtimeFixture(); f.hooks.close = async () => { throw new Error('offline_cleanup_failed'); };
  await failClosed(f); expect(f.counts().requests).toBe(2); expect(f.counts().closes).toBe(1);
});
test('readiness stays false until executor cleanup has settled', async () => {
  const f = runtimeFixture(), closing = deferred(), release = deferred();
  f.hooks.close = async () => { closing.resolve(); await release.promise; };
  const canary = createReadonlyCanary(f.config, f.deps), running = canary.run();
  try { await Promise.race([closing.promise, running]); expect(canary.check().ready).toBe(false); expect(f.counts().requests).toBe(2); }
  finally { release.resolve(); }
  await running; expect(canary.check().ready).toBe(true);
});
test('canonical owner revocation after read prevents the next model call and receipt', async () => {
  const f = runtimeFixture(); f.hooks.afterRead = () => { f.db.query('UPDATE hermes_readonly_canaries SET owner_epoch=? WHERE run_id=?').run('revoked-owner', f.config.runId); };
  await failClosed(f); expect(f.counts().requests).toBe(1); expect(f.counts().reads).toBe(1); expect(f.counts().closes).toBe(1);
});
test('owner revocation during cleanup blocks the final verification transition', async () => {
  const f = runtimeFixture(); f.hooks.close = async () => { f.db.query('UPDATE hermes_readonly_canaries SET owner_epoch=? WHERE run_id=?').run('revoked-during-cleanup', f.config.runId); };
  await failClosed(f); expect(f.counts().requests).toBe(2); expect(f.counts().closes).toBe(1);
});
test('abort after native completion still awaits cleanup and cannot verify', async () => {
  const f = runtimeFixture(), controller = new AbortController(); f.deps.signal = controller.signal;
  f.hooks.afterNative = value => { controller.abort(); return value; };
  await failClosed(f); expect(f.counts().requests).toBe(2); expect(f.counts().closes).toBe(1);
});
test('max_tokens 1025 is rejected before any paid request', async () => {
  const f = runtimeFixture(), native = f.deps.launch!;
  f.deps.launch = (manifest, handle, signal) => native(manifest, async request => {
    if (new URL(request.url).pathname !== '/v1/chat/completions') return handle(request);
    const body = await request.json(); body.max_tokens = 1025;
    return handle(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body), signal: request.signal }));
  }, signal);
  await failClosed(f); expect(f.counts()).toEqual({ requests: 0, launches: 1, executorCreations: 1, reads: 0, closes: 1 });
  expect(f.ledger.status(f.config.allocationId)!.attemptCount).toBe(0);
});
test('third and fourth model RPCs after the valid final answer cannot add paid attempts', async () => {
  const f = runtimeFixture(), native = f.deps.launch!, rejected: boolean[] = [];
  f.deps.launch = async (manifest, handle, signal) => {
    const result = await native(manifest, handle, signal);
    for (let rpc = 3; rpc <= 4; rpc++) {
      try {
        const response = await handle(new Request(new URL('/v1/chat/completions', manifest.modelBaseUrl), { method: 'POST',
          headers: { authorization: 'Bearer ' + manifest.capability, 'content-type': 'application/json' },
          body: JSON.stringify({ model: manifest.model, messages: [{ role: 'system', content: manifest.systemPrompt }, ...result.history!],
            tools: manifest.tools, max_tokens: manifest.maxTokens, temperature: manifest.temperature, stream: false }) }));
        rejected.push(!response.ok);
      } catch { rejected.push(true); }
    }
    return result;
  };
  await failClosed(f); expect(rejected).toEqual([true, true]);
  expect(f.counts()).toEqual({ requests: 2, launches: 1, executorCreations: 1, reads: 1, closes: 1 });
  expect(f.ledger.status(f.config.allocationId)).toMatchObject({ attemptCount: 2, unknownAttempts: 0 });
});
test('a repeated cached read cannot replace fresh physical-read evidence or permit another model call', async () => {
  const f = runtimeFixture(), provider = f.deps.route.fetch;
  f.deps.route.fetch = async request => {
    const response = await provider(request), body = await response.json();
    if (body.id === 'offline-reply-2') {
      body.content = [{ type: 'tool_use', id: 'challenge-read-again', name: 'read_file', input: { path: 'challenge.json' } }];
      body.stop_reason = 'tool_use';
    }
    return Response.json(body);
  };
  await failClosed(f); expect(f.counts()).toEqual({ requests: 2, launches: 1, executorCreations: 1, reads: 1, closes: 1 });
  expect(f.ledger.status(f.config.allocationId)).toMatchObject({ attemptCount: 2, unknownAttempts: 0 });
});
test('absolute deadline expiry during an actual read prevents further paid work without waiting', async () => {
  const f = runtimeFixture(), expired = Date.now() + 121_000; let restore = () => {};
  f.hooks.afterRead = () => { const clock = spyOn(Date, 'now').mockReturnValue(expired); restore = () => clock.mockRestore(); };
  try { await failClosed(f); }
  finally { restore(); }
  expect(f.counts()).toEqual({ requests: 1, launches: 1, executorCreations: 1, reads: 1, closes: 1 });
  expect(f.ledger.status(f.config.allocationId)!.attemptCount).toBe(1);
});
test('21 historical incomplete Gary actions remain unchanged and do not block a separate read-only receipt', async () => {
  const f = runtimeFixture();
  for (let index = 0; index < 21; index++) {
    const ticket = 'historical-ticket-' + index;
    upsertTicket(f.db, { linearId: ticket, identifier: 'OLD-' + index });
    recordActionStart(f.db, { ticketLinearId: ticket, stateFingerprint: 'historical-' + index, actionType: 'start_coding', provider: 'z.ai', model: 'glm-5.3' });
  }
  const actions = f.db.query('SELECT * FROM actions ORDER BY id').all(), tickets = f.db.query('SELECT * FROM tickets ORDER BY linear_id').all();
  expect(actions).toHaveLength(21); expect(f.db.query('SELECT count(*) AS n FROM actions WHERE completed_at IS NULL').get()).toEqual({ n: 21 });
  const canary = createReadonlyCanary(f.config, f.deps); await canary.run(); expect(canary.check().ready).toBe(true);
  expect(f.db.query('SELECT * FROM actions ORDER BY id').all()).toEqual(actions);
  expect(f.db.query('SELECT * FROM tickets ORDER BY linear_id').all()).toEqual(tickets);
  expect(f.counts().requests).toBe(2);
});

for (const mode of ['draft', 'large-campaign', 'small-allocation', 'closed', 'wrong-campaign'] as const) test('fresh exact allocation admission rejects ' + mode + ' before launch', async () => {
  const f = runtimeFixture({ draft: mode === 'draft', campaignCap: mode === 'large-campaign' ? 10 : 5, allocationCap: mode === 'small-allocation' ? 4 : 5 });
  if (mode === 'closed') f.ledger.markTerminal(f.config.allocationId, 'already-used');
  if (mode === 'wrong-campaign') f.config.campaignId = 'different-campaign';
  await failClosed(f); expect(f.counts()).toEqual({ requests: 0, launches: 0, executorCreations: 0, reads: 0, closes: 0 });
});
for (const unknown of [false, true]) test('preexisting ' + (unknown ? 'unknown' : 'settled') + ' spend cannot acquire a fresh smoke run', async () => {
  const f = runtimeFixture();
  const guarded = f.ledger.guardedFetch('deepseek', (async () => Response.json({ id: 'prior-offline-attempt', type: 'message', role: 'assistant', model: 'deepseek-v4-pro',
    content: [{ type: 'text', text: 'Earlier independent fixture' }], stop_reason: 'end_turn',
    ...(unknown ? {} : { usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) })) as unknown as typeof fetch);
  await f.ledger.withSpendScope(f.config.allocationId, () => guarded('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-pro', max_tokens: 128, messages: [{ role: 'user', content: 'Offline fixture' }] }) }));
  expect(f.ledger.status(f.config.allocationId)!.attemptCount).toBe(1);
  expect(f.ledger.status(f.config.allocationId)!.unknownAttempts).toBe(unknown ? 1 : 0);
  await failClosed(f); expect(f.counts()).toEqual({ requests: 0, launches: 0, executorCreations: 0, reads: 0, closes: 0 });
});
test('one-shot claim excludes a concurrent runner before another executor or model call', async () => {
  const f = runtimeFixture(), entered = deferred(), release = deferred();
  f.hooks.beforeLaunch = async () => { entered.resolve(); await release.promise; };
  const first = createReadonlyCanary(f.config, f.deps), second = createReadonlyCanary(f.config, f.deps);
  const running = first.run();
  try { await Promise.race([entered.promise, running]); await expect(second.run()).rejects.toThrow('readonly_canary_already_attempted');
    expect(f.counts()).toEqual({ requests: 0, launches: 1, executorCreations: 1, reads: 0, closes: 0 }); }
  finally { release.resolve(); }
  await running; expect(first.check().ready).toBe(true); expect(f.counts().requests).toBe(2);
});
test('verified receipt survives reopened canonical handles; a restart cannot spend again', async () => {
  const f = runtimeFixture(), first = createReadonlyCanary(f.config, f.deps); await first.run(); const receipt = first.check();
  const db = openDb(f.dbPath), ledger = new SpendLedger(f.ledgerPath); cleanups.push(() => db.close(), () => ledger.close());
  const restarted = createReadonlyCanary(loadReadonlyCanaryConfig(f.path), { ...f.deps, db, ledger });
  expect(restarted.check()).toEqual(receipt); await expect(restarted.run()).rejects.toThrow('readonly_canary_already_attempted');
  expect(f.counts().requests).toBe(2); expect(f.counts().executorCreations).toBe(1);
  const differentRelease = createReadonlyCanary({ ...f.config, releaseCommit: 'b'.repeat(40) }, { ...f.deps, db, ledger });
  expect(differentRelease.check().ready).toBe(false); await expect(differentRelease.run()).rejects.toThrow(); expect(f.counts().requests).toBe(2);
});
test('a failed run and a different run ID cannot reuse the consumed allocation', async () => {
  const f = runtimeFixture({ mode: 'bad-answer' }); await failClosed(f); const before = f.counts();
  await expect(createReadonlyCanary(f.config, f.deps).run()).rejects.toThrow('readonly_canary_already_attempted');
  await expect(createReadonlyCanary({ ...f.config, runId: 'new-run-id' }, f.deps).run()).rejects.toThrow();
  expect(f.counts()).toEqual(before);
});

for (const mode of ['native-error', 'native-cap', 'wrong-request', 'wrong-history'] as const) test('valid RPC exchange still rejects ' + mode, async () => {
  const f = runtimeFixture(); f.hooks.afterNative = value => mode === 'native-error' ? { ...value, status: 'error' }
    : mode === 'native-cap' ? { ...value, status: 'iteration_cap' }
    : mode === 'wrong-request' ? { ...value, requestId: 'incorrect-request' }
    : { ...value, history: [...value.history!, { role: 'assistant', content: 'invented extra message' }] };
  await failClosed(f); expect(f.counts().requests).toBe(2); expect(f.counts().reads).toBe(1); expect(f.counts().closes).toBe(1);
});

for (const mode of ['fixture', 'trace', 'row'] as const) test('reopened readiness rejects altered ' + mode + ' evidence', async () => {
  const f = runtimeFixture(), canary = createReadonlyCanary(f.config, f.deps); await canary.run(); expect(canary.check().ready).toBe(true);
  const row = f.db.query('SELECT * FROM hermes_readonly_canaries').get() as Record<string, unknown>;
  if (mode === 'fixture') { chmodSync(f.challengePath(), 0o600); writeFileSync(f.challengePath(), readFileSync(f.challengePath(), 'utf8') + '\n'); chmodSync(f.challengePath(), 0o444); }
  if (mode === 'trace') writeFileSync(String(row.trace_path), readFileSync(String(row.trace_path), 'utf8') + '\n');
  if (mode === 'row') f.db.query('UPDATE hermes_readonly_canaries SET receipt_id=?').run('sha256:' + '0'.repeat(64));
  const db = openDb(f.dbPath), ledger = new SpendLedger(f.ledgerPath); cleanups.push(() => db.close(), () => ledger.close());
  expect(createReadonlyCanary(f.config, { ...f.deps, db, ledger }).check().ready).toBe(false);
  expect(f.counts().requests).toBe(2);
});

test.skipIf(process.env.GARY_READONLY_CANARY_NATIVE_TEST !== '1')('opt-in actual pinned native runtime and read-only Docker executor with fake provider only', async () => {
  const fixtureRoot = process.env.GARY_READONLY_CANARY_NATIVE_FIXTURE_ROOT;
  expect(fixtureRoot).toBeTruthy();
  const f = runtimeFixture({ baseDirectory: realpathSync(fixtureRoot!) });
  delete f.deps.launch; delete f.deps.createExecutor;
  const canary = createReadonlyCanary(f.config, f.deps); await canary.run();
  expect(canary.check()).toMatchObject({ kind: 'readonly_runtime', ready: true, readonlyCanarySucceeded: true });
  expect(f.counts().requests).toBeGreaterThanOrEqual(2); expect(f.counts().requests).toBeLessThanOrEqual(3);
  expect(f.ledger.status(f.config.allocationId)).toMatchObject({ state: 'closed', terminalReason: 'verified_readonly', unknownAttempts: 0 });
}, 180_000);
