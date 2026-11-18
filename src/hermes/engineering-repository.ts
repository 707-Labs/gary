/** Dormant host-only repository acquisition. Importing performs no I/O. No
 * existing bare clone/worktree, user Git configuration, or model credential is
 * accepted. Network and filesystem work requires explicit host invocation. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isGitHubEngineeringToken, type GitHubClient } from '../adapters/github.ts';
import { isSafeGitBranch } from '../git.ts';
import { resolveEngineeringRepository } from './engineering-policy.ts';
import type { EngineeringHostAuthority, EngineeringRepositoryAccess, ResolvedEngineeringRepository } from './engineering-policy.ts';

export interface EngineeringAppBinding { appId: number; installationId: number }
export interface EngineeringAppCredential extends EngineeringAppBinding {
  kind: 'app'; accountLogin: string; token: string; issuedAtMs: number; expiresAtMs: number;
  /** Host-observed installation/token-issuance permissions, never inferred from a URL. */
  permissions: { contents: 'read' | 'write'; pullRequests: 'none' | 'read' | 'write' };
}
export interface EngineeringInstallationObservation extends EngineeringAppBinding {
  accountLogin: '707-Labs'; contents: 'read' | 'write'; pullRequests: 'none' | 'read' | 'write';
  observedAtMs: number;
}
export interface EngineeringInstallationRepository { repositoryId: number; fullName: string; archived: boolean; disabled: boolean }
export interface EngineeringRepositoryPage {
  installationId: number; totalCount: number; repositories: readonly EngineeringInstallationRepository[]; observedAtMs: number;
}
export interface EngineeringAppObserver {
  installation(): Promise<EngineeringInstallationObservation>;
  repositories(page: number): Promise<EngineeringRepositoryPage>;
}
export interface EngineeringRepositoryAudienceGrant { repositoryId: number; sharedChannelIds: readonly string[] }
export interface EngineeringRepositoryResolution {
  readonly repository: ResolvedEngineeringRepository;
  readonly appId: number;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly snapshotHash: string;
}
export interface EngineeringRepositoryResolverOptions {
  binding: EngineeringAppBinding;
  observer: EngineeringAppObserver;
  /** Fresh host audience grants; GitHub App access alone never grants a shared audience. */
  audienceGrants(): readonly EngineeringRepositoryAudienceGrant[];
  now?: () => number;
}
const MAX_AGE_MS = 60_000;
const bindings = new WeakMap<EngineeringRepositoryResolution, EngineeringRepositoryResolverOptions>();
const REPO = /^707-Labs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SHA = /^[a-f0-9]{40}$/;
function fail(code: string): never { throw new Error(`engineering_repository:${code}`); }
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validBinding(value: EngineeringAppBinding): void {
  if (!positive(value.appId) || !positive(value.installationId)) fail('app_binding');
}
function fresh(value: number, now: number): void {
  if (!Number.isSafeInteger(value) || value > now || now - value > MAX_AGE_MS) fail('stale_snapshot');
}
function installation(value: EngineeringInstallationObservation, binding: EngineeringAppBinding, now: number): void {
  validBinding(value); fresh(value.observedAtMs, now);
  if (value.appId !== binding.appId || value.installationId !== binding.installationId || value.accountLogin !== '707-Labs'
      || !['read', 'write'].includes(value.contents) || !['none', 'read', 'write'].includes(value.pullRequests)) fail('installation_authority');
}
function sameAccess(a: EngineeringRepositoryResolution, b: EngineeringRepositoryResolution): boolean {
  return a.appId === b.appId && a.repository.installationId === b.repository.installationId
    && a.repository.repositoryId === b.repository.repositoryId && a.repository.repo === b.repository.repo
    && a.repository.contents === b.repository.contents && a.repository.pullRequests === b.repository.pullRequests;
}

/** Enumerates every page and re-observes installation permissions; an incomplete,
 * inconsistent, stale or ambiguous snapshot cannot confer repository authority. */
