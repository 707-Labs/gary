import { expect, test } from 'bun:test';
import { spendReservationMicros } from '../../src/spend.ts';
import {
  ENGINEERING_ACCEPTANCE_POLICY as LIMITS, ENGINEERING_ACCEPTANCE_POLICY_V2, engineeringAcceptancePolicySha256,
  resolveEngineeringRepository, createEngineeringTaskPolicy,
  assertEngineeringRequestAllowed, assertEngineeringPublicationAllowed,
  type EngineeringHostAuthority, type EngineeringRepositoryAccess, type EngineeringTaskPolicy,
  type EngineeringRequestAttempt, type EngineeringRequestRole, type EngineeringRequestUsage,
  type EngineeringPublicationEvidence,
} from '../../src/hermes/engineering-policy.ts';

const authority = (): EngineeringHostAuthority => ({ authenticated: true, requesterId: 'U0A9M5W16F8',
  teamId: 'T0AA24R7VUZ', surface: 'private_dm', channelId: 'D123456789', threadTs: '1234567890.123456' });
const repository = (fullName = '707-Labs/new-service'): EngineeringRepositoryAccess => ({
  repositoryId: 42, installationId: 7, fullName, appAccessible: true, contents: 'write',
  pullRequests: 'write', archived: false, disabled: false, sharedChannelIds: ['C123456789'],
});
const policy = (publication: 'patch_only' | 'draft_pr' = 'draft_pr', acceptancePolicyVersion?: 2) => createEngineeringTaskPolicy({
  taskId: 'engineering-fixture', repository: resolveEngineeringRepository('new-service', authority(), [repository()]),
  baseCommit: 'a'.repeat(40), allowedFiles: ['src/feature.ts', 'test/feature.test.ts'],
  requiredCommands: ['bun test test/feature.test.ts', 'bun run check'], publication,
  ...(acceptancePolicyVersion === 2 ? { acceptancePolicyVersion } : {}),
});
const attempt = (requestId: string, role: EngineeringRequestRole = 'work'): EngineeringRequestAttempt => ({
  requestId, role, maxTokens: role === 'review' ? 4090 : 8192, state: 'settled',
});
const usage = (attempts: readonly EngineeringRequestAttempt[] = []): EngineeringRequestUsage => ({
  attempts, allocationActive: true, taskRemainingMicros: LIMITS.capMicros,
  campaignRemainingMicros: LIMITS.capMicros, unresolvedAttempts: 0,
});
function evidence(p: EngineeringTaskPolicy): EngineeringPublicationEvidence {
  const binding = { taskId: p.taskId, policyFingerprint: p.fingerprint,
    artifact: { baseCommit: p.baseCommit, headCommit: 'b'.repeat(40), treeHash: 'c'.repeat(40) } };
  return { ...binding, activeOwner: true, cleanupVerified: true, stopReason: null, unresolvedAttempts: 0,
    worktreeClean: true, changedFiles: ['src/feature.ts'], requests: [attempt('work-1'), attempt('review-1', 'review')],
    tests: p.requiredCommands.map(command => ({ ...binding, command, completed: true, timedOut: false, exitCode: 0 })),
    review: { ...binding, requestId: 'review-1', independent: true, completed: true, verdict: 'approved', blockingFindings: 0 },
  };
}

test('exact $5.65 envelope matches current guarded reservations without enrolling any allocation', () => {
  expect(spendReservationMicros('deepseek', 8192)).toBe(LIMITS.work.reservationMicros);
  expect(spendReservationMicros('deepseek', 4090)).toBe(LIMITS.review.reservationMicros);
  expect(3 * LIMITS.work.reservationMicros + LIMITS.review.reservationMicros).toBe(5_650_000);
  expect(LIMITS.capMicros).toBe(5_650_000);
  expect(LIMITS.approval).toBe('host_record_required');
  expect(Object.isFrozen(LIMITS)).toBe(true); expect(Object.isFrozen(LIMITS.work)).toBe(true);
  expect(Object.isFrozen(LIMITS.review)).toBe(true);
});

