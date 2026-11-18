import { expect, test } from 'bun:test';
import type { Stats } from 'node:fs';
import {
  createEngineeringResourceBindingGuard,
  parseEngineeringResourceLockBinding,
  type EngineeringResourceBindingDependencies,
  type EngineeringResourceLockBinding,
} from '../../src/executors/engineering-resource-binding.ts';

function binding(): EngineeringResourceLockBinding {
  return { path: '/private/tmp/apple-release-xcode.lock', dev: 16777232, ino: 176033673,
    uid: 501, mode: 0o644, nlink: 1, bootSessionUUID: '02D97A38-83D2-457D-967F-A01481D5EEFC',
    apfsVolumeUUID: '7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697' };
}

/** All observations are in-memory; no canonical file or OS query is used. */
function fixture() {
  const expected = binding();
  const calls: string[] = [];
  const host = { bootSessionUUID: expected.bootSessionUUID, apfsVolumeUUID: expected.apfsVolumeUUID };
  let current = { dev: expected.dev, ino: expected.ino, uid: expected.uid, mode: 0o100000 | expected.mode,
    nlink: expected.nlink, isFile: () => true, isSymbolicLink: () => false } as Stats;
  let canonical = expected.path;
  const dependencies: EngineeringResourceBindingDependencies = {
    observeBoot(dev) { calls.push('boot:' + dev); return { ...host }; },
    inspection: {
      lstat(path) { calls.push('lstat:' + path); return { ...current } as Stats; },
      realpath(path) { calls.push('realpath:' + path); return canonical; },
    },
  };
  return { expected, calls, host, dependencies,
    changeStat(changes: Partial<Stats>) { current = { ...current, ...changes } as Stats; },
    changeCanonical(value: string) { canonical = value; } };
}

test('pure parser returns a defensive frozen exact binding without normalizing or learning identity', () => {
  const input = { ...binding() };
  const value = parseEngineeringResourceLockBinding(input);
  expect(value).toEqual(input);
  expect(value).not.toBe(input);
  expect(Object.isFrozen(value)).toBe(true);
  input.ino++;
  expect(value.ino).toBe(176033673);
  expect(() => { (value as { ino: number }).ino++; }).toThrow();
});

for (const [field, value] of [
  ['path', '/tmp/apple-release-xcode.lock'], ['path', '/private/tmp/../tmp/apple-release-xcode.lock'],
  ['path', '/private/tmp/apple-release-xcode.lock/'], ['path', '/private/tmp/other.lock'],
  ['dev', 0], ['dev', -1], ['dev', 1.5], ['dev', Number.MAX_SAFE_INTEGER + 1], ['dev', '16777232'],
  ['ino', 0], ['ino', -1], ['ino', NaN], ['ino', Infinity], ['ino', Number.MAX_SAFE_INTEGER + 1],
  ['uid', 0], ['uid', '501'], ['mode', 0o600], ['mode', 0o664], ['mode', 0o1644], ['nlink', 2],
  ['bootSessionUUID', '02d97a38-83d2-457d-967f-a01481d5eefc'], ['bootSessionUUID', 'not-a-uuid'],
  ['apfsVolumeUUID', '7cd7dc2c-1f22-4b7c-bb7a-525d8ff5b697'], ['apfsVolumeUUID', null],
] as const) {
  test(`binding rejects invalid ${field} ${String(value)}`, () => {
    expect(() => parseEngineeringResourceLockBinding({ ...binding(), [field]: value }))
      .toThrow('engineering_resource_binding_invalid');
  });
}

test('parser rejects absent, extra, inherited, symbol and accessor fields without invoking getters', () => {
  const missing = { ...binding() } as Record<string, unknown>;
  delete missing.ino;
  let getterCalls = 0;
  const accessor = { ...binding() };
  Object.defineProperty(accessor, 'ino', { enumerable: true, get() { getterCalls++; return 176033673; } });
  const hidden = { ...binding() };
  Object.defineProperty(hidden, 'ino', { value: 176033673, enumerable: false });
  for (const value of [null, undefined, [], 'binding', missing, { ...binding(), extra: true },
    Object.create(binding()), { ...binding(), [Symbol('extra')]: true }, accessor, hidden]) {
    expect(() => parseEngineeringResourceLockBinding(value)).toThrow('engineering_resource_binding_invalid');
  }
  expect(getterCalls).toBe(0);
});

test('construction is inert and each guard invocation observes the pinned device and exact lock', () => {
  const f = fixture();
  const guard = createEngineeringResourceBindingGuard(f.expected, f.dependencies);
  expect(f.calls).toEqual([]);
  const pin = guard();
  expect(pin).toEqual({ path: f.expected.path, dev: f.expected.dev, ino: f.expected.ino,
    uid: 501, mode: 0o644, nlink: 1 });
  expect(Object.isFrozen(pin)).toBe(true);
  expect(Object.keys(pin).sort()).toEqual(['dev', 'ino', 'mode', 'nlink', 'path', 'uid']);
  const once = ['boot:' + f.expected.dev, 'lstat:' + f.expected.path,
    'realpath:' + f.expected.path, 'lstat:' + f.expected.path];
  expect(f.calls).toEqual(once);
  expect(guard()).toBe(pin);
  expect(f.calls).toEqual([...once, ...once]);
});

