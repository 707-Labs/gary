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
  expect(HERMES_CODING_RUNTIME_POLICY.actionTimeoutMs).toBe(900_000);
  expect(HERMES_CODING_RUNTIME_POLICY.review).toEqual({providerOrder:['deepseek'],maxRounds:1,iterationCap:6,timeoutMs:180_000});
  expect(Object.isFrozen(HERMES_CODING_RUNTIME_POLICY.review)).toBe(true);
  expect(Object.isFrozen(HERMES_CODING_RUNTIME_POLICY.review.providerOrder)).toBe(true);
});