test('dynamic App inventory admits a new repository without expanding audiences or accepting URL aliases', () => {
  const found = resolveEngineeringRepository('new-service', authority(), [repository('707-Labs/new-service')]);
  expect(found.repo).toBe('707-Labs/new-service');
  expect(resolveEngineeringRepository('707-Labs/NEW-SERVICE', authority(), [repository()]).repo).toBe(found.repo);
  expect(Object.isFrozen(found)).toBe(true); expect(Object.isFrozen(found.authority)).toBe(true);
  for (const requested of ['Other/new-service', 'https://github.com/707-Labs/new-service', '707-Labs/../gary',
    '707-Labs/new-service.git', 'new-service;echo bad', 'missing']) {
    expect(() => resolveEngineeringRepository(requested, authority(), [repository()])).toThrow('engineering_policy_rejected');
  }
});

test('authenticated owner and exact Slack team/surface are required for both private and shared work', () => {
  for (const patch of [{ authenticated: false }, { requesterId: 'U123456789' }, { teamId: 'T123456789' },
    { channelId: 'C123456789' }, { threadTs: 'forged' }, { surface: 'other' }]) {
    expect(() => resolveEngineeringRepository('new-service', { ...authority(), ...patch } as EngineeringHostAuthority,
      [repository()])).toThrow('authority');
  }
  const shared: EngineeringHostAuthority = { ...authority(), surface: 'shared_channel', channelId: 'C123456789' };
  expect(resolveEngineeringRepository('new-service', shared, [repository()]).authority.surface).toBe('shared_channel');
  expect(() => resolveEngineeringRepository('new-service', { ...shared, channelId: 'C987654321' }, [repository()])).toThrow('audience');
  expect(() => resolveEngineeringRepository('new-service', { ...shared, requesterId: 'U123456789' }, [repository()])).toThrow('authority');
});

test('App access is necessary but never grants publication permissions or ambiguous repository identity', () => {
  for (const patch of [{ appAccessible: false }, { archived: true }, { disabled: true }]) {
    expect(() => resolveEngineeringRepository('new-service', authority(), [{ ...repository(), ...patch }])).toThrow('repository_unavailable');
  }
  expect(() => resolveEngineeringRepository('new-service', authority(), [repository(), repository('707-Labs/NEW-SERVICE')])).toThrow('repository_snapshot');
  const readOnly = resolveEngineeringRepository('new-service', authority(), [{ ...repository(), contents: 'read', pullRequests: 'read' }]);
  const input = { taskId: 'read-only-patch', repository: readOnly, baseCommit: 'a'.repeat(40),
    allowedFiles: ['src/a.ts'], requiredCommands: ['bun test'], publication: 'patch_only' as const };
  expect(createEngineeringTaskPolicy(input).publication).toBe('patch_only');
  expect(() => createEngineeringTaskPolicy({ ...input, publication: 'draft_pr' })).toThrow('publication_permissions');
});

test('task policy snapshots and fingerprints exact scope, repository, base, tests and delivery mode', () => {
  const files = ['src/feature.ts', 'test/feature.test.ts'], commands = ['bun test test/feature.test.ts', 'bun run check'];
  const repo = repository(), a = authority();
  const selected = resolveEngineeringRepository('new-service', a, [repo]);
  const input = { taskId: 'engineering-fixture', repository: selected, baseCommit: 'a'.repeat(40),
    allowedFiles: files, requiredCommands: commands, publication: 'draft_pr' as const };
  const p = createEngineeringTaskPolicy(input);
  expect(p.fingerprint).toBe(policy().fingerprint);
  expect(createEngineeringTaskPolicy({ ...input, allowedFiles: [...files].reverse(), requiredCommands: [...commands].reverse() }).fingerprint).toBe(p.fingerprint);
  files.push('outside.ts'); commands.push('new command');
  (a as { requesterId: string }).requesterId = 'changed';
  (repo as { fullName: string }).fullName = '707-Labs/changed';
  expect(p.allowedFiles).toHaveLength(2); expect(p.requiredCommands).toHaveLength(2);
  expect(p.repository.authority.requesterId).toBe('U0A9M5W16F8'); expect(p.repository.repo).toBe('707-Labs/new-service');
  expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.allowedFiles)).toBe(true);
  for (const patch of [{ baseCommit: 'b'.repeat(40) }, { allowedFiles: ['src/different.ts'] },
    { requiredCommands: ['bun test'] }, { publication: 'patch_only' as const }]) {
    expect(createEngineeringTaskPolicy({ ...input, ...patch }).fingerprint).not.toBe(p.fingerprint);
  }
  expect(() => createEngineeringTaskPolicy({ ...input, repository: { ...selected } })).toThrow('repository_binding');
});

