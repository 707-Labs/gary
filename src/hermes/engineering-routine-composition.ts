/** Host composition only. Opening private stores never enrolls funds or launches
 * a workload. Network work remains an explicit task-bound preparation call. */
import { Database } from 'bun:sqlite';
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { EngineeringDependencyAdmission } from './engineering-dependency-admission.ts';
import type { SpendLedger } from '../spend.ts';
import { createEngineeringScopedPersistence, engineeringScopedIdentity } from './engineering-scoped-persistence.ts';
import type { EngineeringSkillScope } from './engineering-skills.ts';
import { prepareEngineeringDependencies } from './engineering-dependency-preparation.ts';
import { createEngineeringNetworkQuota } from './engineering-network-broker.ts';
import { assertEngineeringVerificationProfile } from './engineering-verification-profile.ts';
import type { EngineeringProtocolBinding } from './engineering-protocol.ts';
import type { EngineeringExecutionOptions } from './engineering-execution.ts';
import { readStandingEngineeringIntegrityKey, type StandingEngineeringRoutineConfig } from './standing-engineering-config.ts';
import { fingerprintJson } from './audit-trace.ts';

type Preparation = NonNullable<EngineeringExecutionOptions['routine']>['prepareDependencies'];
export interface EngineeringRoutineServicesOptions {
  config: StandingEngineeringRoutineConfig; ledger: SpendLedger; assertCurrent(): void; now?: () => number;
  /** Trusted offline seams; never selected by config or model input. */
  dependencies?: { prepareDependencies?: typeof prepareEngineeringDependencies;
    network?: Parameters<typeof prepareEngineeringDependencies>[0]['network'] };
}
function fail(code: string): never { throw Error('engineering_routine:' + code); }
function privateDirectory(path: string, create = false): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) fail('directory');
  if (create) try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700 || realpathSync(path) !== path) fail('directory');
}

export function openEngineeringRoutineServices(options: EngineeringRoutineServicesOptions) {
  const config = Object.freeze({ ...options.config });
  options.assertCurrent(); privateDirectory(config.scopedRoot);
  const journals = join(config.scopedRoot, 'journals');
  privateDirectory(journals, true);
  const path = join(journals, 'scoped.sqlite');
  if (config.integrityKeyPath === path) fail('integrity_key_database_overlap');
  try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const identity = lstatSync(path);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.uid !== process.getuid?.()
      || (identity.mode & 0o777) !== 0o600 || realpathSync(path) !== path) fail('journal');
  const db = new Database(path, { strict: true, create: false });
  let closed = false;
  const guard = () => {
    if (closed) fail('closed'); options.assertCurrent(); privateDirectory(config.scopedRoot); privateDirectory(journals);
    const current = lstatSync(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid
        || current.nlink !== 1 || current.mode !== identity.mode || realpathSync(path) !== path) fail('journal_changed');
    readStandingEngineeringIntegrityKey(config).fill(0);
  };
  let store: ReturnType<typeof createEngineeringScopedPersistence>, integrityKey: Buffer | undefined;
  try {
    guard(); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    integrityKey = readStandingEngineeringIntegrityKey(config);
    store = createEngineeringScopedPersistence({ root: config.scopedRoot, db, ledger: options.ledger, integrityKey,
      ...(options.now ? { now: options.now } : {}) });
  } catch (error) { db.close(); throw error; }
  finally { integrityKey?.fill(0); }
  const persistence: ReturnType<typeof createEngineeringScopedPersistence> = {
    bindTask(input) { guard(); return store.bindTask({ ...input, assertCurrent() { guard(); input.assertCurrent(); } }); },
  };
  const dependencyTasks = new Set<string>();
  return { persistence, assertCurrent: guard,
    /** Exactly once per admitted execution. This closure owns its opaque shared
     * quota and source-keyed bundle cache; neither survives a task replacement. */
    taskDependencies(input: { binding: EngineeringProtocolBinding; scope: EngineeringSkillScope; dependencyAdmission: EngineeringDependencyAdmission; assertCurrent(): void }) {
      guard(); input.assertCurrent();
      if (dependencyTasks.has(input.binding.taskId)) fail('task_preparation_replay');
      dependencyTasks.add(input.binding.taskId);
      const binding = Object.freeze({ ...input.binding }), scopeKey = engineeringScopedIdentity(input.scope);
      const networkBinding = Object.freeze({ taskId: binding.taskId, scopeKey, deadlineMs: binding.deadlineMs });
      const quota = createEngineeringNetworkQuota(networkBinding);
      const workspaces = new Map<string, string>();
      const cache = new Map<string, Awaited<ReturnType<Preparation>>>();
      const current = () => { guard(); input.assertCurrent(); if ((options.now ?? Date.now)() >= binding.deadlineMs) fail('deadline'); };
      const prepare: Preparation = async request => {
        current(); request.assertCurrent(); request.signal.throwIfAborted();
        const parent = workspaces.get(request.workspaceRoot);
        if (!parent || dirname(request.destination) !== parent || resolve(request.destination) !== request.destination
            || fingerprintJson(request.binding).sha256 !== fingerprintJson(binding).sha256
            || !/^[a-f0-9]{64}$/.test(request.provenanceSha256)) fail('preparation_binding');
        privateDirectory(parent);
        assertEngineeringVerificationProfile(request.profile, { workspaceRoot: request.workspaceRoot });
        const key = fingerprintJson({ profile: request.profile.hash, provenance: request.provenanceSha256,
          scopeKey, lifecycle: config.allowLifecycleScripts }).sha256;
        const cached = cache.get(key);
        if (cached) { cached.assertCurrent(); current(); request.assertCurrent(); return cached; }
        const preparation = await (options.dependencies?.prepareDependencies ?? prepareEngineeringDependencies)({
          workspaceRoot: request.workspaceRoot, materializationRoot: request.destination, profile: request.profile,
          binding: networkBinding, networkQuota: quota, dependencyAdmission: input.dependencyAdmission, provenanceSha256: request.provenanceSha256,
          allowLifecycleScripts: config.allowLifecycleScripts,
          assertCurrent() { current(); request.assertCurrent(); request.signal.throwIfAborted(); },
          ...(options.dependencies?.network ? { network: options.dependencies.network } : {}),
        });
        current(); request.assertCurrent(); request.signal.throwIfAborted();
        preparation?.assertCurrent(); if (preparation) cache.set(key, preparation); return preparation;
      };
      return { prepare,
        registerWorkspace(workspaceRoot: string, materializationParent: string) {
          current(); privateDirectory(materializationParent);
          if (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot || workspaces.has(workspaceRoot)) fail('workspace_binding');
          workspaces.set(workspaceRoot, materializationParent);
        },
      };
    },
    /** Startup calls this only after engineering.stop() drained task writers. */
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