export async function resolveCurrentEngineeringRepository(requestedRepo: string, host: EngineeringHostAuthority,
  options: EngineeringRepositoryResolverOptions): Promise<EngineeringRepositoryResolution> {
  validBinding(options.binding);
  const now = options.now ?? Date.now;
  const before = await options.observer.installation(); installation(before, options.binding, now());
  const rows: EngineeringInstallationRepository[] = [];
  const ids = new Set<number>(), names = new Set<string>();
  let expected = -1;
  for (let page = 1; page <= 100; page++) {
    const result = await options.observer.repositories(page); fresh(result.observedAtMs, now());
    if (result.installationId !== before.installationId || !Number.isSafeInteger(result.totalCount)
        || result.totalCount < 0 || result.totalCount > 10_000 || !Array.isArray(result.repositories)
        || result.repositories.length > 100 || (expected !== -1 && result.totalCount !== expected)) fail('repository_pagination');
    expected = result.totalCount;
    for (const repository of result.repositories) {
      if (!positive(repository.repositoryId) || typeof repository.fullName !== 'string' || !REPO.test(repository.fullName)
          || repository.fullName.endsWith('.git') || typeof repository.archived !== 'boolean' || typeof repository.disabled !== 'boolean'
          || ids.has(repository.repositoryId) || names.has(repository.fullName.toLowerCase())) fail('repository_snapshot');
      ids.add(repository.repositoryId); names.add(repository.fullName.toLowerCase());
      rows.push({ repositoryId: repository.repositoryId, fullName: repository.fullName, archived: repository.archived, disabled: repository.disabled });
    }
    if (rows.length === expected) break;
    if (rows.length > expected || result.repositories.length !== 100 || page === 100) fail('repository_pagination');
  }
  const after = await options.observer.installation(); installation(after, options.binding, now());
  fresh(before.observedAtMs, now());
  if (before.contents !== after.contents || before.pullRequests !== after.pullRequests) fail('installation_changed');
  const grants = options.audienceGrants();
  const byRepository = new Map<number, readonly string[]>();
  for (const grant of grants) {
    if (!positive(grant.repositoryId) || byRepository.has(grant.repositoryId) || !Array.isArray(grant.sharedChannelIds)
        || grant.sharedChannelIds.some(id => typeof id !== 'string' || !/^C[A-Z0-9]{8,20}$/.test(id))
        || new Set(grant.sharedChannelIds).size !== grant.sharedChannelIds.length) fail('audience_grant');
    byRepository.set(grant.repositoryId, [...grant.sharedChannelIds]);
  }
  const access: EngineeringRepositoryAccess[] = rows.map(row => ({ ...row, installationId: before.installationId,
    contents: before.contents, pullRequests: before.pullRequests, appAccessible: true, sharedChannelIds: byRepository.get(row.repositoryId) ?? [] }));
  const repository = resolveEngineeringRepository(requestedRepo, host, access);
  const value = Object.freeze({ repository, appId: before.appId, observedAtMs: before.observedAtMs,
    expiresAtMs: before.observedAtMs + MAX_AGE_MS, snapshotHash: hash({ before, rows, access }) });
  bindings.set(value, { ...options, binding: Object.freeze({ ...options.binding }) });
  return value;
}

function credential(value: EngineeringAppCredential, binding: EngineeringAppBinding, now: number): EngineeringAppCredential {
  fresh(value.issuedAtMs, now);
  if (value.kind !== 'app' || value.accountLogin !== '707-Labs' || value.appId !== binding.appId || value.installationId !== binding.installationId
      || !isGitHubEngineeringToken(value.token)
      || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= now || value.expiresAtMs <= value.issuedAtMs
      || !['read', 'write'].includes(value.permissions.contents) || !['none', 'read', 'write'].includes(value.permissions.pullRequests)) fail('credential_binding');
  return value;
}

/** Narrow compatibility bridge. The host MUST supply App-only installation and
 * issuance metadata from its credential broker. cloneUrl alone also permits PATs
 * and cannot establish any App identity or permissions. */
export function engineeringCredentialFromGitHubClient(client: Pick<GitHubClient, 'cloneUrl'>, input: {
  binding: EngineeringAppBinding; metadata(): Promise<Omit<EngineeringAppCredential, 'token'>>; now?: () => number;
}): (repo: string) => Promise<EngineeringAppCredential> {
  validBinding(input.binding);
  return async repo => {
    if (!REPO.test(repo) || repo.endsWith('.git')) fail('repository');
    try {
      const metadata = await input.metadata();
      const url = new URL(await client.cloneUrl('707-Labs', repo.slice('707-Labs/'.length)));
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username !== 'x-access-token'
          || url.pathname !== `/${repo}.git` || url.search || url.hash) fail('credential_url');
      return credential({ ...metadata, token: decodeURIComponent(url.password) }, input.binding, (input.now ?? Date.now)());
    } catch { return fail('credential_unavailable'); }
  };
}