test('unsafe paths, empty scopes, extra fields and getters cannot create a policy', () => {
  const p = policy();
  const input = { taskId: 'fixture', repository: p.repository, baseCommit: p.baseCommit,
    allowedFiles: ['src/a.ts'], requiredCommands: ['bun test'], publication: 'draft_pr' as const };
  for (const file of ['/tmp/a', '../a', 'src/../a', '.git/config', '.beads/issues.jsonl', '.env', 'src\\a', 'src/*']) {
    expect(() => createEngineeringTaskPolicy({ ...input, allowedFiles: [file] })).toThrow('file_scope');
  }
  for (const patch of [{ allowedFiles: [] }, { allowedFiles: ['a', 'a'] }, { requiredCommands: [] },
    { requiredCommands: ['bun test\nnetwork command'] }, { baseCommit: 'main' }]) {
    expect(() => createEngineeringTaskPolicy({ ...input, ...patch })).toThrow();
  }
  expect(() => createEngineeringTaskPolicy({ ...input, senderId: 'forged' } as typeof input)).toThrow('task');
  let invoked = false;
  const hostile = Object.defineProperty({ ...input }, 'baseCommit', { enumerable: true, get() { invoked = true; return p.baseCommit; } });
  expect(() => createEngineeringTaskPolicy(hostile)).toThrow('task'); expect(invoked).toBe(false);
  const paths = ['src/a.ts']; Object.defineProperty(paths, '0', { get() { invoked = true; return 'src/a.ts'; } });
  expect(() => createEngineeringTaskPolicy({ ...input, allowedFiles: paths })).toThrow('file_scope'); expect(invoked).toBe(false);
});

test('three work calls plus exactly one 4090-token review fit; settled cheap calls do not add slots', () => {
  const p = policy();
  const history = [attempt('one'), attempt('two'), attempt('three')];
  const result = assertEngineeringRequestAllowed(p, { requestId: 'review', role: 'review', maxTokens: 4090 }, usage(history));
  expect(result).toEqual({ reservationMicros: 1_400_317, preserveReviewMicros: 0,
    physicalRequests: 4, reservedEnvelopeMicros: 5_650_000, executionAuthorized: false });
  expect(() => assertEngineeringRequestAllowed(p, { requestId: 'four', role: 'work', maxTokens: 1 }, usage(history))).toThrow('request_limit');
  expect(() => assertEngineeringRequestAllowed(p, { requestId: 'review', role: 'review', maxTokens: 4091 }, usage(history))).toThrow('token_limit');
  expect(() => assertEngineeringRequestAllowed(p, { requestId: 'another', role: 'review', maxTokens: 1 },
    usage([attempt('review', 'review')]))).toThrow('request_limit');
  expect(() => assertEngineeringRequestAllowed(p, { requestId: 'one', role: 'work', maxTokens: 8192 }, usage([attempt('one')]))).toThrow('request_history');
});

test.each(['classification', 'repair', 'retry', 'summary', 'compression', 'subagent', 'publication_body', 'publication_title', 'auxiliary'] as const)(
  '%s consumes a physical work request and preserves the review reservation', role => {
    const p = policy();
    const result = assertEngineeringRequestAllowed(p, { requestId: 'aux', role, maxTokens: 32 }, usage());
    expect(result.reservationMicros).toBe(1_416_561); expect(result.preserveReviewMicros).toBe(1_400_317);
    expect(() => assertEngineeringRequestAllowed(p, { requestId: 'aux', role, maxTokens: 32 },
      usage([attempt('one'), attempt('two'), attempt('three')]))).toThrow('request_limit');
  });

test('unknown/in-flight attempts, insufficient campaign/task headroom and inactive allocations reject', () => {
  const p = policy(), request = { requestId: 'next', role: 'work' as const, maxTokens: 8192 };
  const required = LIMITS.work.reservationMicros + LIMITS.review.reservationMicros;
  for (const patch of [{ allocationActive: false }, { unresolvedAttempts: 1 },
    { attempts: [{ ...attempt('previous'), state: 'unknown' as const }] },
    { attempts: [{ ...attempt('previous'), state: 'in_flight' as const }] },
    { taskRemainingMicros: required - 1 }, { campaignRemainingMicros: required - 1 },
    { taskRemainingMicros: NaN }, { unresolvedAttempts: -1 }]) {
    expect(() => assertEngineeringRequestAllowed(p, request, { ...usage(), ...patch })).toThrow();
  }
  expect(assertEngineeringRequestAllowed(p, request, { ...usage(), taskRemainingMicros: required,
    campaignRemainingMicros: required }).executionAuthorized).toBe(false);
  expect(() => assertEngineeringRequestAllowed({ ...p }, request, usage())).toThrow('task_policy_untrusted');
});

