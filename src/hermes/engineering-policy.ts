/** Pure engineering policy. The host binds user approval; no enrollment, I/O or execution authority here. */
import { createHash } from 'node:crypto';

export const ENGINEERING_ACCEPTANCE_POLICY = Object.freeze({
  version: 1,
  approval: 'host_record_required',
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  capMicros: 5_650_000,
  maxPhysicalRequests: 4,
  work: Object.freeze({ maxRequests: 3, maxTokens: 8192, reservationMicros: 1_416_561 }),
  review: Object.freeze({ maxRequests: 1, maxTokens: 4090, reservationMicros: 1_400_317 }),
  /** Every non-review request, including retries and auxiliary generation, consumes a work slot. */
  auxiliaryRequestsCountAsWork: true,
  publication: 'draft_pr_only',
  mergeAllowed: false,
  deploymentAllowed: false,
} as const);

/** Explicit host opt-in. Twelve is a request ceiling, not a promise that twelve
 * full-context calls fit. Each next call must retain the complete review reserve;
 * only canonical settled charges, never nominal/average costs, release headroom. */
export const ENGINEERING_ACCEPTANCE_POLICY_V2 = Object.freeze({
  ...ENGINEERING_ACCEPTANCE_POLICY,
  version: 2,
  accounting: 'canonical_settlement_with_review_floor',
  inputReservationTokens: 1_048_576,
  maxPhysicalRequests: 13,
  work: Object.freeze({ ...ENGINEERING_ACCEPTANCE_POLICY.work, maxRequests: 12 }),
} as const);
export type EngineeringStandingAcceptancePolicy = Omit<typeof ENGINEERING_ACCEPTANCE_POLICY_V2, 'capMicros'> & { readonly capMicros: number };
export type EngineeringAcceptancePolicy = typeof ENGINEERING_ACCEPTANCE_POLICY | typeof ENGINEERING_ACCEPTANCE_POLICY_V2 | EngineeringStandingAcceptancePolicy;
export const ENGINEERING_STANDING_MIN_TASK_CAP_MICROS = 2_816_878;
function standingAcceptance(capMicros: number): EngineeringStandingAcceptancePolicy {
  if (!Number.isSafeInteger(capMicros) || capMicros < ENGINEERING_STANDING_MIN_TASK_CAP_MICROS) {
    throw new Error('engineering_policy_rejected:standing_task_cap');
  }
  return Object.freeze({ ...ENGINEERING_ACCEPTANCE_POLICY_V2, capMicros });
}
/** The canonical allocator separately proves that this finite task ceiling is funded. */
export function engineeringStandingBudgetPolicySha256(capMicros: number): string {
  return createHash('sha256').update(JSON.stringify(standingAcceptance(capMicros))).digest('hex');
}
export function engineeringAcceptancePolicySha256(version: 1 | 2): string {
  if (version !== 1 && version !== 2) throw new Error('engineering_policy_rejected:policy_version');
  return createHash('sha256').update(JSON.stringify(version === 1
    ? ENGINEERING_ACCEPTANCE_POLICY : ENGINEERING_ACCEPTANCE_POLICY_V2)).digest('hex');
}