test('invalid construction fails before any observation', () => {
  const f = fixture();
  expect(() => createEngineeringResourceBindingGuard({ ...f.expected, ino: 0 }, f.dependencies))
    .toThrow('engineering_resource_binding_invalid');
  expect(f.calls).toEqual([]);
});

test('guard snapshots binding and trusted dependency functions instead of retaining mutable inputs', () => {
  const f = fixture();
  const input = { ...f.expected };
  const dependencies = { ...f.dependencies, inspection: { ...f.dependencies.inspection! } };
  const guard = createEngineeringResourceBindingGuard(input, dependencies);
  input.ino++;
  input.bootSessionUUID = '12D97A38-83D2-457D-967F-A01481D5EEFC';
  dependencies.observeBoot = () => { throw new Error('replacement must not run'); };
  dependencies.inspection.lstat = () => { throw new Error('replacement must not run'); };
  dependencies.inspection.realpath = () => { throw new Error('replacement must not run'); };
  expect(guard().ino).toBe(f.expected.ino);
});

for (const field of ['bootSessionUUID', 'apfsVolumeUUID'] as const) {
  test('future ' + field + ' is rejected even when numeric lock identity is reused', () => {
    const f = fixture();
    const guard = createEngineeringResourceBindingGuard(f.expected, f.dependencies);
    guard();
    f.calls.length = 0;
    f.host[field] = '12D97A38-83D2-457D-967F-A01481D5EEFC';
    expect(guard).toThrow('engineering_resource_boot_identity_changed');
    expect(f.calls).toEqual(['boot:' + f.expected.dev]);
  });
}

test('boot observation failures are mapped to a safe code without original command output', () => {
  const f = fixture();
  const guard = createEngineeringResourceBindingGuard(f.expected, { ...f.dependencies,
    observeBoot: () => { throw new Error('sensitive command output'); } });
  let message = '';
  try { guard(); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('engineering_resource_boot_observation_failed');
  expect(f.calls).toEqual([]);
});

test('invalid boot observation fails closed without leaking a type error', () => {
  const f = fixture();
  const observeBoot = (() => null) as unknown as NonNullable<EngineeringResourceBindingDependencies['observeBoot']>;
  expect(createEngineeringResourceBindingGuard(f.expected, { ...f.dependencies, observeBoot }))
    .toThrow('engineering_resource_boot_identity_changed');
  expect(f.calls).toEqual([]);
});

for (const [field, value] of [
  ['dev', 16777229], ['ino', 176033674], ['uid', 0], ['mode', 0o100666], ['mode', 0o101644], ['nlink', 2],
] as const) {
  test('subsequent ' + field + ' replacement is rejected without learning its identity', () => {
    const f = fixture();
    const guard = createEngineeringResourceBindingGuard(f.expected, f.dependencies);
    const first = guard();
    f.changeStat({ [field]: value });
    expect(guard).toThrow('engineering_resource_lock_identity_changed');
    expect(guard).toThrow('engineering_resource_lock_identity_changed');
    expect(first[field]).toBe(f.expected[field]);
  });
}

test('symlinks, nonregular files and noncanonical paths fail closed', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.changeStat({ isSymbolicLink: () => true }),
    (f: ReturnType<typeof fixture>) => f.changeStat({ isFile: () => false }),
    (f: ReturnType<typeof fixture>) => f.changeCanonical('/synthetic/replaced.lock'),
  ]) {
    const f = fixture();
    change(f);
    expect(createEngineeringResourceBindingGuard(f.expected, f.dependencies))
      .toThrow('engineering_resource_lock_identity_changed');
  }
});

test('replacement during canonical-path observation is caught by the second stat', () => {
  const f = fixture();
  const guard = createEngineeringResourceBindingGuard(f.expected, { ...f.dependencies, inspection: {
    ...f.dependencies.inspection!, realpath(path) { f.changeStat({ ino: 123 }); return path; },
  } });
  expect(guard).toThrow('engineering_resource_lock_identity_changed');
});

for (const operation of ['lstat', 'realpath'] as const) {
  test(operation + ' failures are mapped to the safe lock identity code', () => {
    const f = fixture();
    const guard = createEngineeringResourceBindingGuard(f.expected, { ...f.dependencies, inspection: {
      ...f.dependencies.inspection!, [operation]: () => { throw new Error('sensitive filesystem path'); },
    } });
    let message = '';
    try { guard(); } catch (error) { message = (error as Error).message; }
    expect(message).toBe('engineering_resource_lock_identity_changed');
  });
}