test('publication verifies exact scoped artifact and independent review without granting push authority', () => {
  const p = policy(), e = evidence(p);
  const result = assertEngineeringPublicationAllowed(p, e);
  expect(result.artifact).toEqual(e.artifact); expect(result.draft).toBe(true);
  expect(result.executionAuthorized).toBe(false); expect(result.mergeAllowed).toBe(false); expect(result.deploymentAllowed).toBe(false);
  expect(Object.isFrozen(result.artifact)).toBe(true);
  const patchOnly = policy('patch_only');
  expect(() => assertEngineeringPublicationAllowed(patchOnly, evidence(patchOnly))).toThrow('publication_disabled');
});

test('publication cannot bypass scope/tests/review when finish was skipped or an old artifact passed', () => {
  const p = policy(), e = evidence(p);
  const oldArtifact = { ...e.artifact, headCommit: 'd'.repeat(40) };
  const mutations: Partial<EngineeringPublicationEvidence>[] = [
    { taskId: 'other' }, { policyFingerprint: 'sha256:' + 'f'.repeat(64) },
    { artifact: { ...e.artifact, baseCommit: 'd'.repeat(40) } },
    { worktreeClean: false }, { activeOwner: false }, { cleanupVerified: false }, { stopReason: 'stopped' },
    { unresolvedAttempts: 1 }, { changedFiles: [] }, { changedFiles: ['outside.ts'] },
    { tests: [] }, { tests: [...e.tests, e.tests[0]!] },
    { tests: e.tests.map(t => ({ ...t, command: 'different command' })) },
    { tests: e.tests.map(t => ({ ...t, timedOut: true })) }, { tests: e.tests.map(t => ({ ...t, exitCode: 1 })) },
    { tests: e.tests.map(t => ({ ...t, artifact: oldArtifact })) },
    { review: { ...e.review, artifact: oldArtifact } }, { review: { ...e.review, independent: false } },
    { review: { ...e.review, verdict: 'unavailable' } }, { review: { ...e.review, blockingFindings: 1 } },
    { review: { ...e.review, completed: false } }, { review: { ...e.review, requestId: 'work-1' } },
    { requests: [attempt('work-1')] },
    { requests: [attempt('work-1'), { ...attempt('review-1', 'review'), state: 'unknown' }] },
  ];
  for (const mutation of mutations) expect(() => assertEngineeringPublicationAllowed(p, { ...e, ...mutation })).toThrow();
});


test('v2 is an explicit immutable host selection and preserves exact v1 default fingerprints', () => {
  const v1 = policy(), v2 = policy('draft_pr', 2);
  expect(v1.acceptance).toBe(LIMITS); expect(v2.acceptance).toBe(ENGINEERING_ACCEPTANCE_POLICY_V2);
  expect(v2.acceptance.work.maxRequests).toBe(12); expect(v2.acceptance.maxPhysicalRequests).toBe(13);
  expect(v1.fingerprint).not.toBe(v2.fingerprint);
  expect(engineeringAcceptancePolicySha256(1)).not.toBe(engineeringAcceptancePolicySha256(2));
  expect(engineeringAcceptancePolicySha256(2)).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(v2.acceptance)).toBe(true); expect(Object.isFrozen(v2.acceptance.work)).toBe(true);
  expect(v2.acceptance.capMicros).toBe(5_650_000);
  expect(spendReservationMicros('deepseek',8192)).toBe(v2.acceptance.work.reservationMicros);
  expect(spendReservationMicros('deepseek',4090)).toBe(v2.acceptance.review.reservationMicros);
  const input = {taskId:v1.taskId,repository:v1.repository,baseCommit:v1.baseCommit,
    allowedFiles:v1.allowedFiles,requiredCommands:v1.requiredCommands,publication:v1.publication};
  for (const version of [undefined, 1, 3, '2', null])
    expect(() => createEngineeringTaskPolicy({...input,acceptancePolicyVersion:version} as any)).toThrow('policy_version');
  let invoked = false;
  expect(() => createEngineeringTaskPolicy(Object.defineProperty({...input},'acceptancePolicyVersion',
    {enumerable:true,get(){invoked=true;return 2;}}))).toThrow('task');
  expect(invoked).toBe(false);
});

