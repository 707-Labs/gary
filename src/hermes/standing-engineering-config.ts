/** Standing capability and infrastructure, separate from historical acceptance
 * receipts. Loading never enrolls a budget, contacts a service, or starts work. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import { parseEngineeringResourceLockBinding, type EngineeringResourceLockBinding } from '../executors/engineering-resource-binding.ts';
import { ENGINEERING_WORKER_IMAGE } from './engineering-native-launcher.ts';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const path = z.string().refine(v => isAbsolute(v) && normalize(v) === v && !/[\0\r\n,]/.test(v));
export const ENGINEERING_ROUTINE_TOOLS_SHA256 = '299764771687acb7c2434847d2e57ef4181d4473cac5da4bfdeb8b3588954b59';
const routine = z.object({ version: z.literal(1), toolsProfileSha256: z.literal(ENGINEERING_ROUTINE_TOOLS_SHA256),
  scopedRoot: path, integrityKeyPath: path, integrityKeySha256: sha,
  dependencyDownloads: z.literal(true), allowLifecycleScripts: z.boolean() }).strict();
export type StandingEngineeringRoutineConfig = Readonly<z.infer<typeof routine>>;
const funding = z.object({ version: z.literal(1), poolId: id, campaignId: id,
  capMicros: z.number().int().safe().positive(), taskCapMicros: z.number().int().safe().min(2_816_878),
  authoritySha256: sha, holdReceiptSha256: sha }).strict();
const schema = z.object({ version: z.literal(1), kind: z.literal('standing_engineering'), grantId: id,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/), authoritySha256: sha,
  requesterId: z.literal('U0A9M5W16F8'), teamId: z.literal('T0AA24R7VUZ'), organization: z.literal('707-Labs'),
  surface: z.literal('private_dm'), repositoryAccess: z.literal('current_existing_github_app'),
  root: path, workspacesRoot: path, deadlineMs: z.number().int().min(60_000).max(150 * 60_000),
  routine: routine.optional(),
  workerImage: z.literal(ENGINEERING_WORKER_IMAGE), executorImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bunCacheVolume: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  dockerExecutable: z.literal('/usr/local/bin/docker'), dockerSocketPath: z.literal('/Users/tanner/.colima/default/docker.sock'),
  runtimeFiles: z.array(z.object({ path, sha256: sha }).strict()).min(2).max(8),
  resourceLock: z.unknown(), funding, fundingAuthorityPath: path, fundingHoldReceiptPath: path, aggregatePath: path,
  publication: z.literal('patch_only'), mergeAllowed: z.literal(false), deploymentAllowed: z.literal(false),
}).strict();
export type StandingEngineeringRuntimeConfig = Readonly<Omit<z.infer<typeof schema>, 'resourceLock'> & {
  resourceLock: Readonly<EngineeringResourceLockBinding>;
}>;
const authoritySchema = z.object({ version: z.literal(1), kind: z.literal('standing_engineering_authority'),
  grantId: id, requesterId: z.literal('U0A9M5W16F8'), teamId: z.literal('T0AA24R7VUZ'),
  sourceThreadId: id, userApprovalEvidenceSha256: sha,
  scope: z.literal('707-Labs-existing-app-isolated-engineering'),
  ordinaryOwnerDMTasks: z.literal(true), mergeAllowed: z.literal(false), deploymentAllowed: z.literal(false),
}).strict();
function fail(reason: string): never { throw new Error('standing_engineering_config:' + reason); }
function overlaps(a: string, b: string): boolean {
  const inside = (x: string, y: string) => { const r = relative(x, y); return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep); };
  return inside(a, b) || inside(b, a);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Pure validation is exported for offline review/tests. It confers no authority. */
export function parseStandingEngineeringConfig(input: unknown): StandingEngineeringRuntimeConfig {
  const value = schema.parse(input);
  if (overlaps(value.root, value.workspacesRoot) || value.funding.taskCapMicros > value.funding.capMicros
      || new Set(value.runtimeFiles.map(f => f.path)).size !== value.runtimeFiles.length) fail('scope');
  if (!value.routine && value.deadlineMs > 30 * 60_000) fail('legacy_deadline');
  if (value.routine) {
    if (overlaps(value.routine.scopedRoot, value.workspacesRoot) || overlaps(value.routine.scopedRoot, value.root)
        || overlaps(value.routine.integrityKeyPath, value.workspacesRoot)
        || overlaps(value.routine.integrityKeyPath, value.routine.scopedRoot)) fail('routine_scope');
    if (value.runtimeFiles.map(f => basename(f.path)).sort().join(',') !==
        'gary_engineering_environment.py,gary_engineering_runtime.py,gary_engineering_task_tools.py') fail('routine_sources');
  }
  return freeze({ ...value, resourceLock: parseEngineeringResourceLockBinding(value.resourceLock) });
}
function privateBytes(file: string, expected: string, limit: number, privateMode = true): Buffer {
  if (!sha.safeParse(expected).success || !path.safeParse(file).success || realpathSync(file) !== file) fail('file');
  const before = lstatSync(file), parent = lstatSync(dirname(file));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || before.size > limit || !parent.isDirectory() || parent.isSymbolicLink()
      || privateMode && ((before.mode & 0o777) !== 0o600 || (parent.mode & 0o777) !== 0o700)) fail('file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('file_changed');
    bytes = readFileSync(fd);
    const after = fstatSync(fd), current = lstatSync(file);
    if (bytes.length !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size
        || current.mode !== opened.mode || current.nlink !== 1 || realpathSync(file) !== file) fail('file_changed');
  } finally { closeSync(fd); }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) fail('pin');
  return bytes;
}
/** Host-only secret read. Config results contain its pin/path, never its bytes. */
export function readStandingEngineeringIntegrityKey(config: StandingEngineeringRoutineConfig): Buffer {
  const bytes = privateBytes(config.integrityKeyPath, config.integrityKeySha256, 4096);
  if (bytes.length < 32) { bytes.fill(0); fail('integrity_key'); }
  return bytes;
}
export function loadStandingEngineeringConfig(file: string, expectedSha: string, authorityFile: string, authoritySha: string): StandingEngineeringRuntimeConfig {
  if (file === authorityFile) fail('separate_authority');
  const value = parseStandingEngineeringConfig(JSON.parse(privateBytes(file, expectedSha, 65_536).toString('utf8')));
  const authority = authoritySchema.parse(JSON.parse(privateBytes(authorityFile, authoritySha, 65_536).toString('utf8')));
  if (value.authoritySha256 !== authoritySha || value.grantId !== authority.grantId || dirname(file) !== value.root) fail('authority_binding');
  for (const root of [value.root, value.workspacesRoot, ...(value.routine ? [value.routine.scopedRoot] : [])]) {
    const s = lstatSync(root);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700 || realpathSync(root) !== root) fail('directory');
  }
  for (const f of value.runtimeFiles) privateBytes(f.path, f.sha256, 2 * 1024 * 1024, false);
  if (value.routine) readStandingEngineeringIntegrityKey(value.routine).fill(0);
  return value;
}
