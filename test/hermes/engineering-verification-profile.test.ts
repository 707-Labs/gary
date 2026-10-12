import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEngineeringVerificationProfile, createEngineeringCandidateVerificationProfile, createEngineeringVerificationProfile, ENGINEERING_VERIFICATION_PROFILE_LIMITS } from '../../src/hermes/engineering-verification-profile.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(manifest: unknown = { scripts: { check: 'tsc --noEmit', 'test:run': 'vitest run', test: 'vitest', lint: 'eslint .' }, devDependencies: { typescript: '5.0.0' } }, lock: string | null = 'bun.lock') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-verification-profile-'))); roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  if (lock) writeFileSync(join(root, lock), 'synthetic offline lock bytes\n');
  return root;
}
describe('host-derived offline verification profiles', () => {
  test('selects deterministic Bun checks, skips duplicate test fallback and never runs scripts', () => {
    const root = fixture(), original = readFileSync(join(root, 'package.json'));
    const profile = createEngineeringVerificationProfile({ workspaceRoot: root });
    expect(profile.kind).toBe('javascript_bun');
    expect(profile.dependencyCommands).toEqual(['bun install --frozen-lockfile --offline --ignore-scripts']);
    expect(profile.requiredCommands).toEqual(['CI=1 bun --no-env-file --no-install run check', 'CI=1 bun --no-env-file --no-install run test:run', 'CI=1 bun --no-env-file --no-install run lint']);
    expect(Object.isFrozen(profile)).toBe(true); expect(Object.isFrozen(profile.requiredCommands)).toBe(true);
    expect(Object.isFrozen(profile.dependencyCommands)).toBe(true);
    expect(readFileSync(join(root, 'package.json'))).toEqual(original);
    assertEngineeringVerificationProfile(profile, { workspaceRoot: root });
  });
  test('supports binary Bun lock and npm lock without assuming a Bun cache', () => {
    const bun = createEngineeringVerificationProfile({ workspaceRoot: fixture(undefined, 'bun.lockb') });
    expect(bun.kind).toBe('javascript_bun');
    const root = fixture({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }, 'package-lock.json');
    const npm = createEngineeringVerificationProfile({ workspaceRoot: root });
    expect(npm.kind).toBe('javascript_npm');
    expect(npm.dependencyCommands).toEqual(['npm ci --offline --ignore-scripts --no-audit --no-fund']);
    expect(npm.requiredCommands).toEqual(['CI=1 npm run --ignore-scripts typecheck', 'CI=1 npm run --ignore-scripts test']);
  });
  test('dependency-free scripts need no install; dependencies or workspaces without lock fail', () => {
    const profile = createEngineeringVerificationProfile({ workspaceRoot: fixture({ scripts: { test: 'node --test' } }, null) });
    expect(profile.dependencyCommands).toEqual([]);
    for (const extra of [{ dependencies: { x: '1' } }, { devDependencies: { x: '1' } }, { workspaces: ['packages/*'] }]) {
      expect(() => createEngineeringVerificationProfile({ workspaceRoot: fixture({ scripts: { test: 'node --test' }, ...extra }, null) }))
        .toThrow('offline_dependencies_unavailable_missing_lockfile');
    }
  });
  test('no verified check, explicit watch modes, malformed manifests and foreign toolchains fail closed', () => {
    for (const manifest of [[], { scripts: { build: 'tsc' } }, { scripts: { test: 'echo no tests' } },
      { scripts: { test: 'vitest --watch' } }, { scripts: { test: 'jest --watchAll' } },
      { scripts: { test: 'playwright test --ui' } }, { scripts: { test: false } },
      { scripts: { test: 'node --test\ntrue' } }, { scripts: { test: 'node --test' }, dependencies: [] },
      { scripts: { test: 'node --test' }, packageManager: 'pnpm@9.0.0' }]) {
      expect(() => createEngineeringVerificationProfile({ workspaceRoot: fixture(manifest) })).toThrow();
    }
    const root = fixture(); rmSync(join(root, 'package.json'));
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: root })).toThrow('unsupported_toolchain');
    writeFileSync(join(root, 'package.json'), '{broken');
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: root })).toThrow('invalid_package_json');
  });
  test('ambiguous and unsupported lockfile selections fail closed', () => {
    for (const lock of ['bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      const root = fixture(); writeFileSync(join(root, lock), 'second-lock');
      expect(() => createEngineeringVerificationProfile({ workspaceRoot: root })).toThrow();
    }
  });
  test('host provenance rejects copied profiles and rechecks exact package and lock bytes', () => {
    const root = fixture(), profile = createEngineeringVerificationProfile({ workspaceRoot: root });
    expect(() => assertEngineeringVerificationProfile({ ...profile }, { workspaceRoot: root })).toThrow('untrusted_profile');
    expect(() => assertEngineeringVerificationProfile(JSON.parse(JSON.stringify(profile)), { workspaceRoot: root })).toThrow('untrusted_profile');
    const clone = fixture(); assertEngineeringVerificationProfile(profile, { workspaceRoot: clone });
    writeFileSync(join(root, 'bun.lock'), 'changed lock');
    expect(() => assertEngineeringVerificationProfile(profile, { workspaceRoot: root })).toThrow('profile_changed');
    writeFileSync(join(clone, 'package.json'), readFileSync(join(clone, 'package.json')).toString()+'\n');
    expect(() => assertEngineeringVerificationProfile(profile, { workspaceRoot: clone })).toThrow('profile_changed');
  });
  test('rejects symlink roots/leaves, hardlinks, nonregular files and oversized reads', () => {
    const root = fixture(), other = fixture();
    symlinkSync(other, join(root, 'alias'));
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: join(root, 'alias') })).toThrow('unsafe_root');
    rmSync(join(root, 'package.json')); symlinkSync(join(other, 'package.json'), join(root, 'package.json'));
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: root })).toThrow('unsafe_file');
    rmSync(join(root, 'package.json')); linkSync(join(other, 'package.json'), join(root, 'package.json'));
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: root })).toThrow('unsafe_file');
    rmSync(join(root, 'package.json')); mkdirSync(join(root, 'package.json'));
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: root })).toThrow('unsafe_file');
    rmSync(join(root, 'package.json'), { recursive: true });
    writeFileSync(join(root, 'package.json'), Buffer.alloc(ENGINEERING_VERIFICATION_PROFILE_LIMITS.packageBytes+1, 32));
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: root })).toThrow('file_size');
    const unsafe = fixture(); chmodSync(join(unsafe, 'bun.lock'), 0o666);
    expect(() => createEngineeringVerificationProfile({ workspaceRoot: unsafe })).toThrow('unsafe_file');
  });
});

