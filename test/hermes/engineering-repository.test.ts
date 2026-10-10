import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireEngineeringRepository, assertStandaloneEngineeringClone, createEngineeringHostGitRunner,
  createEngineeringRestAppObserver, engineeringCredentialFromGitHubClient, resolveCurrentEngineeringRepository,
} from '../../src/hermes/engineering-repository.ts';
import type {
  EngineeringAppCredential, EngineeringAppObserver, EngineeringCloneReceipt, EngineeringInstallationRepository,
  EngineeringRepositoryGitInvocation, EngineeringRepositoryResolution, EngineeringRepositoryResolverOptions,
} from '../../src/hermes/engineering-repository.ts';
import type { EngineeringHostAuthority } from '../../src/hermes/engineering-policy.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = () => 100_000;
const binding = { appId: 77, installationId: 88 };
const repo = '707-Labs/test-repository';
const cleanUrl = `https://github.com/${repo}.git`;
const base = { branch: 'feature/approved-base', commit: 'a'.repeat(40) };
const token = 'synthetic_fixture_token_only_123456789';
const host: EngineeringHostAuthority = { authenticated: true, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
  surface: 'private_dm', channelId: 'D123456789', threadTs: '1234567890.12345' };
const auth = (): EngineeringAppCredential => ({ kind: 'app', ...binding, accountLogin: '707-Labs', token, issuedAtMs: 99_000, expiresAtMs: 200_000,
  permissions: { contents: 'write', pullRequests: 'write' } });
const row = (id = 42, fullName = repo): EngineeringInstallationRepository => ({ repositoryId: id, fullName, archived: false, disabled: false });