export interface EngineeringHostAuthority {
  /** Set only by authenticated host ingress, never copied from message/tool arguments. */
  readonly authenticated: true;
  readonly requesterId: string;
  readonly teamId: string;
  readonly surface: 'private_dm' | 'shared_channel';
  readonly channelId: string;
  readonly threadTs: string;
}
export interface EngineeringRepositoryAccess {
  /** A current GitHub App installation observation supplied by the trusted host. */
  readonly repositoryId: number;
  readonly installationId: number;
  readonly fullName: string;
  readonly appAccessible: boolean;
  readonly contents: 'read' | 'write';
  readonly pullRequests: 'none' | 'read' | 'write';
  readonly archived: boolean;
  readonly disabled: boolean;
  /** Host audience grants, independent of GitHub App access. */
  readonly sharedChannelIds: readonly string[];
}
export interface ResolvedEngineeringRepository {
  readonly repo: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly contents: 'read' | 'write';
  readonly pullRequests: 'none' | 'read' | 'write';
  readonly authority: Readonly<EngineeringHostAuthority>;
}
export interface EngineeringTaskPolicy {
  readonly version: 1;
  readonly taskId: string;
  readonly repository: ResolvedEngineeringRepository;
  readonly baseCommit: string;
  readonly allowedFiles: readonly string[];
  readonly requiredCommands: readonly string[];
  readonly publication: 'patch_only' | 'draft_pr';
  readonly acceptance: EngineeringAcceptancePolicy;
  readonly fingerprint: string;
  /** Only the separate host constructor can mint these standing-policy fields. */
  readonly fundingKind?: 'standing';
  readonly scope?: Readonly<{ kind: 'repository' }>;
  readonly verificationProfileSha256?: string;
}
export type EngineeringRequestRole = 'work' | 'review' | 'classification' | 'repair' | 'retry' | 'summary'
  | 'compression' | 'subagent' | 'publication_body' | 'publication_title' | 'auxiliary';
export interface EngineeringRequestAttempt {
  readonly requestId: string;
  readonly role: EngineeringRequestRole;
  readonly maxTokens: number;
  /** Keep failed/unknown/aborted physical attempts; never refund a request slot. */
  readonly state: 'settled' | 'in_flight' | 'unknown';
}
export interface EngineeringRequestUsage {
  readonly attempts: readonly EngineeringRequestAttempt[];
  readonly allocationActive: boolean;
  readonly taskRemainingMicros: number;
  readonly campaignRemainingMicros: number;
  readonly unresolvedAttempts: number;
}
export interface EngineeringArtifact {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly treeHash: string;
}
interface ArtifactEvidence {
  readonly taskId: string;
  readonly policyFingerprint: string;
  readonly artifact: EngineeringArtifact;
}
export interface EngineeringTestEvidence extends ArtifactEvidence {
  readonly command: string;
  readonly completed: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number;
}
export interface EngineeringReviewEvidence extends ArtifactEvidence {
  readonly requestId: string;
  readonly independent: boolean;
  readonly completed: boolean;
  readonly verdict: 'approved' | 'changes_needed' | 'unavailable';
  readonly blockingFindings: number;
}
export interface EngineeringPublicationEvidence extends ArtifactEvidence {
  readonly worktreeClean: boolean;
  readonly changedFiles: readonly string[];
  readonly tests: readonly EngineeringTestEvidence[];
  readonly review: EngineeringReviewEvidence;
  readonly requests: readonly EngineeringRequestAttempt[];
  readonly activeOwner: boolean;
  readonly cleanupVerified: boolean;
  readonly stopReason: string | null;
  readonly unresolvedAttempts: number;
}

const OWNER = 'U0A9M5W16F8', TEAM = 'T0AA24R7VUZ';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^707-Labs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/;
const ROLES = new Set<string>(['work', 'review', 'classification', 'repair', 'retry', 'summary', 'compression',
  'subagent', 'publication_body', 'publication_title', 'auxiliary']);
const resolved = new WeakSet<object>(), policies = new WeakSet<object>();
function fail(code: string): never { throw new Error('engineering_policy_rejected:' + code); }

/** Reject accessors/extra keys before reading values; no caller object is retained. */
function data(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
      || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key)
        || !Object.hasOwn(descriptors[key]!, 'value'))) fail(code);
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function list(value: unknown, max: number, code: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
      || Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  const copy: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    copy.push(descriptor.value);
  }
  return copy;
}
function integer(value: unknown, code: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail(code);
  return value as number;
}
function identifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !ID.test(value)) fail(code);
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512 || /[\\\x00-\x1f\x7f:*?\[\]{}]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..'
        || /^(?:\.git|\.beads|\.env(?:\..*)?|\.aws|\.ssh|secrets?|credentials?)$/i.test(part))) fail('file_scope');
  return value;
}
function distinct(values: readonly string[], code: string): readonly string[] {
  if (!values.length || new Set(values).size !== values.length) fail(code);
  return Object.freeze([...values].sort());
}

