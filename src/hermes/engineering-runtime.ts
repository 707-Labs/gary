/** Explicit host composition for one approved engineering allocation. Importing
 * performs no I/O; construction never enrolls spend or launches a workload. */
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpendLedger } from '../spend.ts';
import type { EngineeringIngress, EngineeringReceipt } from '../slack/service.ts';
import { createBunEngineeringCommandRunner } from '../executors/engineering-session.ts';
import { createSqliteEngineeringSessionJournal } from '../executors/engineering-session-journal.ts';
import { createEngineeringSessionGuardianFactory } from '../executors/engineering-session-guardian.ts';
import { acquireEngineeringResourceLease, type EngineeringResourceLeaseOptions } from '../executors/engineering-resource-lease.ts';
import { createEngineeringResourceBindingGuard, type EngineeringResourceBindingDependencies } from '../executors/engineering-resource-binding.ts';
import type { EngineeringRuntimeConfig } from './engineering-config.ts';
import type { EngineeringContinuationBaseline } from './engineering-continuation-budget.ts';
import { createEngineeringExecution, type EngineeringExecutionOptions } from './engineering-execution.ts';
import { createEngineeringHost, type HostEngineeringCleanupProof } from './engineering-host.ts';
import { createEngineeringTaskPolicy, type EngineeringTaskPolicy } from './engineering-policy.ts';
import { createEngineeringHeadroomReader } from './engineering-preflight.ts';
import { acquireEngineeringRepository, createEngineeringHostGitRunner, resolveCurrentEngineeringRepository,
  type EngineeringAppBinding, type EngineeringAppCredential, type EngineeringAppObserver,
  type EngineeringRepositoryGitRunner, type EngineeringRepositoryResolution } from './engineering-repository.ts';
import { fingerprintJson } from './audit-trace.ts';

const TOOLS_SHA256 = 'a89b173ce4f7359605dfe70a666337ad25a7ce66983bfc984405dbc2cf9ce65b';
const RESOURCES = Object.freeze({ cpus: 3, memoryBytes: 6 * 1024 ** 3 });
const EXECUTOR_RESOURCES = Object.freeze({ cpus: 2, memoryMiB: 4096 });
type Execution = ReturnType<typeof createEngineeringExecution>;
export interface EngineeringRuntimeOptions {
  /** Already verified by loadEngineeringRuntimeConfig; startup rechecks its pins. */
  config: Readonly<EngineeringRuntimeConfig>;
  journalDb: Database; spendDb: Database; ledger: SpendLedger;
  continuationBaseline?: EngineeringContinuationBaseline;
  repository: { binding: EngineeringAppBinding; observer: EngineeringAppObserver; getCredential(repo: string): Promise<EngineeringAppCredential> };
  providerApiKey: string; fetch(request: Request): Promise<Response>;
  assertGrant(): void; assertBudget(): void; assertRuntime(): void;
  deliver(receipt: EngineeringReceipt): Promise<unknown>;
  now?: () => number;
  /** Trusted composition seams for offline fixtures, never config/model fields. */
  dependencies?: {
    git?: EngineeringRepositoryGitRunner;
    createExecution?: typeof createEngineeringExecution;
    acquireLease?: (options: EngineeringResourceLeaseOptions) => ReturnType<typeof acquireEngineeringResourceLease>;
    resourceBinding?: EngineeringResourceBindingDependencies;
    resourceLease?: Pick<EngineeringResourceLeaseOptions, 'inspection' | 'spawn'>;
    readHeadroom?: ReturnType<typeof createEngineeringHeadroomReader>;
  };
}
interface PreparedRuntime {
  taskId: string; prompt: string; policy: EngineeringTaskPolicy; resolution: EngineeringRepositoryResolution;
  taskRoot: string; workspaceRoot: string; artifactsRoot: string; snapshotDirectory: string;
  executionAttempted: boolean; execution?: Execution;
}
function fail(code: string): never { throw new Error('engineering_runtime:' + code); }
function privateDirectory(path: string, create = false, exclusive = false): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) fail('private_path');
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700 || realpathSync(path) !== path) fail('private_path');
}
function privateJournal(db: Database, root: string): void {
  const path = db.filename, rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || realpathSync(path) !== path) fail('private_journal');
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) fail('private_journal');
  privateDirectory(dirname(path));
}
function pinnedTools(): readonly Record<string, unknown>[] {
  const path = fileURLToPath(new URL('../../hermes/engineering-tools.json', import.meta.url));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65_536 || realpathSync(path) !== path) fail('tools_pin');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail('tools_pin');
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  if (createHash('sha256').update(bytes).digest('hex') !== TOOLS_SHA256) fail('tools_pin');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(value) || !value.length) fail('tools_pin');
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(value); return value;
}

