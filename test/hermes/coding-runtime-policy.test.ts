import { expect, test } from 'bun:test';
import { fingerprintHermesCodingActivation, HERMES_CODING_RUNTIME_POLICY } from '../../src/hermes/coding-runtime-policy.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';

test('coding activation binding is stable across JSON object order, but changes with admitted scopes', () => {
  const config = { issueId: 'ticket', repo: 'fixture/repo', policy: { baseCommit: 'a'.repeat(40), allowedFiles: ['a.ts'], readIdentifiers: ['ERT-1'] } };
  const reordered = { policy: { readIdentifiers: ['ERT-1'], allowedFiles: ['a.ts'], baseCommit: 'a'.repeat(40) }, repo: 'fixture/repo', issueId: 'ticket' };
  const original = fingerprintHermesCodingActivation(config);
  expect(original).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(fingerprintHermesCodingActivation(reordered)).toBe(original);
  expect(fingerprintHermesCodingActivation({ ...config, policy: { ...config.policy, allowedFiles: ['b.ts'] } })).not.toBe(original);
  expect(fingerprintHermesCodingActivation({ ...config, policy: { ...config.policy, readIdentifiers: ['ERT-1', 'ERT-2'] } })).not.toBe(original);
  expect(fingerprintHermesCodingActivation({ ...config, workerImage: 'sha256:' + 'b'.repeat(64) })).not.toBe(original);
  expect(fingerprintHermesCodingActivation({ ...config, releaseCommit: 'c'.repeat(40) })).not.toBe(original);
});

test('the activation receipt binds the fixed thinking policy independently of task-state identity', () => {
  const config = { issueId: 'ticket', repo: 'fixture/repo' };
  const absentThinking = { version: 1, provider: 'deepseek', model: 'deepseek-v4-pro' };
  const providerDefault = { ...HERMES_CODING_RUNTIME_POLICY, thinking: 'unknown' };
  expect(fingerprintHermesCodingActivation(config)).not.toBe('sha256:' + fingerprintJson({ config, policy: absentThinking }).sha256);
  expect(fingerprintHermesCodingActivation(config)).not.toBe('sha256:' + fingerprintJson({ config, policy: providerDefault }).sha256);
  expect(Object.isFrozen(HERMES_CODING_RUNTIME_POLICY)).toBe(true);
});

test('unsafe non-JSON config cannot produce an admission fingerprint or evaluate a getter', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked = true; return 'not read'; } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const config of [null, [], 'serialized', { value: Infinity }, { value: undefined }, getter, cyclic]) {
    expect(() => fingerprintHermesCodingActivation(config)).toThrow();
  }
  expect(invoked).toBe(false);
});


test('fixed trial policy bounds every stage and freezes nested review settings',()=>{
  expect(HERMES_CODING_RUNTIME_POLICY.maxAllocationMicros).toBe(10_000_000);
  expect(HERMES_CODING_RUNTIME_POLICY.actionTimeoutMs).toBe(9_000_000);
  expect(HERMES_CODING_RUNTIME_POLICY.review).toEqual({providerOrder:['deepseek'],maxRounds:1,iterationCap:6,timeoutMs:180_000});
  expect(Object.isFrozen(HERMES_CODING_RUNTIME_POLICY.review)).toBe(true);
  expect(Object.isFrozen(HERMES_CODING_RUNTIME_POLICY.review.providerOrder)).toBe(true);
});


test('fixed coding executor and environment are deeply frozen and included in admission identity', () => {
  const executor=HERMES_CODING_RUNTIME_POLICY.executor;
  expect(HERMES_CODING_RUNTIME_POLICY.version).toBe(5);
  expect(executor.image).toBe('sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c');
  expect(executor.bunCacheVolume).toBe('gary-bun-cache-20261007-node24');
  expect({cpus:executor.cpus,memory:executor.memory,pidsLimit:executor.pidsLimit}).toEqual({cpus:'4',memory:'12g',pidsLimit:512});
  expect(executor.storybookScratch).toBe(true);
  expect(executor.fixedEnvironment).toEqual({PUBLIC_PARTYKIT_HOST:'party.mulligan-labs.com',VITEST_MAX_WORKERS:'2',
    TMPDIR:'/workspace/node_modules/.cache/gary-preflight-tmp',WRANGLER_SEND_METRICS:'false',DO_NOT_TRACK:'1',STORYBOOK_DISABLE_TELEMETRY:'1'});
  expect(Object.isFrozen(executor)).toBe(true);expect(Object.isFrozen(executor.fixedEnvironment)).toBe(true);
  const config={issueId:'ticket'};
  for(const changed of [{...executor,image:'other'},{...executor,bunCacheVolume:'other'},
      {...executor,storybookScratch:false},
      {...executor,cpus:'8'},{...executor,memory:'24g'},{...executor,pidsLimit:1024},
      {...executor,fixedEnvironment:{...executor.fixedEnvironment,VITEST_MAX_WORKERS:'3'}}]) {
    expect(fingerprintHermesCodingActivation(config)).not.toBe('sha256:'+fingerprintJson({config,
      policy:{...HERMES_CODING_RUNTIME_POLICY,executor:changed}}).sha256);
  }
});

 test('verification ceilings and publication gate affect the fixed activation identity',()=>{
 const policy=HERMES_CODING_RUNTIME_POLICY;expect(policy.verification.publicationCommand).toBe('bun run ci:full');
 expect(policy.verification.commands).toEqual({'bun run ci:full':{timeoutMs:1_800_000,maxStarts:4},'bun run check':{timeoutMs:600_000,maxStarts:8}});
 for(const verification of [{...policy.verification,publicationCommand:'bun run check'},{...policy.verification,genericCommandTimeoutMs:9_000_000},{...policy.verification,commands:{...policy.verification.commands,'bun run ci:full':{timeoutMs:1_800_001,maxStarts:4}}}])
 expect(fingerprintHermesCodingActivation({})).not.toBe('sha256:'+fingerprintJson({config:{},policy:{...policy,verification}}).sha256);
 });