/** Direct read-only REST observer. The credential callback must return the App
 * installation ID and exact permissions from authenticated token issuance.
 * It supplies no PAT fallback and never reflects response bodies/errors. */
export function createEngineeringRestAppObserver(input: {
  binding: EngineeringAppBinding; fetch: typeof fetch;
  getCredential(): Promise<EngineeringAppCredential>; now?: () => number;
}): EngineeringAppObserver {
  validBinding(input.binding);
  const now = input.now ?? Date.now;
  const get = async () => {
    try { return credential(await input.getCredential(), input.binding, now()); }
    catch { return fail('credential_unavailable'); }
  };
  return {
    async installation() {
      const auth = await get();
      return { ...input.binding, accountLogin: auth.accountLogin as '707-Labs', contents: auth.permissions.contents,
        pullRequests: auth.permissions.pullRequests, observedAtMs: auth.issuedAtMs };
    },
    async repositories(page) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 100) fail('repository_page');
      const auth = await get();
      try {
        const response = await input.fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        });
        if (response.status !== 200 || response.redirected) fail('installation_unavailable');
        if (!response.body) fail('repository_snapshot');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break;
            size += item.value.byteLength;
            if (size > 4 * 1024 * 1024) { await reader.cancel(); fail('repository_response_limit'); }
            chunks.push(item.value);
          }
        } finally { reader.releaseLock(); }
        const body = Buffer.concat(chunks).toString('utf8');
        const data = JSON.parse(body) as { total_count: number; repositories: Array<{ id: number; full_name: string; archived: boolean; disabled: boolean; owner: { login: string } }> };
        if (!Array.isArray(data.repositories) || data.repositories.length > 100 || data.repositories.some(repo => repo.owner?.login !== '707-Labs')) fail('repository_snapshot');
        return { installationId: auth.installationId, totalCount: data.total_count, observedAtMs: now(),
          repositories: data.repositories.map(repo => ({ repositoryId: repo.id, fullName: repo.full_name, archived: repo.archived, disabled: repo.disabled })) };
      } catch { return fail('installation_unavailable'); }
    },
  };
}

/** Production composition using the existing App client's optional host-only
 * seam. PAT clients fail before a request. Fetch remains explicitly injected. */
export function createEngineeringGitHubRepositoryServices(input: {
  client: Pick<GitHubClient, 'engineeringInstallationCredential'>;
  binding: EngineeringAppBinding; fetch: typeof fetch; now?: () => number;
}): { observer: EngineeringAppObserver; getCredential(repo: string): Promise<EngineeringAppCredential> } {
  validBinding(input.binding);
  if (!input.client.engineeringInstallationCredential) fail('github_app_required');
  const now = input.now ?? Date.now;
  const get = async () => {
    try { return credential(await input.client.engineeringInstallationCredential!(), input.binding, now()); }
    catch { return fail('credential_unavailable'); }
  };
  return {
    observer: createEngineeringRestAppObserver({ binding: input.binding, fetch: input.fetch, getCredential: get, now }),
    async getCredential(repo) { if (!REPO.test(repo) || repo.endsWith('.git')) fail('repository'); return get(); },
  };
}

/** Pin the default branch's current commit from the same authenticated App
 * repository observation. No task text can choose an API URL or credential. */
