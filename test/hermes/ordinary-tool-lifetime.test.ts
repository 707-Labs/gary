import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createStdioLauncher } from '../../src/hermes/stdio-launcher.ts';
import { createSessionHost } from '../../src/hermes/session-host.ts';
import type { Executor, RunOpts } from '../../src/executors/index.ts';
import { SpendLedger } from '../../src/spend.ts';

const token = 'offline-ordinary-tool-capability-xxxxxxxx';
const fixture = fileURLToPath(new URL('./fixtures/ordinary-tool-worker-fixture.py', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function bounded<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('offline fixture deadline')), ms); })])
    .finally(() => clearTimeout(timer));
}
const request = (body: Record<string, unknown>, signal?: AbortSignal) => new Request('http://127.0.0.1/tools/execute', {
  method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
});
const tool = (id: string) => ({ taskId: 'task', ownerEpoch: 'owner', token, callId: id, name: 'run_bash', arguments: { command: 'offline-held-1' } });
function setup(deadlineMs = Date.now() + 5000) {
  const started = deferred<number>(), aborted = deferred<void>(), cleanupRelease = deferred<void>();
  let runs = 0, cleaned = false, workerCleanups = 0, providerCalls = 0, runOptions: RunOpts | undefined;
  const executor: Executor = { workspaceRoot: '/offline', readFile: async () => '', writeFile: async () => {}, listFiles: async () => [], grep: async () => [],
    run: async (command, opts) => {
      runs++; runOptions = opts; const match = /^offline-held-(\d+)$/.exec(command); if (!match) throw new Error('unexpected fake command');
      started.resolve(Number(match[1]));
      await new Promise<void>(resolve => {
        const stop = () => { opts?.signal?.removeEventListener('abort', stop); aborted.resolve(); resolve(); };
        opts?.signal?.addEventListener('abort', stop, { once: true }); if (opts?.signal?.aborted) stop();
      });
      // Models the executor's awaited physical process/container/I/O cleanup.
      await cleanupRelease.promise; cleaned = true; throw new Error('cancelled after physical cleanup');
    } };
  // An isolated in-memory fixture only; no live ledger or provider is opened.
  const ledger = new SpendLedger(':memory:');
  ledger.createCampaign('offline', 1); ledger.enrollTicket('offline', 'ticket', 1);
  const host = createSessionHost({ admission: { taskId: 'task', requestId: 'request', ticketId: 'ticket', actionId: 'action', fingerprint: 'fingerprint', ownerEpoch: 'owner', deadlineMs },
    capabilityToken: token, ledger, provider: 'deepseek', model: 'deepseek-v4-pro', providerApiKey: 'offline-fixture',
    fetch: async () => { providerCalls++; throw new Error('provider must not run'); }, executor,
    allowedTools: ['run_bash', 'finish', 'report_blocked'], finishGateCommand: 'bun run ci:full',
    currentOwnerEpoch: () => 'owner', assertAdmission: () => {} });
  const launch = createStdioLauncher({ command: ['/usr/bin/python3', '-I', fixture], cwd: root, env: { PATH: '/usr/bin:/bin' },
    cleanup: async () => { workerCleanups++; } });
  const manifest = host.manifest('http://127.0.0.1/', { prompt: 'offline', systemPrompt: 'offline', maxIterations: 1, maxTokens: 32 });
  return { host, launch, manifest, started, aborted, cleanupRelease, ledger, stats: () => ({ runs, cleaned, workerCleanups, providerCalls, runOptions }) };
}

for (const trigger of ['worker_exit', 'parent_abort', 'shared_deadline'] as const) {
  test(`ordinary host command cancels and awaits physical cleanup after ${trigger}`, async () => {
    const f = setup(Date.now() + (trigger === 'shared_deadline' ? 500 : 5000)), parent = new AbortController();
    let settled = false;
    const running = f.launch(f.manifest, f.host.handle, parent.signal).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      const pid = await bounded(f.started.promise);
      expect(f.stats().runOptions?.signal?.aborted).toBe(false);
      expect(f.stats().runOptions?.deadlineMs).toBe(f.manifest.deadlineMs);
      const triggeredAt = Date.now();
      if (trigger === 'worker_exit') process.kill(pid, 'SIGTERM');
      if (trigger === 'parent_abort') parent.abort();
      await bounded(f.aborted.promise);
      const cancellationObservedAt = Date.now();
      expect(cancellationObservedAt - triggeredAt).toBeLessThan(1200);
      expect(f.stats().runOptions?.signal?.aborted).toBe(true);
      await Bun.sleep(20);
      expect(settled).toBe(false); expect(f.stats().cleaned).toBe(false);
      expect((await f.host.handle(request(tool('later')))).status).toBe(409);
      expect(f.stats().runs).toBe(1); expect(f.host.state.finishGateMet).toBe(false); expect(f.host.state.runLog).toEqual([]);
      f.cleanupRelease.resolve();
      const result = await bounded(running);
      expect('error' in result).toBe(true); expect(f.stats()).toMatchObject({ cleaned: true, runs: 1, workerCleanups: 1, providerCalls: 0 });
      const outcome = f.host.result({ status: 'finished' });
      expect(outcome.status).toBe(trigger === 'shared_deadline' ? 'timeout' : 'error');
      expect(outcome.publicationApproved).toBe(false);
      expect((await f.host.handle(request(tool('after_cleanup')))).status).toBe(409);
      expect(f.ledger.status('ticket')?.attemptCount).toBe(0);
      console.info(JSON.stringify({ fixture: 'ordinary-tool-lifetime', trigger,
        cancellationLatencyMs: cancellationObservedAt - triggeredAt,
        heldUntilCleanupReleasedMs: Date.now() - cancellationObservedAt,
        originalDeadlinePreserved: f.stats().runOptions?.deadlineMs === f.manifest.deadlineMs,
        cleanedBeforeLauncherReturned: f.stats().cleaned, providerCalls: f.stats().providerCalls }));
    } finally {
      parent.abort(); f.cleanupRelease.resolve(); await bounded(running); await f.host.drain(); f.host.dispose(); f.ledger.close();
    }
  });
}

test('an already-aborted ordinary request never starts the executor and permanently fences later work', async () => {
  const f = setup(), controller = new AbortController(); controller.abort();
  try {
    expect((await f.host.handle(request(tool('cancelled'), controller.signal))).status).toBe(409);
    expect((await f.host.handle(request(tool('later')))).status).toBe(409);
    expect(f.stats()).toMatchObject({ runs: 0, providerCalls: 0, cleaned: false });
  } finally { await f.host.drain(); f.host.dispose(); f.ledger.close(); }
});
