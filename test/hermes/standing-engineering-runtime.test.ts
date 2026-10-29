/** Offline integration only: real temp SQLite/profile/host; no Git, Docker, model or network execution. */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpendLedger } from '../../src/spend.ts';
import { createStandingEngineeringBudget } from '../../src/hermes/engineering-standing-budget.ts';
import { createEngineeringRuntime, type EngineeringRuntimeOptions } from '../../src/hermes/engineering-runtime.ts';
import { assertEngineeringVerificationProfile } from '../../src/hermes/engineering-verification-profile.ts';
import type { EngineeringExecutionOptions } from '../../src/hermes/engineering-execution.ts';
import { openEngineeringRoutineServices } from '../../src/hermes/engineering-routine-composition.ts';
import { assertEngineeringDependencyAdmission } from '../../src/hermes/engineering-dependency-admission.ts';
import { ENGINEERING_ROUTINE_TOOLS_SHA256, type StandingEngineeringRuntimeConfig } from '../../src/hermes/standing-engineering-config.ts';
import type { EngineeringIngressRequest, EngineeringReceipt } from '../../src/slack/service.ts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
const signal = () => new AbortController().signal;
const lock = { path: '/private/tmp/apple-release-xcode.lock', dev: 16777232, ino: 176033673,
  uid: 501, mode: 0o644, nlink: 1, bootSessionUUID: '02D97A38-83D2-457D-967F-A01481D5EEFC', apfsVolumeUUID: '7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697' };