export function createEngineeringRuntime(options: EngineeringRuntimeOptions) {
  const { config, journalDb: db } = options, now = options.now ?? Date.now;
  if (!!config.budget.continuation !== !!options.continuationBaseline) fail('continuation_binding');
  options.assertRuntime(); options.assertGrant();
  const assertResourceBinding = createEngineeringResourceBindingGuard(config.resourceLock, options.dependencies?.resourceBinding);
  assertResourceBinding();
  privateDirectory(config.root); privateDirectory(config.workspacesRoot); privateJournal(db, config.root);
  const contains = (base: string, path: string) => { const rel = relative(base, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
  if (contains(config.root, config.workspacesRoot) || contains(config.workspacesRoot, config.root)) fail('workspace_state_overlap');
  if (db.filename === options.spendDb.filename) fail('journal_must_be_private');
  const tools = pinnedTools(), journal = createSqliteEngineeringSessionJournal(db);
  const tasksRoot = join(config.root, 'tasks'), guardianRoot = join(config.root, 'guardians');
  privateDirectory(tasksRoot, true); privateDirectory(guardianRoot, true);
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_runtime_runs(task_id TEXT PRIMARY KEY,policy_hash TEXT NOT NULL,launch_state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS engineering_runtime_receipts(receipt_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,evidence_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS engineering_runtime_leases(task_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,owner_epoch TEXT NOT NULL,reference_json TEXT NOT NULL,reference_hash TEXT NOT NULL);`);
  const append = (taskId: string, kind: string, value: unknown) => {
    const id = randomUUID(); db.query('INSERT INTO engineering_runtime_receipts VALUES(?,?,?,?)').run(id, taskId, kind, fingerprintJson(value).sha256); return id;
  };
  const git = options.dependencies?.git ?? createEngineeringHostGitRunner({ gitBinary: '/usr/bin/git', now });
  const makeExecution = options.dependencies?.createExecution ?? createEngineeringExecution;
  const acquireLease = options.dependencies?.acquireLease ?? acquireEngineeringResourceLease;
  const headroom = options.dependencies?.readHeadroom ?? createEngineeringHeadroomReader({ root: config.root });
  const prepared = new Map<string, PreparedRuntime>();
  let stopped = false, fenced = false;
  const guard = () => { if (stopped || fenced) fail('unavailable'); options.assertRuntime(); options.assertGrant(); assertResourceBinding(); };
  const host = createEngineeringHost({ db, grantId: config.grantId, allocationId: config.allocationId, now,
    assertGrant: guard, assertBudget: options.assertBudget, deliver: options.deliver,
    async prepare(request, taskId, signal) {
      guard(); signal.throwIfAborted();
      if (request.repository !== config.repository) fail('repository_scope');
      const deadlineMs = now() + config.deadlineMs;
      const resolution = await resolveCurrentEngineeringRepository(config.repository, request.authority,
        { binding: options.repository.binding, observer: options.repository.observer, audienceGrants: () => [], now });
      guard(); signal.throwIfAborted();
      const policy = createEngineeringTaskPolicy({ taskId, repository: resolution.repository, baseCommit: config.baseCommit,
        allowedFiles: config.allowedFiles, requiredCommands: config.requiredCommands, publication: config.publication });
      const stateTaskRoot = join(tasksRoot, taskId); privateDirectory(stateTaskRoot, true, true);
      const taskRoot = join(config.workspacesRoot, taskId); privateDirectory(taskRoot, true, true);
      const runtime: PreparedRuntime = { taskId, prompt: request.task, policy, resolution, taskRoot,
        workspaceRoot: join(taskRoot, 'author'), artifactsRoot: join(stateTaskRoot, 'artifacts'),
        snapshotDirectory: join(taskRoot, 'worker-snapshots'), executionAttempted: false };
      privateDirectory(runtime.artifactsRoot, true, true); privateDirectory(runtime.snapshotDirectory, true, true);
      await acquireEngineeringRepository({ taskId, resolution, base: { branch: config.baseBranch, commit: config.baseCommit },
        workspaceRoot: runtime.workspaceRoot, deadlineMs: Math.min(deadlineMs, now() + 5 * 60_000), git,
        getCredential: repo => options.repository.getCredential(repo), assertOwner: () => { guard(); signal.throwIfAborted(); },
        append: receipt => { append(taskId, 'author_' + receipt.kind, receipt); } });
      guard(); signal.throwIfAborted();
      db.query('INSERT INTO engineering_runtime_runs VALUES(?,?,\'prepared\')').run(taskId, policy.fingerprint);
      prepared.set(taskId, runtime);
      return { runtime, spec: { taskId, requestId: request.requestId, grantId: config.grantId, allocationId: config.allocationId,
        repository: config.repository, repositoryId: String(resolution.repository.repositoryId), baseCommit: config.baseCommit,
        policyHash: policy.fingerprint, deadlineMs, scope: { teamId: request.authority.teamId, surface: request.authority.surface,
          audienceId: request.authority.requesterId, projectId: config.repository.toLowerCase().replace('/', ':') } } };
    },
    async execute(task, value, signal) {
      const runtime = prepared.get(task.taskId);
      if (!runtime || runtime !== value.runtime || runtime.executionAttempted || !task.ownerEpoch || !task.sessionId) fail('execution_binding');
      const assertOwner = () => { guard(); signal.throwIfAborted(); host.store.assertOwner(task.taskId, task.ownerEpoch!); };
      assertOwner();
      runtime.executionAttempted = true;
      const changed = db.query('UPDATE engineering_runtime_runs SET launch_state=\'constructing\' WHERE task_id=? AND launch_state=\'prepared\' AND policy_hash=?')
        .run(task.taskId, runtime.policy.fingerprint);
      if (changed.changes !== 1) fail('execution_replay');
      const binding = { taskId: task.taskId, sessionId: task.sessionId, ownerEpoch: task.ownerEpoch };
      const executionOptions: EngineeringExecutionOptions = { task, policy: runtime.policy, config,
        workspaceRoot: runtime.workspaceRoot, artifactsRoot: runtime.artifactsRoot, snapshotDirectory: runtime.snapshotDirectory,
        journalDb: db, spendDb: options.spendDb, ledger: options.ledger, tools,
        ...(options.continuationBaseline ? { continuationBaseline: options.continuationBaseline } : {}),
        providerApiKey: options.providerApiKey, fetch: options.fetch, assertOwner,
        fence(reason) { fenced = true; append(task.taskId, 'fenced', { reason }); },
        session: { image: config.executorImage, runner: createBunEngineeringCommandRunner(), journal,
          guardian: createEngineeringSessionGuardianFactory({ directory: guardianRoot }), dockerBinary: config.dockerExecutable,
          dockerSocketPath: config.dockerSocketPath, bunCacheVolume: config.bunCacheVolume, resourceProfile: EXECUTOR_RESOURCES, now },
        async acquireLease() {
          assertOwner();
          const lockPin = assertResourceBinding();
          const lease = await acquireLease({
            ...(options.dependencies?.resourceLease?.inspection ? { inspection: options.dependencies.resourceLease.inspection } : {}),
            ...(options.dependencies?.resourceLease?.spawn ? { spawn: options.dependencies.resourceLease.spawn } : {}),
            binding, lockPin, requirements: RESOURCES, preflight: headroom, signal });
          try {
            const reference = structuredClone(lease.reference);
            if (fingerprintJson(reference.binding).sha256 !== fingerprintJson(binding).sha256) fail('lease_binding');
            db.query('INSERT INTO engineering_runtime_leases VALUES(?,?,?,?,?)').run(binding.taskId, binding.sessionId, binding.ownerEpoch,
              JSON.stringify(reference), fingerprintJson(reference).sha256);
          } catch {
            // No workload has been permitted yet. Release only this exact
            // acquired lease; a failed release remains held for recovery.
            try { await lease.release({ ...binding, cleanupConfirmed: true }); }
            catch { fenced = true; }
            fail('lease_reference_not_durable');
          }
          return { signal: lease.signal, assertHeld: () => lease.assertHeld(), release: proof => lease.release({ ...binding, ...proof }) };
        },
        async prepareVerifier() {
          assertOwner();
          return acquireEngineeringRepository({ taskId: task.taskId, resolution: runtime.resolution,
            base: { branch: config.baseBranch, commit: config.baseCommit }, workspaceRoot: join(runtime.taskRoot, 'verifier'),
            deadlineMs: Math.min(task.spec.deadlineMs, now() + 5 * 60_000), git, getCredential: repo => options.repository.getCredential(repo), assertOwner,
            append: receipt => { append(task.taskId, 'verifier_' + receipt.kind, receipt); } });
        } };
      runtime.execution = makeExecution(executionOptions);
      db.query('UPDATE engineering_runtime_runs SET launch_state=\'constructed\' WHERE task_id=?').run(task.taskId);
      return runtime.execution.run(runtime.prompt, signal);
    },
    async cleanup(task): Promise<HostEngineeringCleanupProof> {
      const runtime = prepared.get(task.taskId);
      if (!runtime || !task.sessionId || !task.ownerEpoch) fail('cleanup_reconciliation_required');
      let proof: HostEngineeringCleanupProof;
      if (runtime.execution) proof = await runtime.execution.cleanup();
      else {
        // This process prepared only a clone. Once construction is attempted,
        // missing execution ownership is uncertainty and cannot prove absence.
        const row = db.query<{ launch_state: string; policy_hash: string }, [string]>('SELECT launch_state,policy_hash FROM engineering_runtime_runs WHERE task_id=?').get(task.taskId);
        if (runtime.executionAttempted || row?.launch_state !== 'prepared' || row.policy_hash !== runtime.policy.fingerprint) fail('cleanup_reconciliation_required');
        proof = { taskId: task.taskId, sessionId: task.sessionId, ownerEpoch: task.ownerEpoch, absent: true,
          receiptId: append(task.taskId, 'execution_never_started', { sessionId: task.sessionId, ownerEpoch: task.ownerEpoch, policyHash: runtime.policy.fingerprint }) };
      }
      if (proof.taskId !== task.taskId || proof.sessionId !== task.sessionId || proof.ownerEpoch !== task.ownerEpoch || proof.absent !== true) fail('cleanup_binding');
      db.query('UPDATE engineering_runtime_runs SET launch_state=\'closed\' WHERE task_id=?').run(task.taskId);
      runtime.prompt = ''; return proof;
    },
  });
  // Existing durable ownership is never adopted by a new process. Explicit
  // operator reconciliation must establish physical state before replacement.
  const orphaned = !!db.query('SELECT task_id FROM engineering_tasks WHERE state IN (\'running\',\'cleanup_unknown\') LIMIT 1').get();
  if (orphaned) fenced = true;
  const ingress: EngineeringIngress = {
    admit(request, signal, isAvailable) {
      if (request.repository !== config.repository) return Promise.resolve({ kind: 'rejected', code: 'repository_unavailable' });
      if (!ready()) return Promise.resolve({ kind: 'rejected', code: 'unavailable' });
      return host.admit(request, signal, isAvailable);
    },
    verifyReceipt: value => host.verifyReceipt(value), readReceipt: input => host.readReceipt(input), start: value => host.start(value),
  };
  function ready(): boolean {
    try { guard(); return host.ready() && !db.query('SELECT task_id FROM engineering_tasks WHERE state=\'cleanup_unknown\' LIMIT 1').get(); }
    catch { return false; }
  }
  function busy(): boolean {
    return !!db.query('SELECT task_id FROM engineering_ingress_requests WHERE allocation_id=? AND stage NOT IN (\'completed\',\'blocked\',\'paused\') LIMIT 1').get(config.allocationId);
  }
  return { ingress, ready, busy, async stop() { stopped = true; await host.stop(); } };
}
