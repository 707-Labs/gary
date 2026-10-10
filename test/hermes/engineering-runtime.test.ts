import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { EngineeringResourceLockInspection } from '../../src/executors/engineering-resource-lease.ts';
import type { EngineeringResourceLockBinding } from '../../src/executors/engineering-resource-binding.ts';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpendLedger } from '../../src/spend.ts';
import { createEngineeringRuntime, type EngineeringRuntimeOptions } from '../../src/hermes/engineering-runtime.ts';
import type { EngineeringRuntimeConfig } from '../../src/hermes/engineering-config.ts';
import type { EngineeringExecutionOptions } from '../../src/hermes/engineering-execution.ts';
import type { EngineeringContinuationBaseline, EngineeringContinuationConfig } from '../../src/hermes/engineering-continuation-budget.ts';
import type { EngineeringIngressRequest, EngineeringReceipt } from '../../src/slack/service.ts';
const CURRENT_RESOURCE_LOCK = Object.freeze({ path: '/private/tmp/apple-release-xcode.lock', dev: 16777232, ino: 176033673, uid: 501, mode: 0o644, nlink: 1,
  bootSessionUUID: '02D97A38-83D2-457D-967F-A01481D5EEFC', apfsVolumeUUID: '7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697' });
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
const request: EngineeringIngressRequest = { requestId: 'request', eventId: 'event', eventKey: 'event-key', messageKey: 'message',
  authority: { authenticated: true, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ', surface: 'private_dm', channelId: 'D0C7EJELQJX', threadTs: '1234.1234' },
  repository: '707-Labs/fixture', task: 'Make the scoped edit and test it.' };
function fixture() {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-runtime-'))); chmodSync(fixtureRoot, 0o700);
  const root=join(fixtureRoot,'state'),workspacesRoot=join(fixtureRoot,'workspaces');mkdirSync(root,{mode:0o700});mkdirSync(workspacesRoot,{mode:0o700});
  const journalPath = join(root, 'engineering.sqlite'); writeFileSync(journalPath, '', { mode: 0o600 });
  const db = new Database(journalPath); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  const ledger = new SpendLedger(join(root, 'spend.sqlite'));
  ledger.createCampaign('campaign', 5.65); ledger.enrollTicket('campaign', 'allocation', 5.65);
  const spendDb = new Database(join(root, 'spend.sqlite'), { readonly: true });
  cleanups.push(() => { db.close(); spendDb.close(); ledger.close(); rmSync(fixtureRoot, { recursive: true, force: true }); });
  let resourceObserved: EngineeringResourceLockBinding = { ...CURRENT_RESOURCE_LOCK };
  let resourceBoot: { bootSessionUUID: string; apfsVolumeUUID: string } = { bootSessionUUID: CURRENT_RESOURCE_LOCK.bootSessionUUID, apfsVolumeUUID: CURRENT_RESOURCE_LOCK.apfsVolumeUUID };
  let resourceObservations = 0, providerCalls = 0;
  const inspection: EngineeringResourceLockInspection = {
    lstat(path) { expect(path).toBe(CURRENT_RESOURCE_LOCK.path); resourceObservations++; return { ...resourceObserved, isFile: () => true, isSymbolicLink: () => false }; },
    realpath(path) { expect(path).toBe(CURRENT_RESOURCE_LOCK.path); return path; },
  };
  const config: EngineeringRuntimeConfig = { resourceLock: { ...CURRENT_RESOURCE_LOCK }, version: 1, grantId: 'grant', allocationId: 'allocation', campaignId: 'campaign', root, workspacesRoot,
    repository: request.repository, baseBranch: 'main', baseCommit: 'a'.repeat(40), allowedFiles: ['src/fixture.ts'], requiredCommands: ['bun test test/fixture.test.ts'],
    deadlineMs: 1800000, workerImage: 'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',
    executorImage: 'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c', bunCacheVolume: 'gary-bun-cache-20261010-mulligan-4bb2fdde-v2',
    dockerExecutable: '/usr/local/bin/docker', dockerSocketPath: '/Users/tanner/.colima/default/docker.sock', runtimeFiles: [],
    sourceRevision: 'b'.repeat(40), publication: 'patch_only', capMicros: 5650000,
    budget: { aggregatePath: join(root, 'aggregate.json'), auditDir: join(root, 'budget-admission'), runId: 'grant' } };
  const gitCalls: { cwd: string; args: readonly string[]; authenticated: boolean }[] = [];
  const delivered: EngineeringReceipt[] = [], executions: EngineeringExecutionOptions[] = [];
  let deliveredResolve!: () => void; const finished = new Promise<void>(resolve => { deliveredResolve = resolve; });
  let observations = 0, leaseCount = 0, releaseCount = 0, headroomCount = 0, cleanupCount = 0, revoked = false;
  let baseCommit = config.baseCommit, failConstruction = false, failCleanup = false;
  let beforeLease = () => {};
  const now = () => 1_000_000;
  const options: EngineeringRuntimeOptions = { config, journalDb: db, spendDb, ledger, now,
    repository: { binding: { appId: 1, installationId: 2 }, observer: {
      async installation() { observations++; return { appId: 1, installationId: 2, accountLogin: '707-Labs', contents: 'write', pullRequests: 'write', observedAtMs: now() }; },
      async repositories() { observations++; return { installationId: 2, totalCount: 1, observedAtMs: now(), repositories: [{ repositoryId: 3, fullName: config.repository, archived: false, disabled: false }] }; },
    }, async getCredential() { return { kind: 'app', appId: 1, installationId: 2, accountLogin: '707-Labs', token: 'host-only-fake-token-'.replaceAll('-', '_').repeat(3), issuedAtMs: now(), expiresAtMs: now() + 60000, permissions: { contents: 'write', pullRequests: 'write' } }; } },
    providerApiKey: 'fake-model-secret', async fetch() { providerCalls++; throw Error('unexpected paid request'); },
    assertGrant() { if (revoked) throw Error('revoked'); }, assertRuntime() {},
    assertBudget() { const s = ledger.status('allocation'); if (s?.attemptCount !== 0 || s.capMicros !== 5650000) throw Error('budget unavailable'); },
    async deliver(value) { delivered.push(value); deliveredResolve(); },
    dependencies: {
      resourceBinding: { inspection, observeBoot() { return { ...resourceBoot }; } },
      git: { async run(invocation, header) {
        gitCalls.push({ cwd: invocation.cwd, args: invocation.args, authenticated: header !== undefined });
        const args = invocation.args;
        if (args[0] === 'init') mkdirSync(join(invocation.cwd, '.git'), { mode: 0o700 });
        if (args[0] === 'remote') writeFileSync(join(invocation.cwd, '.git', 'config'), `[remote "origin"]\nurl = ${args[3]}\n`, { mode: 0o600 });
        if (args[0] === 'checkout') { mkdirSync(join(invocation.cwd, 'src')); writeFileSync(join(invocation.cwd, 'src', 'fixture.ts'), 'export const value = 1;\n'); }
        return { stdout: args[0] === 'rev-parse' ? baseCommit + '\n' : '' };
      } },
      async readHeadroom() { headroomCount++; return { availableCpus: 5, availableMemoryBytes: 10 * 1024 ** 3 }; },
      async acquireLease(value) {
        leaseCount++; expect(value.requirements).toEqual({ cpus: 3, memoryBytes: 6 * 1024 ** 3 });
        await value.preflight(value.requirements!);
        return { signal: new AbortController().signal, reference: { binding: value.binding, pid: 12345, birthToken: 'fixture-holder-token',
          startedAtUnixNs: '1000000000000', lock: { path: '/fixture/lock', dev: 1, ino: 2, uid: 501, mode: 0o644, nlink: 1 }, requirements: value.requirements! }, assertHeld() {}, async release(proof) {
          expect(proof).toEqual({ ...value.binding, cleanupConfirmed: true }); releaseCount++;
        } };
      },
      createExecution(value) {
        executions.push(value); if (failConstruction) throw Error('construction failed');
        let lease: Awaited<ReturnType<EngineeringExecutionOptions['acquireLease']>> | undefined;
        return { async run(prompt) {
          expect(prompt).toBe(request.task); value.assertOwner(); beforeLease();
          lease = await value.acquireLease();
          const fresh = await value.prepareVerifier();
          expect(fresh.workspaceRoot).not.toBe(value.workspaceRoot);
          expect(readFileSync(join(fresh.workspaceRoot, 'src', 'fixture.ts'), 'utf8')).toContain('value = 1');
          return { completed: true, artifactReceiptId: randomUUID(), summary: 'Verified patch, fresh tests and separate review.' };
        }, async cleanup() {
          cleanupCount++; if (failCleanup) throw Error('cleanup unknown');
          await lease?.release({ cleanupConfirmed: true });
          return { receiptId: 'cleanup', taskId: value.task.taskId, sessionId: value.task.sessionId!, ownerEpoch: value.task.ownerEpoch!, absent: true };
        } };
      },
    } };
  return { root, db, ledger, config, options, gitCalls, delivered, executions, finished, inspection,
    providerCalls: () => providerCalls, resourceObservations: () => resourceObservations,
    beforeLease(fn: () => void) { beforeLease = fn; },
    replaceResourcePin(patch: Partial<typeof resourceObserved>) { resourceObserved = { ...resourceObserved, ...patch }; },
    replaceBoot(patch: Partial<typeof resourceBoot>) { resourceBoot = { ...resourceBoot, ...patch }; },
    counts: () => ({ observations, leaseCount, releaseCount, headroomCount, cleanupCount }),
    revoke() { revoked = true; }, drift() { baseCommit = 'c'.repeat(40); },
    failConstruction() { failConstruction = true; }, failCleanup() { failCleanup = true; } };
}
const signal = () => new AbortController().signal;
test('construction has no repository, workload, model or allocation side effects', async () => {
  const f = fixture(), before = f.ledger.status('allocation');
  const runtime = createEngineeringRuntime(f.options);
  expect(runtime.ready()).toBe(true); expect(runtime.busy()).toBe(false);
  expect(f.counts()).toEqual({ observations: 0, leaseCount: 0, releaseCount: 0, headroomCount: 0, cleanupCount: 0 });
  expect(f.gitCalls).toHaveLength(0); expect(f.executions).toHaveLength(0); expect(f.ledger.status('allocation')).toEqual(before);
  for (const name of ['tasks', 'guardians']) expect(lstatSync(join(f.root, name)).mode & 0o777).toBe(0o700);
  await runtime.stop(); expect(runtime.ready()).toBe(false);
});
test('exact standalone author and verifier clones, durable ack then bounded execution and verified release', async () => {
  const f = fixture(), runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
  expect(ack.phase).toBe('admitted'); expect(runtime.busy()).toBe(true); expect(f.executions).toHaveLength(0);
  expect(runtime.ingress.verifyReceipt(ack)).toBe(true);
  expect(await runtime.ingress.admit({ ...request, eventId: 'redelivery' }, signal(), () => true)).toEqual(ack);
  runtime.ingress.start!(ack); runtime.ingress.start!(ack); await f.finished;
  expect(f.executions).toHaveLength(1); expect(f.delivered[0]?.status).toBe('completed');
  const e = f.executions[0]!;
  expect(e.policy.allowedFiles).toEqual(f.config.allowedFiles); expect(e.policy.requiredCommands).toEqual(f.config.requiredCommands);
  expect(e.policy.publication).toBe('patch_only'); expect(e.task.spec.policyHash).toBe(e.policy.fingerprint);
  expect(e.session.resourceProfile).toEqual({ cpus: 2, memoryMiB: 4096 });
  expect(e.session.guardian).toBeDefined(); expect(e.session.journal).toBeDefined();
  expect(e.config.sourceRevision).toBe(f.config.sourceRevision); expect(Object.isFrozen(e.tools)).toBe(true);
  expect(e.workspaceRoot).toBe(join(f.config.workspacesRoot,ack.taskId,'author'));
  expect(e.snapshotDirectory).toBe(join(f.config.workspacesRoot,ack.taskId,'worker-snapshots'));
  expect(e.artifactsRoot).toBe(join(f.config.root,'tasks',ack.taskId,'artifacts'));
  expect(e.journalDb.filename.startsWith(f.config.workspacesRoot)).toBe(false);
  const fetches = f.gitCalls.filter(c => c.args[0] === 'fetch'); expect(fetches).toHaveLength(2);
  expect(fetches.every(c => c.authenticated && c.args.at(-1) === 'refs/heads/main')).toBe(true);
  expect(new Set(fetches.map(c => c.cwd)).size).toBe(2);
  expect(fetches.map(c=>c.cwd).sort()).toEqual([join(f.config.workspacesRoot,ack.taskId,'author'),join(f.config.workspacesRoot,ack.taskId,'verifier')]);
  expect(f.gitCalls.every(c => c.authenticated === (c.args[0] === 'fetch'))).toBe(true);
  expect(f.counts()).toMatchObject({ leaseCount: 1, releaseCount: 1, headroomCount: 1, cleanupCount: 1 });
  expect(runtime.busy()).toBe(false);
  const lease = f.db.query('SELECT reference_json FROM engineering_runtime_leases').get() as { reference_json: string };
  expect(JSON.parse(lease.reference_json)).toMatchObject({ binding: { taskId: ack.taskId }, pid: 12345, birthToken: 'fixture-holder-token' });
  expect(f.ledger.status('allocation')?.attemptCount).toBe(0);
  expect(await runtime.ingress.admit({ ...request, requestId: 'second', messageKey: 'second' }, signal(), () => true)).toEqual({ kind: 'rejected', code: 'busy' });
  const persisted = JSON.stringify(f.db.query('SELECT * FROM engineering_runtime_receipts').all());
  expect(persisted).not.toContain('fake-model-secret'); expect(persisted).not.toContain('host_only_fake_token'); expect(persisted).not.toContain(request.task);
  await runtime.stop();
});
test('unapproved repository is rejected before intent; stale base and revoked grant never launch', async () => {
  const f = fixture(), runtime = createEngineeringRuntime(f.options);
  expect(await runtime.ingress.admit({ ...request, repository: '707-Labs/other' }, signal(), () => true)).toEqual({ kind: 'rejected', code: 'repository_unavailable' });
  expect(runtime.busy()).toBe(false); expect(f.gitCalls).toHaveLength(0);
  f.drift(); expect(await runtime.ingress.admit(request, signal(), () => true)).toEqual({ kind: 'rejected', code: 'unavailable' });
  expect(f.executions).toHaveLength(0); expect(f.counts().leaseCount).toBe(0); expect(runtime.busy()).toBe(false);
  f.revoke(); expect(runtime.ready()).toBe(false); await runtime.stop();
});
test('stop before start records never-launched absence without lease or execution', async () => {
  const f = fixture(), runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
  await runtime.stop(); runtime.ingress.start!(ack);
  expect(f.executions).toHaveLength(0); expect(f.counts().leaseCount).toBe(0);
  expect(f.delivered[0]?.status).toBe('blocked');
  expect(f.db.query('SELECT launch_state FROM engineering_runtime_runs').get()).toEqual({ launch_state: 'closed' });
  expect(f.db.query("SELECT count(*) n FROM engineering_runtime_receipts WHERE kind='execution_never_started'").get()).toEqual({ n: 1 });
});
test('construction and cleanup uncertainty retain ownership; restart cannot adopt or repeat', async () => {
  for (const construction of [true, false]) {
    const f = fixture(); if (construction) f.failConstruction(); else f.failCleanup();
    const runtime = createEngineeringRuntime(f.options);
    const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
    runtime.ingress.start!(ack); await f.finished;
    expect(f.delivered[0]?.status).toBe('cleanup_unknown'); expect(runtime.ready()).toBe(false);
    const restarted = createEngineeringRuntime(f.options); expect(restarted.ready()).toBe(false); expect(restarted.busy()).toBe(true);
    restarted.ingress.start!(ack); expect(f.executions).toHaveLength(1);
    expect(await restarted.ingress.admit(request, signal(), () => true)).toEqual({ kind: 'rejected', code: 'unavailable' });
    expect(f.counts().releaseCount).toBe(0); await restarted.stop(); await runtime.stop();
  }
});
test('private storage rejects symlinks and writable journals without workload effects', () => {
  const f = fixture(); chmodSync(f.db.filename, 0o644);
  expect(() => createEngineeringRuntime(f.options)).toThrow('private_journal'); expect(f.gitCalls).toHaveLength(0);
  chmodSync(f.db.filename, 0o600); const target = join(f.root, 'other'); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(f.root, 'tasks'));
  expect(() => createEngineeringRuntime(f.options)).toThrow('private_path'); expect(f.executions).toHaveLength(0);
});
test('lease receipt persistence failure releases exact acquired lease before any workload or verifier', async () => {
  const f = fixture(), runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
  f.db.exec("CREATE TRIGGER fail_lease_receipt BEFORE INSERT ON engineering_runtime_leases BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END;");
  runtime.ingress.start!(ack); await f.finished;
  expect(f.delivered[0]?.status).toBe('blocked');
  expect(f.counts()).toMatchObject({ leaseCount: 1, releaseCount: 1, cleanupCount: 1 });
  expect(f.gitCalls.filter(c => c.args[0] === 'fetch')).toHaveLength(1);
  expect(f.db.query('SELECT count(*) n FROM engineering_runtime_leases').get()).toEqual({ n: 0 });
  expect(f.ledger.status('allocation')?.attemptCount).toBe(0); await runtime.stop();
});

