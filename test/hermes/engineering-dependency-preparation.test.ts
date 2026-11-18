import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareEngineeringDependencies, mintEngineeringDependencyAdmission } from '../../src/hermes/engineering-dependency-preparation.ts';
import { assertEngineeringDependencyPreparation } from '../../src/hermes/engineering-dependency-bundle.ts';
import { createEngineeringVerificationProfile, createEngineeringCandidateVerificationProfile } from '../../src/hermes/engineering-verification-profile.ts';
import { createEngineeringNetworkQuota } from '../../src/hermes/engineering-network-broker.ts';

const roots: string[] = [];
function writable(root: string) {
  if (lstatSync(root).isSymbolicLink()) return;
  if (lstatSync(root).isDirectory()) {
    chmodSync(root, 0o700);
    for (const name of readdirSync(root)) writable(join(root, name));
  }
}
afterEach(() => { for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); } });
const payload = Buffer.from('synthetic archive bytes, never unpacked on host');
const integrity = 'sha512-' + createHash('sha512').update(payload).digest('base64');
function fixture(dependencies = true, bun = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dependency-preparation-'))); roots.push(root);
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot, { mode: 0o700 });
  const manifest = { scripts: { test: 'node --test' }, ...(dependencies ? { dependencies: { demo: '1.0.0' } } : {}) };
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(manifest));
  if (dependencies) writeFileSync(join(workspaceRoot, bun ? 'bun.lock' : 'package-lock.json'), JSON.stringify(bun
    ? { lockfileVersion: 1, workspaces: { '': { dependencies: manifest.dependencies } }, packages: { demo: ['demo@1.0.0', '', {}, integrity] } }
    : { lockfileVersion: 3, packages: { '': { dependencies: manifest.dependencies }, 'node_modules/demo': { version: '1.0.0', integrity, resolved: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz' } } }));
  const binding = { taskId: 'task', scopeKey: 'dm:project', deadlineMs: Date.now() + 10_000 };
  const profile = createEngineeringVerificationProfile({ workspaceRoot });
  const dependencyAdmission = mintEngineeringDependencyAdmission({ workspaceRoot, profile, binding, provenanceSha256: 'a'.repeat(64), assertCurrent() {} });
  const options = { workspaceRoot, materializationRoot: join(root, 'payload'), profile, dependencyAdmission,
    binding, networkQuota: createEngineeringNetworkQuota(binding), provenanceSha256: 'a'.repeat(64), allowLifecycleScripts: false, assertCurrent() {},
    network: { resolve: async () => ['1.1.1.1'], transport: async () => ({ status: 200, headers: {}, bytes: payload }) } };
  return { root, options };
}
test('host composition binds exact source/profile/SRI and creates an opaque readonly sandbox-only install capability', async () => {
  for (const bun of [false, true]) {
    const { options } = fixture(true, bun); let calls = 0;
    options.network.transport = async () => { calls++; return { status: 200, headers: {}, bytes: payload }; };
    const result = (await prepareEngineeringDependencies(options))!;
    expect(calls).toBe(1); expect(result.root).toBe(options.materializationRoot);
    expect(result.command).toBe('node /task/dependency-bundle/install.cjs ' + result.manifestSha256);
    expect(lstatSync(result.root).mode & 0o777).toBe(0o500);
    const manifest = JSON.parse(readFileSync(join(result.root, 'manifest.json'), 'utf8'));
    expect(manifest.kind).toBe(bun ? 'bun' : 'npm'); expect(manifest.allowLifecycleScripts).toBe(false);
    expect(manifest.provenanceSha256).toBe('a'.repeat(64)); expect(manifest.downloadReceipts[0]).toMatchObject({taskId:'task',scopeKey:'dm:project',integrity,bytes:payload.length});
    assertEngineeringDependencyPreparation(result); expect(() => assertEngineeringDependencyPreparation({ ...result })).toThrow('preparation_provenance');
    expect(existsSync(join(options.workspaceRoot, 'node_modules'))).toBe(false);
  }
});
test('dependency-free admission never invokes DNS or materializes a bundle', async () => {
  const { options } = fixture(false); options.network.resolve = async () => { throw Error('must not resolve'); };
  expect(await prepareEngineeringDependencies(options)).toBeUndefined(); expect(existsSync(options.materializationRoot)).toBe(false);
});
test('source/profile mutation after DNS rejects before public bytes or bundle are accepted', async () => {
  const { options } = fixture(); let calls = 0;
  options.network.resolve = async () => { writeFileSync(join(options.workspaceRoot, 'package.json'), '{"scripts":{"test":"node changed.js"}}'); return ['1.1.1.1']; };
  options.network.transport = async () => { calls++; return { status: 200, headers: {}, bytes: payload }; };
  await expect(prepareEngineeringDependencies(options)).rejects.toThrow('profile_changed'); expect(calls).toBe(0); expect(existsSync(options.materializationRoot)).toBe(false);
});
test('revoked task authority and integrity failures leave workspace and mount destination untouched', async () => {
  const a = fixture(); let current = true;
  a.options.assertCurrent = () => { if (!current) throw Error('revoked'); };
  a.options.network.transport = async () => { current = false; return { status: 200, headers: {}, bytes: payload }; };
  await expect(prepareEngineeringDependencies(a.options)).rejects.toThrow('revoked'); expect(existsSync(a.options.materializationRoot)).toBe(false);
  const b = fixture(); b.options.network.transport = async () => ({ status: 200, headers: {}, bytes: Buffer.from('wrong bytes') });
  await expect(prepareEngineeringDependencies(b.options)).rejects.toThrow('integrity_mismatch'); expect(existsSync(b.options.materializationRoot)).toBe(false);
});
test('materialized capability rechecks contents, inode identity, modes, membership and links on each use', async () => {
  for (const mutation of ['contents', 'inode', 'mode', 'extra', 'link']) {
    const { root, options } = fixture(); const result = (await prepareEngineeringDependencies(options))!;
    const file = join(result.root, 'manifest.json'); chmodSync(result.root, 0o700);
    if (mutation === 'contents') { chmodSync(file, 0o600); writeFileSync(file, 'changed'); chmodSync(file, 0o444); }
    if (mutation === 'inode') { const raw = readFileSync(file); renameSync(file, join(root, 'old')); writeFileSync(file, raw, { mode: 0o444 }); }
    if (mutation === 'mode') chmodSync(file, 0o644);
    if (mutation === 'extra') writeFileSync(join(result.root, 'unexpected'), 'extra');
    if (mutation === 'link') { renameSync(file, join(root, 'old')); symlinkSync(join(root, 'old'), file); }
    chmodSync(result.root, 0o500);
    expect(() => result.assertCurrent()).toThrow();
  }
});
test('binary Bun lock remains explicitly unsupported by the broker and unsafe source links fail before DNS', async () => {
  const a = fixture(true, true); renameSync(join(a.options.workspaceRoot, 'bun.lock'), join(a.options.workspaceRoot, 'bun.lockb'));
  a.options.profile = createEngineeringVerificationProfile({ workspaceRoot: a.options.workspaceRoot });
  await expect(prepareEngineeringDependencies(a.options)).rejects.toThrow('binary_or_missing_lockfile_unsupported');
  const b = fixture(); renameSync(join(b.options.workspaceRoot, 'package-lock.json'), join(b.root, 'lock'));
  symlinkSync(join(b.root, 'lock'), join(b.options.workspaceRoot, 'package-lock.json'));
  await expect(prepareEngineeringDependencies(b.options)).rejects.toThrow('unsafe_file');
});
test('lifecycle authority is explicit host input bound in the hash, never inferred from package scripts', async () => {
  const { options } = fixture(); options.allowLifecycleScripts = true;
  const result = (await prepareEngineeringDependencies(options))!;
  expect(JSON.parse(readFileSync(join(result.root, 'manifest.json'), 'utf8')).allowLifecycleScripts).toBe(true);
  expect(existsSync(join(options.workspaceRoot, 'node_modules'))).toBe(false);
});

test('candidate names, versions and integrity cannot create an outbound path before any DNS or HTTP effect', async () => {
  for (const variant of ['private-name', 'private-version', 'integrity']) {
    const { options } = fixture(), baseline = options.profile;
    const name = variant === 'private-name' ? 'private-customer-secret' : 'demo';
    const version = variant === 'private-version' ? '1.0.0+private-customer-secret' : '1.0.0';
    const sri = variant === 'integrity' ? 'sha512-' + Buffer.alloc(64, 9).toString('base64') : integrity;
    writeFileSync(join(options.workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { [name]: version } }));
    writeFileSync(join(options.workspaceRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { dependencies: { [name]: version } }, ['node_modules/' + name]: { version, integrity: sri,
        resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } } }));
    options.profile = createEngineeringCandidateVerificationProfile(baseline, { workspaceRoot: options.workspaceRoot });
    let dns = 0, http = 0;
    options.network.resolve = async () => { dns++; return ['1.1.1.1']; };
    options.network.transport = async () => { http++; return { status: 404, headers: {}, bytes: payload }; };
    await expect(prepareEngineeringDependencies(options)).rejects.toThrow('coordinate_not_admitted');
    expect({ dns, http }).toEqual({ dns: 0, http: 0 }); expect(existsSync(options.materializationRoot)).toBe(false);
    expect(() => mintEngineeringDependencyAdmission(options)).toThrow('original_profile_required');
  }
});

test('same admitted coordinates are reusable for candidate checks but copied or cross-task capabilities are rejected', async () => {
  const { options } = fixture(), original = options.profile;
  options.profile = createEngineeringCandidateVerificationProfile(original, { workspaceRoot: options.workspaceRoot });
  options.provenanceSha256 = 'b'.repeat(64); // New captured artifact, same public coordinates.
  expect(await prepareEngineeringDependencies(options)).toBeDefined();
  let dns = 0; options.network.resolve = async () => { dns++; return ['1.1.1.1']; };
  await expect(prepareEngineeringDependencies({ ...options, dependencyAdmission: { ...options.dependencyAdmission } })).rejects.toThrow('untrusted_admission');
  for (const binding of [{ ...options.binding, taskId: 'foreign' }, { ...options.binding, scopeKey: 'shared:other' },
    { ...options.binding, deadlineMs: options.binding.deadlineMs + 1 }]) {
    await expect(prepareEngineeringDependencies({ ...options, binding })).rejects.toThrow('engineering_dependency_admission:binding');
  }
  expect(dns).toBe(0);
});

test('a dependency-free baseline admits no candidate coordinates and cannot be forged by copying a profile', async () => {
  const { options } = fixture(false), original = options.profile;
  expect(() => mintEngineeringDependencyAdmission({ ...options, profile: { ...original } })).toThrow('original_profile_required');
  writeFileSync(join(options.workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { demo: '1.0.0' } }));
  writeFileSync(join(options.workspaceRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { demo: '1.0.0' } }, 'node_modules/demo': { version: '1.0.0', integrity } } }));
  options.profile = createEngineeringCandidateVerificationProfile(original, { workspaceRoot: options.workspaceRoot });
  let dns = 0; options.network.resolve = async () => { dns++; return ['1.1.1.1']; };
  await expect(prepareEngineeringDependencies(options)).rejects.toThrow('coordinate_not_admitted'); expect(dns).toBe(0);
});