describe('dependency edits retain original host verification authority',()=>{
 test('explicit candidate profile accepts dependency/lock changes while strict baseline remains unchanged',()=>{
  const original={scripts:{test:'node --test',pretest:'node prepare.js'},dependencies:{demo:'1.0.0'}};
  const baselineRoot=fixture(original,'package-lock.json'),baseline=createEngineeringVerificationProfile({workspaceRoot:baselineRoot});
  const candidateRoot=fixture({...original,dependencies:{demo:'2.0.0',added:'1.0.0'}},'package-lock.json');
  writeFileSync(join(candidateRoot,'package-lock.json'),'new lock bytes');
  const candidate=createEngineeringCandidateVerificationProfile(baseline,{workspaceRoot:candidateRoot});
  expect(candidate.requiredCommands).toEqual(baseline.requiredCommands);expect(candidate.hash).not.toBe(baseline.hash);
  assertEngineeringVerificationProfile(candidate,{workspaceRoot:candidateRoot});assertEngineeringVerificationProfile(baseline,{workspaceRoot:baselineRoot});
  expect(()=>assertEngineeringVerificationProfile(baseline,{workspaceRoot:candidateRoot})).toThrow('profile_changed');
  expect(()=>createEngineeringCandidateVerificationProfile({...baseline},{workspaceRoot:candidateRoot})).toThrow('untrusted_profile');
 });
 test('candidate cannot replace check text, hooks, manager, toolchain or any non-dependency manifest authority',()=>{
  const original={name:'fixture',scripts:{test:'node --test',pretest:'node prepare.js'},dependencies:{demo:'1.0.0'}};
  const root=fixture(original,'package-lock.json'),base=createEngineeringVerificationProfile({workspaceRoot:root});
  for(const change of [{scripts:{test:'true',pretest:'node prepare.js'}},{scripts:{test:'node --test',pretest:'curl evil'}},{packageManager:'bun@1.3.10'},{workspaces:['private']},{name:'changed'}]){
   const candidate=fixture({...original,...change},'package-lock.json');expect(()=>createEngineeringCandidateVerificationProfile(base,{workspaceRoot:candidate})).toThrow('verification_authority_changed');
  }
  const manager=fixture(original,'bun.lock');expect(()=>createEngineeringCandidateVerificationProfile(base,{workspaceRoot:manager})).toThrow('lockfile_kind_changed');
  const missing=fixture(original,'package-lock.json');rmSync(join(missing,'package.json'));expect(()=>createEngineeringCandidateVerificationProfile(base,{workspaceRoot:missing})).toThrow('unsupported_toolchain');
 });
 test('dependency-free npm baseline may add its first frozen lock without replacing tests',()=>{
  const original={scripts:{test:'node --test'}},base=createEngineeringVerificationProfile({workspaceRoot:fixture(original,null)});
  const candidateRoot=fixture({...original,dependencies:{demo:'1.0.0'}},'package-lock.json');
  const candidate=createEngineeringCandidateVerificationProfile(base,{workspaceRoot:candidateRoot});expect(candidate.dependencyCommands).toEqual(['npm ci --offline --ignore-scripts --no-audit --no-fund']);expect(candidate.requiredCommands).toEqual(base.requiredCommands);
 });
});