const repositories = ['707-Labs/alpha-project', '707-Labs/beta-project'];
function request(index: number, repository = repositories[index % 2]!): EngineeringIngressRequest {
  return { requestId: 'ordinary-' + index, eventId: 'event-' + index, eventKey: 'event-key-' + index, messageKey: 'message-' + index,
    authority: { authenticated: true, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ', surface: 'private_dm',
      channelId: 'D0C7EJELQJX', threadTs: '1234.' + String(index + 1000) },
    repository, task: 'Fix the ordinary project issue and verify it.' };
}
function fixture(enroll = true, routineMode = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'standing-engineering-runtime-'))); chmodSync(directory, 0o700);
  const root = join(directory, 'state'), workspacesRoot = join(directory, 'workspaces');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspacesRoot, { mode: 0o700 });
  const journalPath = join(root, 'engineering.sqlite'); writeFileSync(journalPath, '', { mode: 0o600 });
  const db = new Database(journalPath); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  const ledger = new SpendLedger(join(directory, 'spend.sqlite'));
  const spendDb = new Database(ledger.databasePath, { readonly: true });
  let revoked = false, executionReady = true, enrollments = 0;
  const authority = { version: 1 as const, poolId: 'standing-engineering-test-pool', campaignId: 'standing-engineering-test-campaign',
    capMicros: 6_000_000, taskCapMicros: 3_000_000, authoritySha256: 'a'.repeat(64), holdReceiptSha256: 'b'.repeat(64) };
  const assertAuthority = () => { if (revoked) throw Error('fixture_authority_revoked'); };
  const budget = createStandingEngineeringBudget({ ledger, authority, assertAuthority });
  if (enroll) { budget.enrollPool(); enrollments++; }
  cleanup.push(() => { budget.close(); db.close(); spendDb.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const config: StandingEngineeringRuntimeConfig = { version: 1, kind: 'standing_engineering', grantId: 'standing-engineering-grant',
    sourceRevision: 'c'.repeat(40), authoritySha256: 'd'.repeat(64), requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
    organization: '707-Labs', surface: 'private_dm', repositoryAccess: 'current_existing_github_app', root, workspacesRoot,
    deadlineMs: 1_800_000, workerImage: 'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',
    executorImage: 'sha256:' + 'e'.repeat(64), bunCacheVolume: 'synthetic-project-cache',
    dockerExecutable: '/usr/local/bin/docker', dockerSocketPath: '/Users/tanner/.colima/default/docker.sock', runtimeFiles: [],
    resourceLock: lock, funding: authority, fundingAuthorityPath: join(root, 'funding-authority.json'),
    fundingHoldReceiptPath: join(root, 'hold.json'), aggregatePath: join(directory, 'aggregate.json'),
    publication: 'patch_only', mergeAllowed: false, deploymentAllowed: false };
  const counts = { observations: 0, baseResolutions: 0, clones: 0, executions: 0, leases: 0, releases: 0, provider: 0 };
  const executions: EngineeringExecutionOptions[] = [], cloneRepositories: string[] = [], fetchedRefs: string[] = [];
  const remotes = new Map<string, string>(), delivered = new Map<string, EngineeringReceipt>();
  const waiters = new Map<string, (receipt: EngineeringReceipt) => void>();
  const commitFor = (repo: string) => (repo === repositories[0] ? 'a' : 'b').repeat(40);
  const branchFor = (repo: string) => repo === repositories[0] ? 'main' : 'trunk';
  let time = 1_000_000;
  const now = () => time;
  const preparations: Parameters<typeof import('../../src/hermes/engineering-dependency-preparation.ts').prepareEngineeringDependencies>[0][] = [];
  let routine: ReturnType<typeof openEngineeringRoutineServices> | undefined;
  if (routineMode) {
    const scopedRoot = join(directory, 'scoped'); mkdirSync(scopedRoot, { mode: 0o700 });
    const integrityKeyPath = join(root, 'key'); const key = Buffer.alloc(32, 73);
    writeFileSync(integrityKeyPath, key, { mode: 0o600 });
    Object.assign(config, { deadlineMs: 150 * 60_000, routine: { version: 1,
      toolsProfileSha256: ENGINEERING_ROUTINE_TOOLS_SHA256, scopedRoot, integrityKeyPath,
      integrityKeySha256: createHash('sha256').update(key).digest('hex'), dependencyDownloads: true, allowLifecycleScripts: false } });
    routine = openEngineeringRoutineServices({ config: config.routine!, ledger, assertCurrent: assertAuthority, now,
      dependencies: { async prepareDependencies(input) { input.assertCurrent();
        assertEngineeringDependencyAdmission(input.dependencyAdmission, { binding: input.binding, plan: null });
        preparations.push(input); return undefined; } } });
    cleanup.push(() => routine?.close());
  }
  const options: EngineeringRuntimeOptions = { config, ...(routine ? { routine } : {}), journalDb: db, spendDb, ledger, now,
    standing: { budget, async resolveBase(resolution) {
      counts.baseResolutions++; return { branch: branchFor(resolution.repository.repo), commit: commitFor(resolution.repository.repo) };
    } },
    repository: { binding: { appId: 1, installationId: 2 }, observer: {
      async installation() { counts.observations++; return { appId: 1, installationId: 2, accountLogin: '707-Labs', contents: 'write', pullRequests: 'write', observedAtMs: now() }; },
      async repositories() { counts.observations++; return { installationId: 2, totalCount: repositories.length, observedAtMs: now(),
        repositories: repositories.map((fullName, index) => ({ repositoryId: index + 10, fullName, archived: false, disabled: false })) }; },
    }, async getCredential() { return { kind: 'app', appId: 1, installationId: 2, accountLogin: '707-Labs',
      token: 'synthetic_fixture_app_token_123456789', issuedAtMs: now(), expiresAtMs: now() + 60_000,
      permissions: { contents: 'write', pullRequests: 'write' } }; } },
    providerApiKey: 'synthetic_provider_secret', async fetch() { counts.provider++; throw Error('offline_fixture_forbids_provider'); },
    assertGrant: assertAuthority, assertRuntime() {},
    assertBudget() { if (!budget.status().enrolled) throw Error('fixture_pool_not_enrolled'); },
    assertExecutionReady() { if (!executionReady) throw Error('fixture_conversation_not_drained'); },
    async deliver(receipt) { delivered.set(receipt.taskId, receipt); waiters.get(receipt.taskId)?.(receipt); },
    dependencies: {
      resourceBinding: { inspection: { lstat(path) {
        expect(path).toBe(lock.path); return { ...lock, isFile: () => true, isSymbolicLink: () => false };
      }, realpath(path) { expect(path).toBe(lock.path); return path; } }, observeBoot() {
        return { bootSessionUUID: lock.bootSessionUUID, apfsVolumeUUID: lock.apfsVolumeUUID };
      } },
      git: { async run(invocation, header) {
        const args = invocation.args;
        expect(header !== undefined).toBe(args[0] === 'fetch');
        if (args[0] === 'init') mkdirSync(join(invocation.cwd, '.git'), { mode: 0o700 });
        if (args[0] === 'remote') {
          const repo = args[3]!.replace('https://github.com/', '').replace(/\.git$/, ''); remotes.set(invocation.cwd, repo);
          writeFileSync(join(invocation.cwd, '.git', 'config'), `[remote "origin"]\nurl = ${args[3]}\n`, { mode: 0o600 });
        }
        const repo = remotes.get(invocation.cwd)!;
        if (args[0] === 'fetch') {
          const ref = args.at(-1)!; fetchedRefs.push(ref);
          expect(ref).toBe((invocation.cwd.endsWith('/verifier') || /\/child-[12]$/.test(invocation.cwd)) ? commitFor(repo) : 'refs/heads/' + branchFor(repo));
        }
        if (args[0] === 'checkout') {
          counts.clones++; cloneRepositories.push(repo);
          const first = repo === repositories[0];
          writeFileSync(join(invocation.cwd, 'package.json'), JSON.stringify({ scripts: first ? { 'test:run': 'vitest run' } : { typecheck: 'tsc --noEmit' } }));
          if (!routineMode) writeFileSync(join(invocation.cwd, first ? 'bun.lock' : 'package-lock.json'), 'synthetic lock bytes');
        }
        return { stdout: args[0] === 'rev-parse' ? commitFor(repo) + '\n' : '' };
      } },
      async readHeadroom() { return { availableCpus: 5, availableMemoryBytes: 10 * 1024 ** 3 }; },
      async acquireLease(input) {
        counts.leases++;
        expect(input.requirements).toEqual(routineMode ? { cpus: 4, memoryBytes: 8 * 1024 ** 3 } : { cpus: 3, memoryBytes: 6 * 1024 ** 3 });
        return { signal: signal(), reference: { binding: input.binding, pid: 12345, birthToken: 'synthetic-holder', startedAtUnixNs: '1000000000000',
          lock: { path: '/fixture/lock', dev: 1, ino: 2, uid: 501, mode: 0o644, nlink: 1 }, requirements: input.requirements! },
          assertHeld() {}, async release(proof) { expect(proof).toEqual({ ...input.binding, cleanupConfirmed: true }); counts.releases++; } };
      },
      createExecution(value) {
        executions.push(value); counts.executions++;
        expect(value.baseRef).toBe(branchFor(value.task.spec.repository));
        let lease: Awaited<ReturnType<EngineeringExecutionOptions['acquireLease']>> | undefined;
        return { verifiedArtifactProof: () => null, async run() {
          value.assertOwner(); value.standingBudget!.assertCurrent();
          assertEngineeringVerificationProfile(value.verificationProfile!, { workspaceRoot: value.workspaceRoot });
          if (routineMode) {
            expect(value.tools).toHaveLength(14); expect(value.session.resourceProfile).toEqual({ cpus: 1, memoryMiB: 2048 });
            expect(value.routine!.startedAtMs).toBe(1_000_000); expect(value.task.spec.deadlineMs).toBe(10_000_000);
            expect(value.task.spec.scope.projectId).toBe('repository:' + (value.task.spec.repository === repositories[0] ? 10 : 11));
            const binding = { taskId: value.task.taskId, sessionId: value.task.sessionId!, ownerEpoch: value.task.ownerEpoch!, deadlineMs: value.task.spec.deadlineMs };
            const prepare = (workspaceRoot: string, parent: string) => value.routine!.prepareDependencies({ workspaceRoot, destination: join(parent, 'deps'),
              signal: signal(), assertCurrent: value.assertOwner, profile: value.verificationProfile!, binding, provenanceSha256: value.policy.fingerprint.slice(7) });
            expect(await prepare(value.workspaceRoot, value.snapshotDirectory)).toBeUndefined();
            const childInput = { childId: 'engineering-child-' + randomUUID(), ordinal: 1 as const, signal: signal(), assertCurrent: value.assertOwner };
            const child = await value.routine!.prepareChild(childInput);
            expect(await prepare(child.workspaceRoot, child.snapshotDirectory)).toBeUndefined();
            await expect(value.routine!.prepareChild(childInput)).rejects.toThrow('child_binding');
          } else { expect(value.tools).toHaveLength(5); expect(value.routine).toBeUndefined(); }
          lease = await value.acquireLease();
          const verifier = await value.prepareVerifier();
          assertEngineeringVerificationProfile(value.verificationProfile!, { workspaceRoot: verifier.workspaceRoot });
          if (routineMode) expect(await value.routine!.prepareDependencies({ workspaceRoot: verifier.workspaceRoot, destination: join(value.snapshotDirectory, 'verify-deps'),
            signal: signal(), assertCurrent: value.assertOwner, profile: value.verificationProfile!,
            binding: { taskId: value.task.taskId, sessionId: value.task.sessionId!, ownerEpoch: value.task.ownerEpoch!, deadlineMs: value.task.spec.deadlineMs },
            provenanceSha256: 'e'.repeat(64) })).toBeUndefined();
          expect(verifier).toHaveProperty('baseCommit', value.task.spec.baseCommit);
          return { completed: true, artifactReceiptId: randomUUID(), summary: 'Synthetic verification completed.' };
        }, async cleanup() {
          await lease?.release({ cleanupConfirmed: true });
          return { receiptId: randomUUID(), taskId: value.task.taskId, sessionId: value.task.sessionId!, ownerEpoch: value.task.ownerEpoch!, absent: true };
        } };
      },
    } };
  return { config, options, preparations, setTime(value: number) { time = value; }, counts, executions, cloneRepositories, fetchedRefs, db, budget, ledger, enrollments: () => enrollments,
    revoke() { revoked = true; }, setExecutionReady(value: boolean) { executionReady = value; },
    finished(taskId: string): Promise<EngineeringReceipt> {
      const receipt = delivered.get(taskId); return receipt ? Promise.resolve(receipt) : new Promise(resolve => waiters.set(taskId, resolve));
    } };
}

test('one standing pool admits two fresh sequential repositories and replay never executes again', async () => {
  const f = fixture(), runtime = createEngineeringRuntime(f.options);
  const receipts: EngineeringReceipt[] = [];
  for (const index of [0, 1]) {
    const input = request(index), ack = await runtime.ingress.admit(input, signal(), () => true) as EngineeringReceipt;
    expect(ack.phase).toBe('admitted'); expect(runtime.busy()).toBe(true);
    runtime.ingress.start!(ack); runtime.ingress.start!(ack);
    expect((await f.finished(ack.taskId)).status).toBe('completed');
    expect(runtime.busy()).toBe(false); receipts.push(ack);
  }
  expect(f.enrollments()).toBe(1); expect(f.counts.executions).toBe(2);
  expect(new Set(receipts.map(r => r.taskId)).size).toBe(2);
  expect(new Set(f.executions.map(e => e.task.spec.allocationId)).size).toBe(2);
  expect(f.executions.map(e => e.task.spec.repository)).toEqual(repositories);
  expect(f.executions.map(e => e.verificationProfile!.kind)).toEqual(['javascript_bun', 'javascript_npm']);
  expect(f.cloneRepositories).toEqual([repositories[0]!, repositories[0]!, repositories[1]!, repositories[1]!]);
  expect(f.fetchedRefs).toEqual(['refs/heads/main', 'a'.repeat(40), 'refs/heads/trunk', 'b'.repeat(40)]);
  expect(f.counts.leases).toBe(2); expect(f.counts.releases).toBe(2); expect(f.counts.provider).toBe(0);
  expect(f.budget.status()).toMatchObject({ enrolled: true, committedCapMicros: 6_000_000, canAllocate: false, chargedMicros: 0 });
  const before = { ...f.counts };
  expect(await runtime.ingress.admit({ ...request(0), eventId: 'redelivery' }, signal(), () => true)).toEqual(receipts[0]!);
  runtime.ingress.start!(receipts[0]!);
  expect(await runtime.ingress.admit({ ...request(0), task: 'Different task under replayed identity' }, signal(), () => true))
    .toEqual({ kind: 'rejected', code: 'invalid_request' });
  expect(await runtime.ingress.admit(request(2), signal(), () => true)).toEqual({ kind: 'rejected', code: 'budget_unavailable' });
  expect(f.counts).toEqual(before);
  await runtime.stop();
});

test('unenrolled funding rejects before repository observation, clone, lease or paid call', async () => {
  const f = fixture(false), runtime = createEngineeringRuntime(f.options);
  expect(await runtime.ingress.admit(request(0), signal(), () => true)).toEqual({ kind: 'rejected', code: 'budget_unavailable' });
  expect(f.counts).toEqual({ observations: 0, baseResolutions: 0, clones: 0, executions: 0, leases: 0, releases: 0, provider: 0 });
  expect(f.db.query('SELECT count(*) n FROM engineering_ingress_requests').get()).toEqual({ n: 0 });
  expect(f.enrollments()).toBe(0); await runtime.stop();
});

test('two host instances cannot prepare different tasks concurrently', async () => {
  const f = fixture(), first = createEngineeringRuntime(f.options), second = createEngineeringRuntime(f.options);
  const [a, b] = await Promise.all([first.ingress.admit(request(0), signal(), () => true), second.ingress.admit(request(1), signal(), () => true)]);
  expect((a as EngineeringReceipt).phase).toBe('admitted'); expect(b).toEqual({ kind: 'rejected', code: 'busy' });
  expect(f.counts.clones).toBe(1); expect(f.budget.status().committedCapMicros).toBe(3_000_000);
  first.ingress.start!(a as EngineeringReceipt); expect((await f.finished((a as EngineeringReceipt).taskId)).status).toBe('completed');
  await first.stop(); await second.stop();
});

test('foreign owner and inaccessible repository cannot execute; revoked authority after admission cannot start', async () => {
  const f = fixture(), runtime = createEngineeringRuntime(f.options);
  const original = request(0), foreign = { ...original, authority: { ...original.authority, requesterId: 'U123456789' } };
  expect(await runtime.ingress.admit(foreign, signal(), () => true)).toEqual({ kind: 'rejected', code: 'invalid_request' });
  expect(f.counts.observations).toBe(0);
  expect(await runtime.ingress.admit(request(2, '707-Labs/not-installed'), signal(), () => true)).toEqual({ kind: 'rejected', code: 'unavailable' });
  expect(f.counts.clones).toBe(0); expect(f.budget.status().committedCapMicros).toBe(0);
  const ack = await runtime.ingress.admit(request(1), signal(), () => true) as EngineeringReceipt;
  expect(ack.phase).toBe('admitted'); f.revoke(); runtime.ingress.start!(ack);
  expect((await f.finished(ack.taskId)).status).toBe('blocked');
  expect(f.counts.executions).toBe(0); expect(f.counts.leases).toBe(0); expect(f.counts.provider).toBe(0);
  await runtime.stop();
});

test('conversation execution gate blocks before sandbox construction while preserving its committed allocation', async () => {
  const f = fixture(), runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request(0), signal(), () => true) as EngineeringReceipt;
  f.setExecutionReady(false); runtime.ingress.start!(ack);
  expect((await f.finished(ack.taskId)).status).toBe('blocked');
  expect(f.counts.executions).toBe(0); expect(f.counts.leases).toBe(0); expect(f.counts.provider).toBe(0);
  expect(f.budget.status().committedCapMicros).toBe(3_000_000);
  await runtime.stop();
});