export async function resolveEngineeringDefaultBase(input: {
  resolution: EngineeringRepositoryResolution; getCredential(repo: string): Promise<EngineeringAppCredential>;
  fetch: typeof fetch; now?: () => number;
}): Promise<Readonly<{ branch: string; commit: string }>> {
  const options = bindings.get(input.resolution);
  if (!options) fail('untrusted_resolution');
  const now = input.now ?? Date.now, repo = input.resolution.repository;
  const auth = credential(await input.getCredential(repo.repo), options.binding, now());
  const read = async (suffix: string): Promise<Record<string, unknown>> => {
    const response = await input.fetch(`https://api.github.com/repos/${repo.repo}${suffix}`, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (response.status !== 200 || response.redirected || !response.body) fail('base_unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break;
        if ((size += next.value.byteLength) > 256 * 1024) { await reader.cancel(); fail('base_response_limit'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('base_unavailable');
    return value as Record<string, unknown>;
  };
  try {
    const metadata = await read('');
    if (metadata.id !== repo.repositoryId || metadata.full_name !== repo.repo || metadata.archived !== false
        || metadata.disabled !== false || typeof metadata.default_branch !== 'string' || !isSafeGitBranch(metadata.default_branch)) fail('repository_changed');
    const head = await read('/branches/' + encodeURIComponent(metadata.default_branch));
    const commit = head.commit as Record<string, unknown> | undefined;
    if (head.name !== metadata.default_branch || !commit || typeof commit.sha !== 'string' || !SHA.test(commit.sha)) fail('base_unavailable');
    return Object.freeze({ branch: metadata.default_branch, commit: commit.sha });
  } catch { return fail('base_unavailable'); }
}

export interface EngineeringRepositoryGitInvocation {
  readonly cwd: string; readonly args: readonly string[]; readonly deadlineMs: number;
}
export interface EngineeringRepositoryGitRunner {
  /** Header is a separate ephemeral host-only channel; never serialize/log it. */
  run(invocation: EngineeringRepositoryGitInvocation, authorizationHeader?: string): Promise<{ stdout: string }>;
}
const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=never', '-c', 'submodule.recurse=false', '-c', 'http.followRedirects=false'];

/** Explicit host transport. Only the network fetch child receives authentication,
 * via ephemeral GIT_CONFIG_* environment, never argv or an on-disk config file.
 * Environment inheritance, user Git config, helpers, templates and redirects are
 * disabled. No stderr or raw process error is returned or persisted. */
export function createEngineeringHostGitRunner(input: { gitBinary: string; spawn?: typeof spawn; now?: () => number }): EngineeringRepositoryGitRunner {
  if (!isAbsolute(input.gitBinary) || /[\r\n\0]/.test(input.gitBinary)) fail('git_binary');
  const launch = input.spawn ?? spawn;
  const now = input.now ?? Date.now;
  return {
    async run(invocation, authorizationHeader) {
      const remaining = invocation.deadlineMs - now();
      if (!Number.isSafeInteger(remaining) || remaining <= 0) fail('deadline');
      const environment: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
        GIT_SSH_COMMAND: '/usr/bin/false', GIT_NO_REPLACE_OBJECTS: '1', GIT_LFS_SKIP_SMUDGE: '1' };
      if (authorizationHeader !== undefined) {
        if (invocation.args[0] !== 'fetch' || !/^Authorization: Basic [A-Za-z0-9+/]+=*$/.test(authorizationHeader)) fail('authentication_channel');
        environment.GIT_CONFIG_COUNT = '1';
        environment.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
        environment.GIT_CONFIG_VALUE_0 = authorizationHeader;
      }
      return await new Promise<{ stdout: string }>((resolvePromise, reject) => {
        let output = ''; let rejected = false;
        const rejectFixed = () => { rejected = true; };
        let child: ReturnType<typeof spawn>;
        try { child = launch(input.gitBinary, [...gitOptions, ...invocation.args], { cwd: invocation.cwd,
          env: environment, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' }); }
        catch { reject(new Error('engineering_repository:git_failed')); return; }
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ } };
        const stop = () => { if (rejected) return; rejected = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 250); };
        const timer = setTimeout(stop, remaining);
        child.stdout?.on('data', (bytes: Buffer) => { if (Buffer.byteLength(output) + bytes.length > 64 * 1024) stop(); else output += bytes.toString('utf8'); });
        child.on('error', rejectFixed);
        child.on('close', code => {
          clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
          if (rejected) kill('SIGKILL');
          for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete environment[name];
          if (code !== 0 || rejected) reject(new Error('engineering_repository:git_failed'));
          else resolvePromise({ stdout: authorizationHeader === undefined ? output : '' });
        });
      });
    },
  };
}

/** Only the new task clone is inspected. Nothing in an existing checkout is modified. */
export function assertStandaloneEngineeringClone(root: string, cleanUrl: string): void {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail('workspace');
  const git = join(root, '.git');
  if (!lstatSync(git).isDirectory() || lstatSync(git).isSymbolicLink()) fail('standalone_git');
  for (const path of ['commondir', 'gitdir', 'worktrees', 'modules', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if (existsSync(join(git, path))) fail('shared_git_metadata');
  }
  let entries = 0;
  function walk(directory: string): void {
    for (const name of readdirSync(directory)) {
      if (++entries > 100_000) fail('git_metadata_limit');
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail('shared_git_metadata');
      if (stat.isDirectory()) walk(path);
    }
  }
  walk(git);
  const configPath = join(git, 'config');
  if (lstatSync(configPath).size > 64 * 1024) fail('git_config');
  const config = readFileSync(configPath, 'utf8');
  const urls = [...config.matchAll(/^\s*url\s*=\s*(.*?)\s*$/gm)].map(match => match[1]);
  if (urls.length !== 1 || urls[0] !== cleanUrl || /(?:extraheader|credential|askpass|insteadof|pushurl|\[include|https?:\/\/[^\s/]*@)/i.test(config)) fail('git_config');
}

export interface EngineeringCloneReceipt {
  taskId: string; repositoryId: number; installationId: number; baseCommit: string;
  kind: 'acquisition_started' | 'acquisition_verified' | 'acquisition_failed'; snapshotHash: string;
}

export async function acquireEngineeringRepository(input: {
  taskId: string; resolution: EngineeringRepositoryResolution; base: { branch: string; commit: string };
  /** Fresh verifier reuses the host-observed immutable base even if the default
   * branch advances while the author works. Never selected by model input. */
  pinnedCommit?: true;
  workspaceRoot: string; deadlineMs: number; git: EngineeringRepositoryGitRunner;
  getCredential(repo: string): Promise<EngineeringAppCredential>;
  assertOwner(): void; append(receipt: Readonly<EngineeringCloneReceipt>): void;
}): Promise<Readonly<{ workspaceRoot: string; baseCommit: string; repository: ResolvedEngineeringRepository }>> {
  input = { ...input, base: Object.freeze({ ...input.base }) };
  const options = bindings.get(input.resolution);
  if (!options) fail('untrusted_resolution');
  const now = options.now ?? Date.now;
  const guard = () => { input.assertOwner(); if (now() >= input.deadlineMs) fail('deadline'); };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(input.taskId) || !isSafeGitBranch(input.base.branch) || !SHA.test(input.base.commit)
      || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs > now() + 10 * 60_000) fail('acquisition');
  guard();
  const refresh = async () => {
    const value = await resolveCurrentEngineeringRepository(input.resolution.repository.repo, input.resolution.repository.authority, options);
    guard(); if (!sameAccess(input.resolution, value)) fail('repository_authority_changed'); return value;
  };
  const current = await refresh();
  const root = input.workspaceRoot;
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(dirname(root)) !== dirname(root) || existsSync(root)) fail('workspace');
  const cleanUrl = `https://github.com/${current.repository.repo}.git`;
  const record = (kind: EngineeringCloneReceipt['kind']) => input.append(Object.freeze({ taskId: input.taskId,
    repositoryId: current.repository.repositoryId, installationId: current.repository.installationId,
    baseCommit: input.base.commit, kind, snapshotHash: current.snapshotHash }));
  record('acquisition_started'); guard();
  mkdirSync(root, { mode: 0o700 }); // Exclusive: never erase/reuse another task's workspace.
  const run = async (args: readonly string[], authorization?: string) => {
    guard(); const result = await input.git.run({ cwd: root, args, deadlineMs: input.deadlineMs }, authorization); guard(); return result;
  };
  try {
    await run(['init', '--quiet', '--template=', '.']);
    await run(['config', '--local', 'core.hooksPath', '/dev/null']);
    await run(['remote', 'add', 'origin', cleanUrl]);
    const auth = credential(await input.getCredential(current.repository.repo), options.binding, now());
    if (auth.permissions.contents !== current.repository.contents || auth.permissions.pullRequests !== current.repository.pullRequests) fail('credential_permissions_changed');
    await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin',
      input.pinnedCommit ? input.base.commit : `refs/heads/${input.base.branch}`],
      `Authorization: Basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`);
    if ((await run(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim() !== input.base.commit) fail('base_changed');
    await run(['checkout', '--quiet', '--detach', input.base.commit, '--']);
    if ((await run(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim() !== input.base.commit) fail('base_changed');
    assertStandaloneEngineeringClone(root, cleanUrl);
    await refresh(); record('acquisition_verified');
    return Object.freeze({ workspaceRoot: root, baseCommit: input.base.commit, repository: current.repository });
  } catch {
    // Preserve the new task-owned partial clone for explicit guarded cleanup.
    // Raw Git, API and credential errors never enter receipts or caller output.
    try { record('acquisition_failed'); } catch { /* Original failure remains fail-closed. */ }
    return fail('acquisition_failed');
  }
}