test('continuation baseline is required with its configuration and passed unchanged to execution', async () => {
  const f = fixture();
  // Trusted composition fixture: production obtains this opaque value only from
  // assertEngineeringContinuationBudget; execution separately verifies it.
  const baseline = { baselineAttemptCount: 1, baselineChargedMicros: 10, receiptSha256: 'd'.repeat(64),
    assertCurrent() {}, assertPrefix() {}, assertJournal() {} } as unknown as EngineeringContinuationBaseline;
  f.options.continuationBaseline = baseline;
  expect(() => createEngineeringRuntime(f.options)).toThrow('continuation_binding');
  const original = { ...f.config.budget, ledgerPath: f.options.spendDb.filename, grantId: 'original',
    campaignId: f.config.campaignId, allocationId: f.config.allocationId, sourceRevision: 'a'.repeat(40),
    runtimeConfigSha256: 'a'.repeat(64), authoritySha256: 'b'.repeat(64) };
  const continuation: EngineeringContinuationConfig = { version: 1, original,
    predecessorJournalPath: join(f.root + '-old', 'engineering.sqlite'), predecessorTaskId: 'previous-task',
    receiptPath: join(f.config.budget.auditDir, 'continuation.json') };
  f.config.budget = { ...f.config.budget, continuation };
  delete f.options.continuationBaseline;
  expect(() => createEngineeringRuntime(f.options)).toThrow('continuation_binding');
  expect(f.gitCalls).toHaveLength(0); expect(f.executions).toHaveLength(0);
  f.options.continuationBaseline = baseline;
  const runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
  runtime.ingress.start!(ack); await f.finished;
  expect(f.executions).toHaveLength(1); expect(f.executions[0]!.continuationBaseline).toBe(baseline);
  expect(f.ledger.status('allocation')?.attemptCount).toBe(0); await runtime.stop();
});

