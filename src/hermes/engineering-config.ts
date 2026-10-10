/** Operator-reviewed, hash-pinned configuration for the first engineering acceptance. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { isSafeGitBranch } from '../git.ts';
import { ENGINEERING_ACCEPTANCE_POLICY } from './engineering-policy.ts';
import type { EngineeringContinuationConfig } from './engineering-continuation-budget.ts';
import { parseEngineeringResourceLockBinding, type EngineeringResourceLockBinding } from '../executors/engineering-resource-binding.ts';
export interface EngineeringRuntimeConfig {
  version: 1; grantId: string; allocationId: string; campaignId: string; root: string; workspacesRoot: string;
  repository: string; baseBranch: string; baseCommit: string; allowedFiles: readonly string[]; requiredCommands: readonly string[];
  deadlineMs: number; workerImage: string; executorImage: string; bunCacheVolume: string;
  dockerExecutable: '/usr/local/bin/docker'; dockerSocketPath: '/Users/tanner/.colima/default/docker.sock';
  runtimeFiles: readonly { path: string; sha256: string }[];
  resourceLock: EngineeringResourceLockBinding;
  sourceRevision: string; publication: 'patch_only'; capMicros: 5650000;
  budget: Readonly<{ aggregatePath: string; auditDir: string; runId: string; continuation?: EngineeringContinuationConfig }>;
}
export interface EngineeringAuthorityReceipt {
  version: 1; grantId: string; sourceThreadId: string; assistantMessageId: string; userMessageId: string;
  userApproval: 'yes approve go ahead'; requesterId: 'U0A9M5W16F8'; teamId: 'T0AA24R7VUZ';
  capMicros: 5650000; scope: '707-Labs-existing-app-isolated-engineering'; mergeAllowed: false; deploymentAllowed: false;
  continuationDecision?: Readonly<{ path: string; sha256: string }>;
}
const CONTINUATION_03 = 'gary-native-engineering-20261010-03';
const CONTINUATION_03_DECISION_SHA = '61c49e6a05d3a06ce8414b0ede773cb8c691a872d441fedcb821e6ee5c52a246';
function fail(): never { throw new Error('engineering_config_rejected'); }
function privateJson(path: string, expectedSha: string): unknown {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path || !/^[a-f0-9]{64}$/.test(expectedSha)) fail();
  const parent = lstatSync(dirname(path)), before = lstatSync(path);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700
      || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o777) !== 0o600 || before.size > 65_536) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes: Buffer;
  try { const st = fstatSync(fd); if (st.dev !== before.dev || st.ino !== before.ino || st.size !== before.size) fail(); bytes = readFileSync(fd); }
  finally { closeSync(fd); }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha) fail();
  return JSON.parse(bytes.toString('utf8'));
}
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function safePath(value: unknown): value is string { return typeof value === 'string' && isAbsolute(value) && normalize(value) === value && !/[\0\r\n,]/.test(value); }
function list(value: unknown, max: number): value is string[] { return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(x => typeof x === 'string' && x.length > 0 && x.length < 1024) && new Set(value).size === value.length; }
function overlaps(a: string, b: string): boolean {
  const inside = (base: string, path: string) => { const r = relative(base, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep); };
  return inside(a, b) || inside(b, a);
}
function validateContinuation(value: Record<string, unknown>, budget: Record<string, unknown>): void {
  const continuation = budget.continuation;
  if (!object(continuation) || !exact(continuation, ['version','original','predecessorJournalPath','predecessorTaskId','receiptPath',
      ...(Object.hasOwn(continuation,'ledgerRebootAttestation') ? ['ledgerRebootAttestation'] : []),
      ...(Object.hasOwn(continuation,'afterBlockedContinuation') ? ['afterBlockedContinuation'] : [])])
      || continuation.version !== 1 || !object(continuation.original)) fail();
  const original = continuation.original;
  if (!exact(original, ['aggregatePath','ledgerPath','auditDir','runId','grantId','campaignId','allocationId','sourceRevision','runtimeConfigSha256','authoritySha256'])
      || !safePath(original.aggregatePath) || !safePath(original.ledgerPath) || !safePath(original.auditDir)
      || original.aggregatePath !== budget.aggregatePath
      || original.auditDir !== join(dirname(original.auditDir), 'budget-admission')
      || original.runId !== 'gary-native-engineering-20261010-01' || original.grantId !== original.runId
      || original.campaignId !== 'gary-native-engineering-20261010-01-campaign' || value.campaignId !== original.campaignId
      || original.allocationId !== 'gary-native-engineering-20261010-01-allocation' || value.allocationId !== original.allocationId
      || value.grantId !== (Object.hasOwn(continuation,'afterBlockedContinuation') ? CONTINUATION_03 : 'gary-native-engineering-20261010-02') || budget.runId !== value.grantId
      || original.sourceRevision !== '9b8b31e7a876e320432e6aead61d5cc5902ad587'
      || original.runtimeConfigSha256 !== 'cd5324697e222dd9f8e5bca88a7cd1a5795bb584e9048366f6c5919aeae9656d'
      || original.authoritySha256 !== '883f2b010ddcf6e18793cb95aa1a921e0e6b2403a7b4cf0a77c336cff0724645'
      || continuation.predecessorTaskId !== 'engineering-1683fa3a-bde9-4d73-b000-f84f88d67b4a'
      || continuation.predecessorJournalPath !== join(dirname(original.auditDir), 'engineering.sqlite')
      || continuation.receiptPath !== join(budget.auditDir as string, 'continuation.json')) fail();
  if (Object.hasOwn(continuation,'ledgerRebootAttestation')) {
    const reboot = continuation.ledgerRebootAttestation;
    if (!object(reboot) || !exact(reboot,['path','sha256']) || reboot.path !== join(original.auditDir as string, original.runId+'.ledger-reboot.json')
        || typeof reboot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reboot.sha256)) fail();
    Object.freeze(reboot);
  }
  if (Object.hasOwn(continuation,'afterBlockedContinuation')) {
    const prior = continuation.afterBlockedContinuation;
    const priorRoot = join(dirname(dirname(original.auditDir as string)), 'engineering-v2');
    if (!object(prior) || !exact(prior,['receiptPath','receiptSha256','claimSha256','taskId'])
        || prior.receiptPath !== join(priorRoot,'budget-admission','continuation.json')
        || prior.receiptSha256 !== 'f7b68d23b79e16e291792f924882086af9e7149b8f9dd79bb80a7a25db3a150d'
        || prior.claimSha256 !== '6bdf4049a16d2165c933c1622d5f20bc91b2eb4e284673b5249c5f6b42e7b316'
        || prior.taskId !== 'engineering-438c8176-7f19-495d-9a8b-4056a141e1c8'
        || !Object.hasOwn(continuation,'ledgerRebootAttestation')
        || [value.root,value.workspacesRoot].some(root => overlaps(root as string,priorRoot))) fail();
    Object.freeze(prior);
  }
  for (const root of [value.root, value.workspacesRoot] as string[]) {
    if (overlaps(root, dirname(original.auditDir)) || overlaps(root, original.ledgerPath)) fail();
  }
  Object.freeze(original); Object.freeze(continuation);
}
export function loadEngineeringRuntimeConfig(path: string, sha: string, authorityPath: string, authoritySha: string): Readonly<EngineeringRuntimeConfig> {
  const value = privateJson(path, sha), authority = privateJson(authorityPath, authoritySha);
  if (!object(authority) || !exact(authority, ['version','grantId','sourceThreadId','assistantMessageId','userMessageId','userApproval','requesterId','teamId','capMicros','scope','mergeAllowed','deploymentAllowed',
      ...(authority.grantId === CONTINUATION_03 ? ['continuationDecision'] : [])])
      || authority.version !== 1 || authority.sourceThreadId !== '01a0fa90-833c-71cc-907b-0b3fc0e1b02d'
      || authority.assistantMessageId !== 'Sentinel_668b96adaca8819199844e4bbb4f2971'
      || authority.userMessageId !== 'Sentinel_c0289b9b991c81918b40e3a04e870894'
      || authority.userApproval !== 'yes approve go ahead' || authority.requesterId !== 'U0A9M5W16F8' || authority.teamId !== 'T0AA24R7VUZ'
      || authority.capMicros !== ENGINEERING_ACCEPTANCE_POLICY.capMicros || authority.scope !== '707-Labs-existing-app-isolated-engineering'
      || authority.mergeAllowed !== false || authority.deploymentAllowed !== false) fail();
  if (!object(value) || !exact(value, ['version','grantId','allocationId','campaignId','root','workspacesRoot','repository','baseBranch','baseCommit','allowedFiles','requiredCommands','deadlineMs',
    'workerImage','executorImage','bunCacheVolume','dockerExecutable','dockerSocketPath','runtimeFiles','resourceLock','sourceRevision','publication','capMicros','budget'])
      || value.version !== 1 || value.grantId !== authority.grantId || !['grantId','allocationId','campaignId'].every(k => typeof value[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value[k] as string))
      || !safePath(value.root) || dirname(path) !== value.root || authorityPath !== join(value.root, 'authority.json')
      || !safePath(value.workspacesRoot) || overlaps(value.root, value.workspacesRoot)
      || value.repository === undefined || typeof value.repository !== 'string' || !/^707-Labs\/[A-Za-z0-9._-]+$/.test(value.repository)
      || typeof value.baseBranch !== 'string' || !isSafeGitBranch(value.baseBranch)
      || typeof value.baseCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.baseCommit)
      || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceRevision)
      || !list(value.allowedFiles, 128) || value.allowedFiles.some(p => p.startsWith('/') || /[\\\x00-\x1f*?\[\]{}:]/.test(p)
        || p.split('/').some(s => !s || s === '.' || s === '..' || /^(?:\.git|\.beads|\.env(?:\..*)?|\.aws|\.ssh)$/i.test(s)))
      || !list(value.requiredCommands, 16) || value.requiredCommands.some(c => c.trim() !== c || /[\x00-\x1f]/.test(c))
      || value.deadlineMs !== 30 * 60_000 || value.publication !== 'patch_only' || value.capMicros !== ENGINEERING_ACCEPTANCE_POLICY.capMicros
      || value.workerImage !== 'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab'
      || value.executorImage !== 'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c'
      || value.bunCacheVolume !== 'gary-bun-cache-20261010-mulligan-4bb2fdde-v2'
      || value.dockerExecutable !== '/usr/local/bin/docker' || value.dockerSocketPath !== '/Users/tanner/.colima/default/docker.sock'
      || !object(value.budget) || !exact(value.budget, ['aggregatePath','auditDir','runId', ...(Object.hasOwn(value.budget, 'continuation') ? ['continuation'] : [])]) || !safePath(value.budget.aggregatePath)
      || value.budget.auditDir !== join(value.root, 'budget-admission') || value.budget.runId !== value.grantId
      || !Array.isArray(value.runtimeFiles) || value.runtimeFiles.length < 2 || value.runtimeFiles.length > 8) fail();
  if (Object.hasOwn(value.budget, 'continuation')) validateContinuation(value, value.budget);
  if (value.grantId === CONTINUATION_03) {
    const decision = authority.continuationDecision;
    if (!Object.hasOwn(value.budget,'continuation') || !object(decision) || !exact(decision,['path','sha256'])
        || decision.path !== join(value.root,'continuation-authority.json') || decision.sha256 !== CONTINUATION_03_DECISION_SHA) fail();
    const observed = privateJson(decision.path as string,decision.sha256 as string);
    if (!object(observed) || observed.kind !== 'trusted_delegated_continuation_03_decision'
        || observed.sourceThreadId !== authority.sourceThreadId || observed.continuationGrantId !== CONTINUATION_03
        || observed.originalGrantId !== 'gary-native-engineering-20261010-01'
        || observed.consumedContinuationGrantId !== 'gary-native-engineering-20261010-02'
        || observed.campaignId !== value.campaignId || observed.allocationId !== value.allocationId
        || observed.cumulativeCapMicros !== 5_650_000 || observed.priorSettledSpendMicros !== 114_776
        || observed.newAggregateHold !== false || observed.preserveUnknownHolds !== true || observed.replayConsumedPhases !== false
        || observed.publication !== 'patch_only'
        || observed.originalApprovalSha256 !== '883f2b010ddcf6e18793cb95aa1a921e0e6b2403a7b4cf0a77c336cff0724645') fail();
    Object.freeze(decision);
  }
  try { value.resourceLock = parseEngineeringResourceLockBinding(value.resourceLock); } catch { fail(); }
  const workspaces = lstatSync(value.workspacesRoot);
  if (!workspaces.isDirectory() || workspaces.isSymbolicLink() || workspaces.uid !== process.getuid?.()
      || (workspaces.mode & 0o777) !== 0o700 || realpathSync(value.workspacesRoot) !== value.workspacesRoot) fail();
  const seen = new Set<string>();
  for (const f of value.runtimeFiles) {
    if (!object(f) || !exact(f, ['path','sha256']) || !safePath(f.path) || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)
      || seen.has(f.path) || realpathSync(f.path) !== f.path || createHash('sha256').update(readFileSync(f.path)).digest('hex') !== f.sha256) fail();
    seen.add(f.path); Object.freeze(f);
  }
  Object.freeze(value.runtimeFiles); Object.freeze(value.allowedFiles); Object.freeze(value.requiredCommands); Object.freeze(value.budget);
  return Object.freeze(value) as unknown as Readonly<EngineeringRuntimeConfig>;
}