/** Pure resolution of one explicit name against host observations; never discovers or grants access. */
export function resolveEngineeringRepository(requestedRepo: string, host: EngineeringHostAuthority,
  appRepositories: readonly EngineeringRepositoryAccess[]): ResolvedEngineeringRepository {
  const a = data(host, ['authenticated', 'requesterId', 'teamId', 'surface', 'channelId', 'threadTs'], 'authority');
  if (a.authenticated !== true || a.requesterId !== OWNER || a.teamId !== TEAM
      || !['private_dm', 'shared_channel'].includes(String(a.surface))
      || typeof a.channelId !== 'string' || !/^[DC][A-Z0-9]{8,20}$/.test(a.channelId)
      || (a.surface === 'private_dm' ? !a.channelId.startsWith('D') : !a.channelId.startsWith('C'))
      || typeof a.threadTs !== 'string' || !/^\d{1,20}\.\d{1,10}$/.test(a.threadTs)) fail('authority');
  if (typeof requestedRepo !== 'string') fail('repository');
  const requested = requestedRepo.includes('/') ? requestedRepo : '707-Labs/' + requestedRepo;
  if (!REPO.test(requested) || requested.endsWith('.git')) fail('repository');
  const seen = new Set<string>();
  let selected: Record<string, unknown> | undefined;
  for (const raw of list(appRepositories, 10_000, 'repository_snapshot')) {
    const row = data(raw, ['repositoryId', 'installationId', 'fullName', 'appAccessible', 'contents',
      'pullRequests', 'archived', 'disabled', 'sharedChannelIds'], 'repository_snapshot');
    integer(row.repositoryId, 'repository_snapshot', 1); integer(row.installationId, 'repository_snapshot', 1);
    if (typeof row.fullName !== 'string' || !REPO.test(row.fullName) || row.fullName.endsWith('.git')
        || !['read', 'write'].includes(String(row.contents)) || !['none', 'read', 'write'].includes(String(row.pullRequests))
        || [row.appAccessible, row.archived, row.disabled].some(value => typeof value !== 'boolean')) fail('repository_snapshot');
    const channels = list(row.sharedChannelIds, 256, 'repository_snapshot');
    if (channels.some(channel => typeof channel !== 'string' || !/^C[A-Z0-9]{8,20}$/.test(channel))
        || new Set(channels).size !== channels.length || seen.has(row.fullName.toLowerCase())) fail('repository_snapshot');
    seen.add(row.fullName.toLowerCase());
    if (row.fullName.toLowerCase() === requested.toLowerCase()) selected = row;
  }
  if (!selected || selected.appAccessible !== true || selected.archived || selected.disabled) fail('repository_unavailable');
  if (a.surface === 'shared_channel' && !(selected.sharedChannelIds as string[]).includes(a.channelId)) fail('audience');
  const result: ResolvedEngineeringRepository = Object.freeze({ repo: selected.fullName as string,
    repositoryId: selected.repositoryId as number, installationId: selected.installationId as number,
    contents: selected.contents as EngineeringRepositoryAccess['contents'],
    pullRequests: selected.pullRequests as EngineeringRepositoryAccess['pullRequests'],
    authority: Object.freeze(a as unknown as EngineeringHostAuthority) });
  resolved.add(result); return result;
}

