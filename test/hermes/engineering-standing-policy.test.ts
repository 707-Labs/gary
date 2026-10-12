import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createEngineeringTaskPolicy, createStandingEngineeringTaskPolicy, resolveEngineeringRepository,
  engineeringStandingBudgetPolicySha256, ENGINEERING_STANDING_MIN_TASK_CAP_MICROS,
  assertEngineeringTaskFileScope, assertEngineeringRequestAllowed, isEngineeringRepositoryScopedPolicy,
} from '../../src/hermes/engineering-policy.ts';

const repository = () => resolveEngineeringRepository('new-app', {
  authenticated: true, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
  surface: 'private_dm', channelId: 'D123456789', threadTs: '1234567890.123456',
}, [{ repositoryId: 23, installationId: 42, fullName: '707-Labs/new-app', appAccessible: true,
  contents: 'write', pullRequests: 'write', archived: false, disabled: false, sharedChannelIds: [] }]);
const input = () => ({ taskId: 'standing-task', repository: repository(), baseCommit: 'a'.repeat(40),
  requiredCommands: ['CI=1 bun run check', 'CI=1 bun run test:run'], verificationProfileSha256: 'b'.repeat(64),
  publication: 'patch_only' as const, capMicros: 6_000_000 });

test('standing policy binds dynamic repository, whole-source scope, checks, profile and finite funding', () => {
  const p = createStandingEngineeringTaskPolicy(input());
  expect(p.fundingKind).toBe('standing'); expect(p.scope).toEqual({ kind: 'repository' });
  expect(p.allowedFiles).toEqual([]); expect(p.acceptance.version).toBe(2);
  expect(p.acceptance.work.maxRequests).toBe(12); expect(p.acceptance.review.maxRequests).toBe(1);
  expect(p.acceptance.capMicros).toBe(6_000_000);
  expect(engineeringStandingBudgetPolicySha256(6_000_000)).toBe(createHash('sha256').update(JSON.stringify(p.acceptance)).digest('hex'));
  expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.scope)).toBe(true);
  expect(isEngineeringRepositoryScopedPolicy(p)).toBe(true);
  for (const delta of [{ verificationProfileSha256: 'c'.repeat(64) }, { capMicros: 7_000_000 }, { baseCommit: 'd'.repeat(40) }]) {
    expect(createStandingEngineeringTaskPolicy({ ...input(), ...delta }).fingerprint).not.toBe(p.fingerprint);
  }
});

test('standing scope admits new Svelte route files and rejects credentials, metadata and path aliases', () => {
  const p = createStandingEngineeringTaskPolicy(input());
  expect(assertEngineeringTaskFileScope(p, ['src/routes/[slug]/+page.svelte', 'src/$types.ts', 'docs/new guide.md']))
    .toEqual(['docs/new guide.md', 'src/$types.ts', 'src/routes/[slug]/+page.svelte']);
  for (const file of ['.env', '.env.local', '.git/config', '.beads/issues.jsonl', '.ssh/id_rsa', '.npmrc',
    'src/credentials.json', '../outside', '/absolute', 'src\\wrong', 'src/../outside', 'src/trailing.', 'a\n.ts']) {
    expect(() => assertEngineeringTaskFileScope(p, [file])).toThrow('file_scope');
  }
  expect(() => assertEngineeringTaskFileScope(p, ['src/A.ts', 'src/a.ts'])).toThrow('file_scope');
  expect(() => assertEngineeringTaskFileScope(p, Array.from({ length: 513 }, (_, i) => `src/${i}.ts`))).toThrow('file_scope');
  expect(() => isEngineeringRepositoryScopedPolicy({ ...p })).toThrow('task_policy_untrusted');
});

test('legacy file scope never gains repository authority from an empty list or forged marker', () => {
  const legacy = createEngineeringTaskPolicy({ taskId: 'legacy-task', repository: repository(), baseCommit: 'a'.repeat(40),
    allowedFiles: ['src/old.ts'], requiredCommands: ['bun test'], publication: 'patch_only' });
  expect(isEngineeringRepositoryScopedPolicy(legacy)).toBe(false);
  expect(assertEngineeringTaskFileScope(legacy, ['src/old.ts'])).toEqual(['src/old.ts']);
  expect(() => assertEngineeringTaskFileScope(legacy, ['src/new.ts'])).toThrow('file_scope');
  expect(() => assertEngineeringTaskFileScope({ ...legacy, fundingKind: 'standing', scope: { kind: 'repository' } }, ['src/new.ts']))
    .toThrow('task_policy_untrusted');
});

test('standing policy does not promote an existing shared-channel audience grant to ordinary DM authority', () => {
  const privateRepo = repository();
  const shared = resolveEngineeringRepository('new-app', { ...privateRepo.authority, surface: 'shared_channel', channelId: 'C123456789' },
    [{ repositoryId: 23, installationId: 42, fullName: '707-Labs/new-app', appAccessible: true,
      contents: 'write', pullRequests: 'write', archived: false, disabled: false, sharedChannelIds: ['C123456789'] }]);
  expect(() => createStandingEngineeringTaskPolicy({ ...input(), repository: shared })).toThrow('standing_private_dm_required');
});

test('standing funding stays conservative and does not accept unfunded or malformed ceilings', () => {
  for (const capMicros of [0, ENGINEERING_STANDING_MIN_TASK_CAP_MICROS - 1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => createStandingEngineeringTaskPolicy({ ...input(), capMicros })).toThrow('standing_task_cap');
    expect(() => engineeringStandingBudgetPolicySha256(capMicros)).toThrow('standing_task_cap');
  }
  expect(() => createStandingEngineeringTaskPolicy({ ...input(), verificationProfileSha256: 'missing' })).toThrow('verification_profile');
  const p = createStandingEngineeringTaskPolicy({ ...input(), capMicros: ENGINEERING_STANDING_MIN_TASK_CAP_MICROS });
  const request = { requestId: 'request-1', role: 'work' as const, maxTokens: 8192 };
  const usage = { attempts: [], allocationActive: true, taskRemainingMicros: ENGINEERING_STANDING_MIN_TASK_CAP_MICROS,
    campaignRemainingMicros: ENGINEERING_STANDING_MIN_TASK_CAP_MICROS, unresolvedAttempts: 0 };
  expect(assertEngineeringRequestAllowed(p, request, usage).reservationMicros).toBe(1_416_561);
  expect(() => assertEngineeringRequestAllowed(p, request, { ...usage, taskRemainingMicros: usage.taskRemainingMicros - 1 }))
    .toThrow('headroom');
  expect(() => assertEngineeringRequestAllowed(p, request, { ...usage, unresolvedAttempts: 1 })).toThrow('allocation_unavailable');
});