test('routine mode wires fourteen tools, immutable deadline, scoped admission and pinned independent child clone', async () => {
  const f = fixture(true, true), runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request(0), signal(), () => true) as EngineeringReceipt;
  expect(ack.phase).toBe('admitted'); runtime.ingress.start!(ack);
  expect((await f.finished(ack.taskId)).status).toBe('completed');
  expect(f.preparations).toHaveLength(3);
  expect(new Set(f.preparations.map(p => p.networkQuota)).size).toBe(1);
  expect(new Set(f.preparations.map(p => p.dependencyAdmission)).size).toBe(1);
  expect(f.preparations.map(p => p.binding.taskId)).toEqual([ack.taskId, ack.taskId, ack.taskId]);
  expect(f.fetchedRefs).toEqual(['refs/heads/main', 'a'.repeat(40), 'a'.repeat(40)]);
  expect(f.db.query('SELECT started_at_ms,deadline_ms FROM engineering_runtime_windows WHERE task_id=?').get(ack.taskId))
    .toEqual({ started_at_ms: 1_000_000, deadline_ms: 10_000_000 });
  expect(f.counts.provider).toBe(0); await runtime.stop();
});

test('routine missing services and durable deadline tampering fail before execution', async () => {
  const f = fixture(true, true), { routine: _routine, ...missing } = f.options;
  expect(() => createEngineeringRuntime(missing)).toThrow('routine_binding');
  const runtime = createEngineeringRuntime(f.options);
  const ack = await runtime.ingress.admit(request(0), signal(), () => true) as EngineeringReceipt;
  f.db.query('UPDATE engineering_runtime_windows SET deadline_ms=deadline_ms+1 WHERE task_id=?').run(ack.taskId);
  runtime.ingress.start!(ack); expect((await f.finished(ack.taskId)).status).toBe('blocked');
  expect(f.counts.executions).toBe(0); expect(f.counts.provider).toBe(0); await runtime.stop();
});