function observer(repositories: EngineeringInstallationRepository[] = [row()]): EngineeringAppObserver {
  return {
    async installation() { return { ...binding, accountLogin: '707-Labs', contents: 'write', pullRequests: 'write', observedAtMs: now() }; },
    async repositories(page) { return { installationId: binding.installationId, observedAtMs: now(), totalCount: repositories.length, repositories: repositories.slice((page - 1) * 100, page * 100) }; },
  };
}
function resolverOptions(override: Partial<EngineeringRepositoryResolverOptions> = {}): EngineeringRepositoryResolverOptions {
  return { binding, observer: observer(), audienceGrants: () => [], now, ...override };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-engineering-repository-test-'))); roots.push(root);
  const workspaceRoot = join(root, 'new-clone');
  const invocations: EngineeringRepositoryGitInvocation[] = [];
  const authentication: Array<string | undefined> = [];
  const receipts: EngineeringCloneReceipt[] = [];
  let currentHead = base.commit;
  const git = {
    async run(invocation: EngineeringRepositoryGitInvocation, header?: string) {
      invocations.push(structuredClone(invocation)); authentication.push(header);
      const args = invocation.args;
      if (args[0] === 'init') {
        mkdirSync(join(workspaceRoot, '.git', 'objects', 'info'), { recursive: true });
        writeFileSync(join(workspaceRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        writeFileSync(join(workspaceRoot, '.git', 'config'), '[core]\n\tbare = false\n');
      }
      if (args[0] === 'remote') writeFileSync(join(workspaceRoot, '.git', 'config'), `[core]\n\tbare = false\n\thooksPath = /dev/null\n[remote "origin"]\n\turl = ${cleanUrl}\n`);
      return { stdout: args[0] === 'rev-parse' ? `${currentHead}\n` : '' };
    },
  };
  const input = { taskId: 'engineering-test-task', base, workspaceRoot, deadlineMs: 150_000, git,
    getCredential: async () => auth(), assertOwner() {}, append(receipt: Readonly<EngineeringCloneReceipt>) { receipts.push(receipt); } };
  return { root, workspaceRoot, invocations, authentication, receipts, input, setHead(value: string) { currentHead = value; } };
}

describe('current GitHub App repository authority', () => {
  test('reads all installation pages and resolves numeric repository/installation identity', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => row(i + 1, `707-Labs/repo-${i + 1}`));
    const real = observer(rows); const pages: number[] = []; let observations = 0;
    const options = resolverOptions({ observer: { installation: async () => { observations++; return real.installation(); },
      repositories: async page => { pages.push(page); return real.repositories(page); } } });
    const resolution = await resolveCurrentEngineeringRepository('repo-101', host, options);
    expect(pages).toEqual([1, 2]); expect(observations).toBe(2);
    expect(resolution.repository.repositoryId).toBe(101); expect(resolution.repository.installationId).toBe(88);
    expect(resolution.appId).toBe(77); expect(Object.isFrozen(resolution.repository)).toBe(true);
  });

  test('rejects partial pages, duplicate IDs/names, changed totals and stale snapshots', async () => {
    const real = observer();
    const bad: EngineeringAppObserver[] = [
      { ...real, repositories: async () => ({ installationId: 88, observedAtMs: now(), totalCount: 2, repositories: [row()] }) },
      observer([row(), row()]), observer([row(), row(43, '707-Labs/TEST-REPOSITORY')]),
      { ...real, installation: async () => ({ ...(await real.installation()), observedAtMs: 1 }) },
      { ...real, repositories: async () => ({ installationId: 999, observedAtMs: now(), totalCount: 1, repositories: [row()] }) },
      observer([row(42, 'other-org/test-repository')]),
    ];
    for (const value of bad) await expect(resolveCurrentEngineeringRepository(repo, host, resolverOptions({ observer: value }))).rejects.toThrow();
    let call = 0;
    await expect(resolveCurrentEngineeringRepository(repo, host, resolverOptions({ observer: { ...real,
      installation: async () => ({ ...(await real.installation()), contents: ++call === 1 ? 'write' : 'read' }) } }))).rejects.toThrow('installation_changed');
  });

  test('GitHub access does not grant a shared audience; grants bind numeric ID through rename/replacement', async () => {
    const shared: EngineeringHostAuthority = { ...host, surface: 'shared_channel', channelId: 'C123456789' };
    await expect(resolveCurrentEngineeringRepository(repo, shared, resolverOptions())).rejects.toThrow('audience');
    const approved = resolverOptions({ audienceGrants: () => [{ repositoryId: 42, sharedChannelIds: ['C123456789'] }] });
    expect((await resolveCurrentEngineeringRepository(repo, shared, approved)).repository.repositoryId).toBe(42);
    await expect(resolveCurrentEngineeringRepository(repo, shared, { ...approved, observer: observer([row(43)]) })).rejects.toThrow('audience');
    await expect(resolveCurrentEngineeringRepository(repo, host, resolverOptions({ observer: observer([{ ...row(), archived: true }]) }))).rejects.toThrow('repository_unavailable');
  });

  test('REST observer sends only readonly fixed-host requests with host-only headers', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return Response.json({ total_count: 1, repositories: [{ id: 42, full_name: repo, archived: false, disabled: false, owner: { login: '707-Labs' } }] });
    }) as unknown as typeof fetch;
    const api = createEngineeringRestAppObserver({ binding, fetch: fetcher, getCredential: async () => auth(), now });
    const resolution = await resolveCurrentEngineeringRepository(repo, host, resolverOptions({ observer: api }));
    expect(resolution.repository.repositoryId).toBe(42);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.github.com/installation/repositories?per_page=100&page=1');
    expect(requests[0]?.init?.method).toBe('GET'); expect(requests[0]?.init?.redirect).toBe('error');
    expect(JSON.stringify(resolution)).not.toContain(token);
    expect(JSON.stringify(await api.installation())).not.toContain(token);
  });

  test('REST denies expired/wrong-installation/stale credentials and hides raw API errors', async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; throw new Error(`secret:${token}`); }) as unknown as typeof fetch;
    for (const patch of [{ installationId: 999 }, { expiresAtMs: 100_000 }, { issuedAtMs: 1 }]) {
      const api = createEngineeringRestAppObserver({ binding, fetch: fetcher, getCredential: async () => ({ ...auth(), ...patch }), now });
      await expect(api.repositories(1)).rejects.toThrow('credential_unavailable');
    }
    expect(calls).toBe(0);
    const api = createEngineeringRestAppObserver({ binding, fetch: fetcher, getCredential: async () => auth(), now });
    await expect(api.repositories(1)).rejects.toThrow(/^engineering_repository:installation_unavailable$/);
    await expect(api.repositories(0)).rejects.toThrow('repository_page');
  });

  test('existing-client bridge requires explicit App metadata and exact repository URL', async () => {
    const metadata = async () => { const { token: _, ...result } = auth(); return result; };
    const callback = engineeringCredentialFromGitHubClient({ cloneUrl: async () => `https://x-access-token:${token}@github.com/${repo}.git` }, { binding, metadata, now });
    expect((await callback(repo)).installationId).toBe(88);
    for (const url of [`https://x-access-token:${token}@evil.example/${repo}.git`, `https://x-access-token:${token}@github.com/707-Labs/other.git`, `https://github.com/${repo}.git`]) {
      const bad = engineeringCredentialFromGitHubClient({ cloneUrl: async () => url }, { binding, metadata, now });
      await expect(bad(repo)).rejects.toThrow(/^engineering_repository:credential_unavailable$/);
    }
  });
});

