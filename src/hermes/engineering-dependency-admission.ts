/** Exact public coordinates admitted from the independently acquired pristine
 * repository. A candidate lock is data, never new network authority. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { assertEngineeringDependencyPlan, createEngineeringDependencyPlan, type EngineeringDependencyPlan } from './engineering-dependency-plan.ts';
import type { EngineeringNetworkBinding } from './engineering-network-broker.ts';
import { assertEngineeringOriginalVerificationProfile, assertEngineeringVerificationProfile, type EngineeringVerificationProfile } from './engineering-verification-profile.ts';

export interface EngineeringDependencyAdmission {
  readonly binding: EngineeringNetworkBinding;
  readonly baselinePlanHash: string | null;
  readonly provenanceSha256: string;
  readonly hash: string;
}
const admitted = new WeakMap<object, ReadonlyMap<string, string>>();
function fail(reason: string): never { throw Error('engineering_dependency_admission:' + reason); }
function checkedBinding(value: EngineeringNetworkBinding): EngineeringNetworkBinding {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'deadlineMs,scopeKey,taskId'
      || typeof value.taskId !== 'string' || value.taskId.trim() !== value.taskId || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.taskId)
      || typeof value.scopeKey !== 'string' || value.scopeKey.trim() !== value.scopeKey || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.scopeKey)
      || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs <= 0) fail('binding');
  return Object.freeze({ taskId: value.taskId, scopeKey: value.scopeKey, deadlineMs: value.deadlineMs });
}
function createEngineeringDependencyAdmission(input: {
  binding: EngineeringNetworkBinding; baselinePlan: EngineeringDependencyPlan | null; provenanceSha256: string;
}): EngineeringDependencyAdmission {
  const binding = checkedBinding(input.binding);
  if (typeof input.provenanceSha256 !== 'string' || input.provenanceSha256.length !== 64
      || !/^[a-f0-9]+$/.test(input.provenanceSha256)) fail('provenance');
  const plan = input.baselinePlan;
  if (plan) {
    assertEngineeringDependencyPlan(plan);
    if (plan.provenanceSha256 !== input.provenanceSha256) fail('provenance');
  }
  const coordinates = new Map((plan?.packages ?? []).map(p => [JSON.stringify([p.name, p.version]), p.integrity]));
  const body = { binding, baselinePlanHash: plan?.hash ?? null, provenanceSha256: input.provenanceSha256 };
  const value = Object.freeze({ ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
  admitted.set(value, coordinates); return value;
}

export interface EngineeringDependencySource {
  workspaceRoot: string; profile: EngineeringVerificationProfile; provenanceSha256: string; assertCurrent(): void;
}
/** Reads only the exact current source-bound package/lock snapshots. No network
 * work or authority is created by parsing a candidate into a plan. */
export function readEngineeringDependencyPlan(options: EngineeringDependencySource): EngineeringDependencyPlan | null {
  const guard = () => {
    const result: unknown = options.assertCurrent();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); fail('asynchronous_guard'); }
    assertEngineeringVerificationProfile(options.profile, { workspaceRoot: options.workspaceRoot });
  };
  guard();
  const root = options.workspaceRoot;
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) fail('workspace');
  const original = lstatSync(root);
  if (!original.isDirectory() || original.uid !== process.getuid?.() || (original.mode & 0o022)) fail('workspace');
  const read = (name: string, maximum: number) => {
    const path = join(root, name), before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.()
        || (before.mode & 0o022) || before.size > maximum) fail('file');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail('file_changed');
      const raw = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path);
      if (raw.length !== before.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
          || named.ino !== opened.ino || named.dev !== opened.dev) fail('file_changed');
      return raw;
    } finally { closeSync(fd); }
  };
  if (options.profile.dependencyCommands.length === 0) return null;
  const lockfileName = options.profile.kind === 'javascript_npm' ? 'package-lock.json' : 'bun.lock';
  let lockfile: Buffer;
  try { lockfile = read(lockfileName, 16 * 1024 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('binary_or_missing_lockfile_unsupported');
    throw error;
  }
  const plan = createEngineeringDependencyPlan({ packageJson: read('package.json', 1024 * 1024), lockfile: { name: lockfileName, bytes: lockfile }, provenanceSha256: options.provenanceSha256 });
  guard();
  if (lstatSync(root).dev !== original.dev || lstatSync(root).ino !== original.ino) fail('workspace_changed');
  return plan;
}
/** Mint exactly once before any worker starts, from the host-authenticated
 * pristine clone. Candidate profiles structurally cannot mint network authority.
 * Reuse this same capability for author, children and candidate verification. */
export function mintEngineeringDependencyAdmission(options: EngineeringDependencySource & {
  binding: EngineeringNetworkBinding;
}): EngineeringDependencyAdmission {
  assertEngineeringOriginalVerificationProfile(options.profile, { workspaceRoot: options.workspaceRoot });
  const baselinePlan = readEngineeringDependencyPlan(options);
  return createEngineeringDependencyAdmission({ binding: options.binding, baselinePlan, provenanceSha256: options.provenanceSha256 });
}
/** Must execute before DNS/HTTP, including for a dependency-free candidate. */
export function assertEngineeringDependencyAdmission(value: EngineeringDependencyAdmission,
  input: { binding: EngineeringNetworkBinding; plan: EngineeringDependencyPlan | null }): void {
  const coordinates = value && admitted.get(value);
  if (!coordinates) fail('untrusted_admission');
  const binding = checkedBinding(input.binding);
  if (binding.taskId !== value.binding.taskId || binding.scopeKey !== value.binding.scopeKey
      || binding.deadlineMs !== value.binding.deadlineMs) fail('binding');
  if (input.plan) {
    assertEngineeringDependencyPlan(input.plan);
    for (const p of input.plan.packages) {
      if (coordinates.get(JSON.stringify([p.name, p.version])) !== p.integrity) fail('coordinate_not_admitted');
    }
  }
}