test('after a reboot standing engineering re-binds the lock once when nothing is in flight, and refuses when a container survives', async () => {
  const NEW_BOOT = '2C2DEAF4-4608-4037-97F1-6E3E007AEBA7';
  const rebooted = (containers: string[]) => {
    const f = fixture();
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'standing-reboot-lock-'))); cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const lockPath = join(tmp, 'apple-release-xcode.lock');
    const deps = f.options.dependencies!;
    const options: EngineeringRuntimeOptions = { ...f.options, dependencies: { ...deps,
      resourceBinding: { observeBoot: () => ({ bootSessionUUID: NEW_BOOT, apfsVolumeUUID: lock.apfsVolumeUUID }),
        inspection: { lstat: () => lstatSync(lockPath), realpath: path => path } },
      resourceReboot: { lockPath, dataVolumeDev: () => 1, listLabelledContainers: () => containers } } };
    return { f, options, lockPath };
  };
  const ok = rebooted([]);
  const runtime = createEngineeringRuntime(ok.options);
  expect(runtime.ready()).toBe(true);
  expect(lstatSync(ok.lockPath).mode & 0o7777).toBe(0o644);
  expect(readdirSync(join(ok.f.config.root, 'resource-boot-bindings'))).toEqual([NEW_BOOT + '.json']);
  await runtime.stop();
  const blocked = rebooted(['3f1c0ffee']);
  expect(() => createEngineeringRuntime(blocked.options)).toThrow('reboot_not_quiescent:container');
  expect(() => lstatSync(blocked.lockPath)).toThrow();
  expect(blocked.f.counts).toEqual({ observations: 0, baseResolutions: 0, clones: 0, executions: 0, leases: 0, releases: 0, provider: 0 });
});