describe('independent host clone acquisition', () => {
  test('uses fresh authority, standalone Git init/fetch and clean URLs; persists no credential', async () => {
    const f = fixture(); let snapshots = 0; const original = observer();
    const options = resolverOptions({ observer: { ...original, installation: async () => { snapshots++; return original.installation(); } } });
    const resolution = await resolveCurrentEngineeringRepository(repo, host, options);
    const result = await acquireEngineeringRepository({ ...f.input, resolution });
    expect(result.baseCommit).toBe(base.commit); expect(snapshots).toBe(6);
    expect(f.invocations.map(i => i.args[0])).toEqual(['init', 'config', 'remote', 'fetch', 'rev-parse', 'checkout', 'rev-parse']);
    expect(JSON.stringify(f.invocations)).not.toContain(token);
    expect(JSON.stringify(f.receipts)).not.toContain(token);
    expect(readFileSync(join(f.workspaceRoot, '.git/config'), 'utf8')).not.toContain(token);
    expect(f.authentication.filter(Boolean)).toHaveLength(1);
    expect(Buffer.from(f.authentication[3]!.slice('Authorization: Basic '.length), 'base64').toString()).toBe(`x-access-token:${token}`);
    expect(f.receipts.map(r => r.kind)).toEqual(['acquisition_started', 'acquisition_verified']);
    expect(f.invocations.some(i => i.args.includes('--shared') || i.args.includes('--reference') || i.args.includes('worktree'))).toBe(false);
  });

  test('rejects forged resolution and stale/replaced numeric authority before filesystem work', async () => {
    const f = fixture(); const resolution = await resolveCurrentEngineeringRepository(repo, host, resolverOptions());
    await expect(acquireEngineeringRepository({ ...f.input, resolution: structuredClone(resolution) })).rejects.toThrow('untrusted_resolution');
    let current = [row()]; const original = observer();
    const changing = resolverOptions({ observer: { ...original, repositories: async () => ({ installationId: 88, totalCount: current.length, repositories: current, observedAtMs: now() }) } });
    const bound = await resolveCurrentEngineeringRepository(repo, host, changing); current = [row(43)];
    await expect(acquireEngineeringRepository({ ...f.input, resolution: bound })).rejects.toThrow('repository_authority_changed');
    expect(existsSync(f.workspaceRoot)).toBe(false); expect(f.invocations).toHaveLength(0);
  });

  test('preserves a failed new clone and never changes preexisting workspace data', async () => {
    const f = fixture(); const resolution = await resolveCurrentEngineeringRepository(repo, host, resolverOptions());
    f.setHead('b'.repeat(40));
    await expect(acquireEngineeringRepository({ ...f.input, resolution })).rejects.toThrow(/^engineering_repository:acquisition_failed$/);
    expect(existsSync(f.workspaceRoot)).toBe(true);
    expect(f.invocations.some(i => i.args[0] === 'checkout')).toBe(false);
    expect(f.receipts.at(-1)?.kind).toBe('acquisition_failed');
    writeFileSync(join(f.workspaceRoot, 'preserve.txt'), 'existing task');
    await expect(acquireEngineeringRepository({ ...f.input, resolution })).rejects.toThrow('workspace');
    expect(readFileSync(join(f.workspaceRoot, 'preserve.txt'), 'utf8')).toBe('existing task');
  });

  test('revalidates authority after clone and refuses publication of revoked acquisition', async () => {
    const f = fixture(); let repositoryPresent = true; const original = observer();
    const options = resolverOptions({ observer: { ...original, repositories: async () => ({ installationId: 88,
      observedAtMs: now(), totalCount: repositoryPresent ? 1 : 0, repositories: repositoryPresent ? [row()] : [] }) } });
    const resolution = await resolveCurrentEngineeringRepository(repo, host, options);
    const originalRun = f.input.git.run;
    const git = { run: async (i: EngineeringRepositoryGitInvocation, header?: string) => { const value = await originalRun(i, header); if (i.args[0] === 'checkout') repositoryPresent = false; return value; } };
    await expect(acquireEngineeringRepository({ ...f.input, git, resolution })).rejects.toThrow('acquisition_failed');
    expect(f.receipts.some(r => r.kind === 'acquisition_verified')).toBe(false);
  });

  test('owner revocation and receipt failure stop acquisition before further effects', async () => {
    const f = fixture(); const resolution = await resolveCurrentEngineeringRepository(repo, host, resolverOptions());
    await expect(acquireEngineeringRepository({ ...f.input, resolution, assertOwner() { throw new Error('revoked'); } })).rejects.toThrow('revoked');
    expect(f.invocations).toHaveLength(0);
    await expect(acquireEngineeringRepository({ ...f.input, resolution, append() { throw new Error('disk-full'); } })).rejects.toThrow('disk-full');
    expect(existsSync(f.workspaceRoot)).toBe(false);
  });

  test('standalone validation rejects alternates, linked metadata, hard links and credential config', async () => {
    const f = fixture(); const resolution = await resolveCurrentEngineeringRepository(repo, host, resolverOptions());
    await acquireEngineeringRepository({ ...f.input, resolution });
    const alternates = join(f.workspaceRoot, '.git/objects/info/alternates'); writeFileSync(alternates, '/unrelated/objects');
    expect(() => assertStandaloneEngineeringClone(f.workspaceRoot, cleanUrl)).toThrow('shared_git_metadata'); rmSync(alternates);
    const outside = join(f.root, 'outside'); writeFileSync(outside, 'data');
    const linked = join(f.workspaceRoot, '.git/linked'); symlinkSync(outside, linked);
    expect(() => assertStandaloneEngineeringClone(f.workspaceRoot, cleanUrl)).toThrow('shared_git_metadata'); rmSync(linked);
    linkSync(outside, linked); expect(() => assertStandaloneEngineeringClone(f.workspaceRoot, cleanUrl)).toThrow('shared_git_metadata'); rmSync(linked);
    writeFileSync(join(f.workspaceRoot, '.git/config'), `[remote "origin"]\n url = https://x-access-token:${token}@github.com/${repo}.git\n`);
    expect(() => assertStandaloneEngineeringClone(f.workspaceRoot, cleanUrl)).toThrow('git_config');
  });
});