/** Only the holder process boundary is controlled: runtime composition, binding
 * guard, actual lease admission, durable reference and cleanup all stay real.
 * No OS lock or process is opened, and the fixture never executes a workload. */
function actualLeaseWithControlledHolder(f: ReturnType<typeof fixture>, busy = false) {
  delete f.options.dependencies!.acquireLease;
  const inputs: Record<string, any>[] = [], releases: unknown[] = [];
  let killed = 0, childrenAlive = 0;
  f.options.dependencies!.resourceLease = { inspection: f.inspection,
    spawn: ((executable: string, args: string[], options: Record<string, unknown>) => {
      expect(executable).toBe('/usr/bin/python3'); expect(args.slice(0, 4)).toEqual(['-I', '-B', '-u', '-c']);
      expect(options).toEqual({ detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, cwd: '/' });
      const input = JSON.parse(args.at(-1)!); inputs.push(input);
      const child = Object.assign(new EventEmitter(), { pid: 54321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill() { killed++; return true; } });
      childrenAlive++;
      const emit = (value: Record<string, unknown>) => child.stdout.write(JSON.stringify({ birthToken: input.birthToken, ...value }) + '\n');
      let ended = false;
      const close = () => { if (!ended) { ended = true; childrenAlive--; child.emit('close', busy ? 2 : 0); } };
      child.stdin.on('data', bytes => {
        const message = JSON.parse(bytes.toString()); releases.push(message);
        expect(message).toEqual({ kind: 'release', birthToken: input.birthToken });
        queueMicrotask(() => { emit({ kind: 'released' }); close(); });
      });
      queueMicrotask(() => {
        if (busy) { emit({ kind: 'error', reason: 'busy' }); close(); }
        else emit({ kind: 'held', pid: child.pid, startedAtUnixNs: '1791666390000000000' });
      });
      return child;
    }) as unknown as typeof spawn };
  return { inputs, releases, childrenAlive: () => childrenAlive, killed: () => killed };
}