/** Construction is not user approval. Rehydrate only by re-resolving current host authority/access. */
export function createEngineeringTaskPolicy(input: {
  taskId: string; repository: ResolvedEngineeringRepository; baseCommit: string;
  allowedFiles: readonly string[]; requiredCommands: readonly string[]; publication: 'patch_only' | 'draft_pr';
  /** Trusted host selector; absent preserves the exact v1 policy and fingerprint. */
  acceptancePolicyVersion?: 2;
}): EngineeringTaskPolicy {
  const selectedV2 = Object.hasOwn(input, 'acceptancePolicyVersion');
  const value = data(input, ['taskId', 'repository', 'baseCommit', 'allowedFiles', 'requiredCommands', 'publication',
    ...(selectedV2 ? ['acceptancePolicyVersion'] : [])], 'task');
  if (selectedV2 && value.acceptancePolicyVersion !== 2) fail('policy_version');
  const taskId = identifier(value.taskId, 'task');
  if (!value.repository || !resolved.has(value.repository as object)) fail('repository_binding');
  const repository = value.repository as ResolvedEngineeringRepository;
  if (typeof value.baseCommit !== 'string' || !SHA.test(value.baseCommit)) fail('base_commit');
  if (!['patch_only', 'draft_pr'].includes(String(value.publication))) fail('publication_mode');
  if (value.publication === 'draft_pr' && (repository.contents !== 'write' || repository.pullRequests !== 'write')) fail('publication_permissions');
  const allowedFiles = distinct(list(value.allowedFiles, 128, 'file_scope').map(path), 'file_scope');
  const requiredCommands = distinct(list(value.requiredCommands, 16, 'test_commands').map(command => {
    if (typeof command !== 'string' || !command.trim() || command !== command.trim()
        || Buffer.byteLength(command) > 1024 || /[\x00-\x1f\x7f]/.test(command)) fail('test_commands');
    return command;
  }), 'test_commands');
  const policy = { version: 1 as const, taskId, repository, baseCommit: value.baseCommit, allowedFiles, requiredCommands,
    publication: value.publication as 'patch_only' | 'draft_pr',
    acceptance: selectedV2 ? ENGINEERING_ACCEPTANCE_POLICY_V2 : ENGINEERING_ACCEPTANCE_POLICY };
  const result = Object.freeze({ ...policy, fingerprint: 'sha256:' + createHash('sha256').update(JSON.stringify(policy)).digest('hex') });
  policies.add(result); return result;
}

/** Host-only standing-grant composition. Repository access and task funding are
 * independently checked; this constructor neither discovers authority nor spends. */
export function createStandingEngineeringTaskPolicy(input: {
  taskId: string; repository: ResolvedEngineeringRepository; baseCommit: string;
  requiredCommands: readonly string[]; verificationProfileSha256: string;
  publication: 'patch_only' | 'draft_pr'; capMicros: number;
}): EngineeringTaskPolicy {
  const value = data(input, ['taskId', 'repository', 'baseCommit', 'requiredCommands',
    'verificationProfileSha256', 'publication', 'capMicros'], 'standing_task');
  const taskId = identifier(value.taskId, 'task');
  if (!value.repository || !resolved.has(value.repository as object)) fail('repository_binding');
  const repository = value.repository as ResolvedEngineeringRepository;
  if (repository.authority.surface !== 'private_dm') fail('standing_private_dm_required');
  if (typeof value.baseCommit !== 'string' || !SHA.test(value.baseCommit)) fail('base_commit');
  if (!['patch_only', 'draft_pr'].includes(String(value.publication))) fail('publication_mode');
  if (value.publication === 'draft_pr' && (repository.contents !== 'write' || repository.pullRequests !== 'write')) fail('publication_permissions');
  if (typeof value.verificationProfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.verificationProfileSha256)) fail('verification_profile');
  const requiredCommands = distinct(list(value.requiredCommands, 16, 'test_commands').map(command => {
    if (typeof command !== 'string' || !command.trim() || command !== command.trim()
        || Buffer.byteLength(command) > 1024 || /[\x00-\x1f\x7f]/.test(command)) fail('test_commands');
    return command;
  }), 'test_commands');
  const policy = { version: 1 as const, taskId, repository, baseCommit: value.baseCommit,
    allowedFiles: Object.freeze([]) as readonly string[], requiredCommands,
    publication: value.publication as 'patch_only' | 'draft_pr', acceptance: standingAcceptance(value.capMicros as number),
    fundingKind: 'standing' as const, scope: Object.freeze({ kind: 'repository' as const }),
    verificationProfileSha256: value.verificationProfileSha256 };
  const result = Object.freeze({ ...policy, fingerprint: 'sha256:' + createHash('sha256').update(JSON.stringify(policy)).digest('hex') });
  policies.add(result); return result;
}

export function isEngineeringRepositoryScopedPolicy(policy: EngineeringTaskPolicy): boolean {
  known(policy);
  return policy.fundingKind === 'standing' && policy.scope?.kind === 'repository';
}