test('v2 admits twelve cheap settled work calls plus review while v1 still rejects the fourth', () => {
  const v2 = policy('draft_pr', 2), history: EngineeringRequestAttempt[] = [];
  let remaining = 5_417_988;
  for (let i=0; i<12; i++) {
    const request = {requestId:'v2-work-'+i,role:'work' as const,maxTokens:8192};
    const allowed = assertEngineeringRequestAllowed(v2,request,{...usage(history),
      taskRemainingMicros:remaining,campaignRemainingMicros:remaining});
    expect(allowed.reservationMicros).toBe(1_416_561); expect(allowed.preserveReviewMicros).toBe(1_400_317);
    expect(allowed.physicalRequests).toBe(i+1); history.push({...request,state:'settled'});
    remaining -= 32_454; // 10 billed input tokens + full 8192 output allowance, rounded up.
  }
  expect(() => assertEngineeringRequestAllowed(v2,{requestId:'v2-work-13',role:'work',maxTokens:8192},usage(history))).toThrow('request_limit');
  const review=assertEngineeringRequestAllowed(v2,{requestId:'v2-review',role:'review',maxTokens:4090},
    {...usage(history),taskRemainingMicros:remaining,campaignRemainingMicros:remaining});
  expect(review.physicalRequests).toBe(13); expect(review.preserveReviewMicros).toBe(0);
  expect(review.reservedEnvelopeMicros).toBeGreaterThan(v2.acceptance.capMicros); // Informational historical nominal sum only.
  expect(() => assertEngineeringRequestAllowed(policy(),{requestId:'legacy-fourth',role:'work',maxTokens:8192},
    usage(history.slice(0,3)))).toThrow('request_limit');
  const e=evidence(v2); // Publication uses the selected history ceiling too.
  expect(assertEngineeringPublicationAllowed(v2,{...e,requests:[...history,attempt('review-1','review')]}).executionAuthorized).toBe(false);
});

test('v2 full-context funding is conditional: two maximum charges fit, third protects review and rejects', () => {
  const p=policy('draft_pr',2), history: EngineeringRequestAttempt[]=[];
  let remaining=5_417_988;
  for(let i=0;i<2;i++) {
    const request={requestId:'maximum-'+i,role:'work' as const,maxTokens:8192};
    expect(assertEngineeringRequestAllowed(p,request,{...usage(history),taskRemainingMicros:remaining,
      campaignRemainingMicros:remaining}).reservationMicros).toBe(1_416_561);
    history.push({...request,state:'settled'});remaining-=1_416_561;
  }
  expect(remaining).toBe(2_584_866);
  const request={requestId:'third',role:'work' as const,maxTokens:8192};
  expect(() => assertEngineeringRequestAllowed(p,request,{...usage(history),taskRemainingMicros:remaining,
    campaignRemainingMicros:remaining})).toThrow('headroom');
  expect(assertEngineeringRequestAllowed(p,{requestId:'review',role:'review',maxTokens:4090},
    {...usage(history),taskRemainingMicros:remaining,campaignRemainingMicros:remaining}).reservationMicros).toBe(1_400_317);
  for (const patch of [{taskRemainingMicros:2_816_877},{campaignRemainingMicros:2_816_877},
    {unresolvedAttempts:1},{attempts:[{...attempt('unknown'),state:'unknown' as const}]}])
    expect(() => assertEngineeringRequestAllowed(p,request,{...usage(),...patch})).toThrow();
});


test('v2 review permanently closes work and auxiliary admission without releasing a request slot', () => {
  const p=policy('draft_pr',2);
  for(const role of ['work','repair','summary','retry','review'] as const)
    expect(() => assertEngineeringRequestAllowed(p,{requestId:'after-review',role,maxTokens:role==='review'?4090:8192},
      usage([attempt('work'),attempt('review','review')]))).toThrow('review_already_completed');
});