test('actual production composition passes the configured post-reboot pin into real lease admission and durable cleanup', async () => {
  const f = fixture(), holder = actualLeaseWithControlledHolder(f), runtime = createEngineeringRuntime(f.options);
  expect(runtime.ready()).toBe(true); expect(holder.inputs).toHaveLength(0);
  const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
  expect(ack.phase).toBe('admitted'); expect(holder.inputs).toHaveLength(0);
  runtime.ingress.start!(ack); await f.finished;
  expect(f.delivered[0]?.status).toBe('completed'); expect(holder.inputs).toHaveLength(1);
  const { bootSessionUUID: _boot, apfsVolumeUUID: _volume, ...expectedPin } = CURRENT_RESOURCE_LOCK;
  const input = holder.inputs[0]!;
  expect(input).toMatchObject({ ...expectedPin, binding: { taskId: ack.taskId }, requirements: { cpus: 3, memoryBytes: 6 * 1024 ** 3 } });
  expect(input).not.toHaveProperty('bootSessionUUID'); expect(input).not.toHaveProperty('apfsVolumeUUID');
  expect([input.dev, input.ino]).not.toEqual([16777229, 171769508]);
  const durable = f.db.query<{ reference_json: string }, []>('SELECT reference_json FROM engineering_runtime_leases').get()!;
  expect(JSON.parse(durable.reference_json).lock).toEqual(expectedPin);
  expect(JSON.parse(durable.reference_json)).toMatchObject({ pid: 54321, birthToken: input.birthToken, binding: input.binding });
  expect(f.counts()).toMatchObject({ leaseCount: 0, headroomCount: 1, cleanupCount: 1 });
  expect(holder.releases).toEqual([{ kind: 'release', birthToken: input.birthToken }]);
  expect(holder.childrenAlive()).toBe(0); expect(holder.killed()).toBe(0); expect(f.providerCalls()).toBe(0);
  expect(f.ledger.status('allocation')?.attemptCount).toBe(0); await runtime.stop();
});