/** Final artifact authority is a bounded repository scope, never a glob supplied
 * by the model. Capture additionally rejects unsafe inode types and ignored output. */
export function assertEngineeringTaskFileScope(policy: EngineeringTaskPolicy, raw: readonly string[]): readonly string[] {
  known(policy);
  if (!isEngineeringRepositoryScopedPolicy(policy)) {
    const changed = distinct(list(raw, 128, 'file_scope').map(path), 'file_scope');
    if (changed.some(file => !policy.allowedFiles.includes(file))) fail('file_scope');
    return changed;
  }
  const changed = distinct(list(raw, 512, 'file_scope').map(value => {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\\\x00-\x1f\x7f]/.test(value)
        || value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail('file_scope');
    for (const part of value.split('/')) {
      if (!part || part === '.' || part === '..' || part.endsWith('.') || Buffer.byteLength(part) > 255
          || /^(?:\.git|\.git-credentials|\.gitconfig|git~\d|\.hg|\.svn|\.beads|\.aws|\.ssh|\.gnupg|\.azure|\.gcloud|\.kube|\.npmrc|\.pypirc|\.netrc|\.docker|\.env.*)$/i.test(part)
          || /^(?:secrets?|credentials?|id_rsa|id_ed25519)(?:\..*)?$/i.test(part)) fail('file_scope');
    }
    return value;
  }), 'file_scope');
  if (new Set(changed.map(file => file.toLowerCase())).size !== changed.length) fail('file_scope');
  return changed;
}

function known(policy: EngineeringTaskPolicy): void {
  if (!policy || !policies.has(policy)) fail('task_policy_untrusted');
}
function attempts(raw: readonly EngineeringRequestAttempt[], limits: EngineeringAcceptancePolicy) {
  const values = list(raw, limits.maxPhysicalRequests, 'request_limit');
  const ids = new Set<string>(); let work = 0, review = 0, reservedMicros = 0;
  const records = values.map(value => {
    const a = data(value, ['requestId', 'role', 'maxTokens', 'state'], 'request_history');
    const requestId = identifier(a.requestId, 'request_history');
    if (ids.has(requestId) || typeof a.role !== 'string' || !ROLES.has(a.role)
        || !['settled', 'in_flight', 'unknown'].includes(String(a.state))) fail('request_history');
    ids.add(requestId);
    const cap = a.role === 'review' ? limits.review : limits.work;
    if (integer(a.maxTokens, 'token_limit', 1) > cap.maxTokens) fail('token_limit');
    if (a.role === 'review') review++; else work++;
    reservedMicros += cap.reservationMicros;
    return a as unknown as EngineeringRequestAttempt;
  });
  if (work > limits.work.maxRequests || review > limits.review.maxRequests
      || (limits.version === 1 && reservedMicros > limits.capMicros)) fail('request_limit');
  return { records, work, review, reservedMicros };
}

/** Conservative slot preflight only. The host must separately approve, persist and reserve atomically. */
export function assertEngineeringRequestAllowed(policy: EngineeringTaskPolicy,
  request: { requestId: string; role: EngineeringRequestRole; maxTokens: number }, usage: EngineeringRequestUsage) {
  known(policy);
  const r = data(request, ['requestId', 'role', 'maxTokens'], 'request');
  const u = data(usage, ['attempts', 'allocationActive', 'taskRemainingMicros', 'campaignRemainingMicros', 'unresolvedAttempts'], 'usage');
  if (u.allocationActive !== true || integer(u.unresolvedAttempts, 'usage') !== 0) fail('allocation_unavailable');
  const history = attempts(u.attempts as readonly EngineeringRequestAttempt[], policy.acceptance);
  if (history.records.some(a => a.state !== 'settled')) fail('request_unresolved');
  if (policy.acceptance.version === 2 && history.review !== 0) fail('review_already_completed');
  const next = attempts([...history.records, { ...r, state: 'in_flight' } as unknown as EngineeringRequestAttempt], policy.acceptance);
  const cap = r.role === 'review' ? policy.acceptance.review : policy.acceptance.work;
  const preserveReviewMicros = r.role !== 'review' && history.review === 0 ? policy.acceptance.review.reservationMicros : 0;
  const requiredHeadroomMicros = cap.reservationMicros + preserveReviewMicros;
  if (integer(u.taskRemainingMicros, 'usage') < requiredHeadroomMicros
      || integer(u.campaignRemainingMicros, 'usage') < requiredHeadroomMicros) fail('headroom');
  return Object.freeze({ reservationMicros: cap.reservationMicros, preserveReviewMicros,
    physicalRequests: next.records.length, reservedEnvelopeMicros: next.reservedMicros,
    executionAuthorized: false as const });
}