describe('host Git credential transport', () => {
  test('secret exists only in the fetch child environment; argv/config/log data stays clean', async () => {
    const launches: Array<{ binary: string; args: readonly string[]; env: Record<string, string>; rawEnv: Record<string, string> }> = [];
    const fakeSpawn = ((binary: string, args: string[], options: { env: Record<string, string> }) => {
      launches.push({ binary, args, env: { ...options.env }, rawEnv: options.env });
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill(): boolean };
      child.stdout = new EventEmitter(); child.kill = () => true;
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('done')); child.emit('close', 0); }); return child;
    }) as unknown as typeof spawn;
    const runner = createEngineeringHostGitRunner({ gitBinary: '/usr/bin/git', spawn: fakeSpawn, now });
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    await runner.run({ cwd: '/synthetic/task-only', args: ['fetch', 'origin', 'refs/heads/main'], deadlineMs: 100_100 }, header);
    await runner.run({ cwd: '/synthetic/task-only', args: ['rev-parse', 'HEAD'], deadlineMs: 100_100 });
    expect(JSON.stringify(launches.map(l => l.args))).not.toContain(token);
    expect(launches[0]?.env.GIT_CONFIG_VALUE_0).toBe(header);
    expect(launches[0]?.rawEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(launches[1]?.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(launches[0]?.env.HOME).toBe('/nonexistent');
    expect(launches[0]?.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(launches[0]?.args).toContain('credential.helper=');
    expect(launches[0]?.args).toContain('http.followRedirects=false');
    expect(Object.keys(launches[0]!.env).some(key => key.startsWith('AWS_') || key.startsWith('SLACK_'))).toBe(false);
    await expect(runner.run({ cwd: '/synthetic/task-only', args: ['push', 'origin'], deadlineMs: 100_100 }, header)).rejects.toThrow('authentication_channel');
  });

  test('Git launch/output failures never reflect credential-bearing raw errors', async () => {
    const fakeSpawn = (() => { throw new Error(token); }) as unknown as typeof spawn;
    const runner = createEngineeringHostGitRunner({ gitBinary: '/usr/bin/git', spawn: fakeSpawn, now });
    await expect(runner.run({ cwd: '/synthetic', args: ['init', '.'], deadlineMs: 100_100 })).rejects.toThrow(/^engineering_repository:git_failed$/);
    await expect(runner.run({ cwd: '/synthetic', args: ['init', '.'], deadlineMs: 100_000 })).rejects.toThrow('deadline');
  });
});