test('stale pre-reboot pin is refused at construction before resource observation can consume a task', () => {
  const f = fixture(), holder = actualLeaseWithControlledHolder(f);
  f.config.resourceLock = { ...CURRENT_RESOURCE_LOCK, dev: 16777229, ino: 171769508 };
  expect(() => createEngineeringRuntime(f.options)).toThrow('engineering_resource_lock_identity_changed');
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name='engineering_ingress_requests'").get()).toBeNull();
  expect(holder.inputs).toHaveLength(0); expect(f.gitCalls).toHaveLength(0); expect(f.providerCalls()).toBe(0);
  expect(f.ledger.status('allocation')?.attemptCount).toBe(0);
});

test.each(['boot', 'volume', 'inode', 'device'] as const)('readiness and admission reject changed %s before intent or task consumption', async changed => {
  const f = fixture(), holder = actualLeaseWithControlledHolder(f), runtime = createEngineeringRuntime(f.options);
  if (changed === 'boot') f.replaceBoot({ bootSessionUUID: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' });
  if (changed === 'volume') f.replaceBoot({ apfsVolumeUUID: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB' });
  if (changed === 'inode') f.replaceResourcePin({ ino: CURRENT_RESOURCE_LOCK.ino + 1 });
  if (changed === 'device') f.replaceResourcePin({ dev: CURRENT_RESOURCE_LOCK.dev + 1 });
  expect(runtime.ready()).toBe(false);
  expect(await runtime.ingress.admit(request, signal(), () => true)).toEqual({ kind: 'rejected', code: 'unavailable' });
  expect(f.db.query('SELECT count(*) n FROM engineering_ingress_requests').get()).toEqual({ n: 0 });
  expect(f.db.query('SELECT count(*) n FROM engineering_tasks').get()).toEqual({ n: 0 });
  expect(holder.inputs).toHaveLength(0); expect(f.gitCalls).toHaveLength(0); expect(f.providerCalls()).toBe(0);
  expect(f.ledger.status('allocation')?.attemptCount).toBe(0); await runtime.stop();
});

test('ordinary readiness observes identity without acquisition; contending holder blocks real lease before headroom or workload', async () => {
  const f = fixture(), holder = actualLeaseWithControlledHolder(f, true), runtime = createEngineeringRuntime(f.options);
  // Operator owns the slot: metadata can pass startup while flock remains busy.
  expect(runtime.ready()).toBe(true); expect(holder.inputs).toHaveLength(0);
  const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
  runtime.ingress.start!(ack); await f.finished;
  expect(f.delivered[0]?.status).toBe('blocked'); expect(holder.inputs).toHaveLength(1);
  expect(f.counts()).toMatchObject({ headroomCount: 0, cleanupCount: 1 });
  expect(f.gitCalls.filter(c => c.args[0] === 'fetch')).toHaveLength(1); // no verifier or workload
  expect(f.db.query('SELECT count(*) n FROM engineering_runtime_leases').get()).toEqual({ n: 0 });
  const diagnostics = JSON.stringify(f.db.query('SELECT payload_json FROM engineering_diagnostics_v1').all());
  expect(diagnostics).toContain('engineering_resource_busy');
  expect(holder.releases).toEqual([]); expect(holder.childrenAlive()).toBe(0); expect(holder.killed()).toBe(0);
  expect(f.providerCalls()).toBe(0); expect(f.ledger.status('allocation')?.attemptCount).toBe(0); await runtime.stop();
});


test('serial admission rechecks the resource binding after ready and before consuming the one-use request', async () => {
  const f = fixture(), holder = actualLeaseWithControlledHolder(f), runtime = createEngineeringRuntime(f.options);
  await expect(runtime.ingress.admit(request, signal(), () => {
    f.replaceResourcePin({ ino: CURRENT_RESOURCE_LOCK.ino + 1 }); return true;
  })).rejects.toThrow('engineering_resource_lock_identity_changed');
  expect(f.db.query('SELECT count(*) n FROM engineering_ingress_requests').get()).toEqual({ n: 0 });
  expect(f.db.query('SELECT count(*) n FROM engineering_tasks').get()).toEqual({ n: 0 });
  expect(holder.inputs).toHaveLength(0); expect(f.gitCalls).toHaveLength(0); expect(f.providerCalls()).toBe(0);
  await runtime.stop();
});

test('boot drift after task start is checked again immediately before lease acquisition', async () => {
  const f = fixture(), holder = actualLeaseWithControlledHolder(f), runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request, signal(), () => true) as EngineeringReceipt;
  f.beforeLease(() => f.replaceBoot({ bootSessionUUID: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }));
  runtime.ingress.start!(ack); await f.finished;
  expect(f.delivered[0]?.status).toBe('blocked'); expect(holder.inputs).toHaveLength(0);
  expect(f.counts()).toMatchObject({ headroomCount: 0, cleanupCount: 1 });
  expect(f.db.query('SELECT count(*) n FROM engineering_runtime_leases').get()).toEqual({ n: 0 });
  expect(JSON.stringify(f.db.query('SELECT payload_json FROM engineering_diagnostics_v1').all())).toContain('engineering_resource_boot_identity_changed');
  expect(f.providerCalls()).toBe(0); expect(f.ledger.status('allocation')?.attemptCount).toBe(0);
  await runtime.stop();
});