function artifact(raw: EngineeringArtifact): EngineeringArtifact {
  const value = data(raw, ['baseCommit', 'headCommit', 'treeHash'], 'artifact');
  if (Object.values(value).some(v => typeof v !== 'string' || !SHA.test(v))) fail('artifact');
  return value as unknown as EngineeringArtifact;
}
function matches(policy: EngineeringTaskPolicy, evidence: ArtifactEvidence, expected: EngineeringArtifact): void {
  const actual = artifact(evidence.artifact);
  if (evidence.taskId !== policy.taskId || evidence.policyFingerprint !== policy.fingerprint
      || actual.baseCommit !== policy.baseCommit || actual.baseCommit !== expected.baseCommit
      || actual.headCommit !== expected.headCommit || actual.treeHash !== expected.treeHash) fail('evidence_binding');
}

/** Validate host-observed evidence even when the worker never called finish. Never authorizes a push. */
export function assertEngineeringPublicationAllowed(policy: EngineeringTaskPolicy, evidence: EngineeringPublicationEvidence) {
  known(policy);
  if (policy.publication !== 'draft_pr') fail('publication_disabled');
  const e = data(evidence, ['taskId', 'policyFingerprint', 'artifact', 'worktreeClean', 'changedFiles', 'tests', 'review',
    'requests', 'activeOwner', 'cleanupVerified', 'stopReason', 'unresolvedAttempts'], 'publication_evidence');
  const exact = artifact(e.artifact as EngineeringArtifact);
  matches(policy, e as unknown as ArtifactEvidence, exact);
  if (e.activeOwner !== true || e.cleanupVerified !== true || e.worktreeClean !== true || e.stopReason !== null
      || integer(e.unresolvedAttempts, 'publication_evidence') !== 0) fail('publication_stopped');
  assertEngineeringTaskFileScope(policy, e.changedFiles as readonly string[]);
  const history = attempts(e.requests as readonly EngineeringRequestAttempt[], policy.acceptance);
  if (!history.work || history.review !== 1 || history.records.some(a => a.state !== 'settled')) fail('review_request_missing');
  const tests = list(e.tests, 16, 'test_evidence').map(raw => {
    const test = data(raw, ['taskId', 'policyFingerprint', 'artifact', 'command', 'completed', 'timedOut', 'exitCode'], 'test_evidence');
    matches(policy, test as unknown as ArtifactEvidence, exact);
    if (typeof test.command !== 'string' || !policy.requiredCommands.includes(test.command)
        || test.completed !== true || test.timedOut !== false || test.exitCode !== 0) fail('test_evidence');
    return test.command;
  });
  if (tests.length !== policy.requiredCommands.length || new Set(tests).size !== tests.length
      || policy.requiredCommands.some(command => !tests.includes(command))) fail('test_evidence');
  const review = data(e.review, ['taskId', 'policyFingerprint', 'artifact', 'requestId', 'independent', 'completed', 'verdict', 'blockingFindings'], 'review_evidence');
  matches(policy, review as unknown as ArtifactEvidence, exact);
  if (review.independent !== true || review.completed !== true || review.verdict !== 'approved'
      || review.blockingFindings !== 0
      || !history.records.some(a => a.role === 'review' && a.requestId === review.requestId)) fail('review_evidence');
  return Object.freeze({ taskId: policy.taskId, policyFingerprint: policy.fingerprint,
    artifact: Object.freeze(exact), draft: true as const, mergeAllowed: false as const,
    deploymentAllowed: false as const, executionAuthorized: false as const });
}
