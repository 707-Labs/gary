import { describe, expect, test } from 'bun:test';
import { isGitHubEngineeringToken, makeGitHubClient, readGitHubEngineeringInstallationCredential } from '../../src/adapters/github.ts';
import type { GitHubEngineeringInstallationApi } from '../../src/adapters/github.ts';
import { createEngineeringGitHubRepositoryServices } from '../../src/hermes/engineering-repository.ts';

const token = 'synthetic_app_installation_token_123456789';
const binding = { appId: 77, installationId: 88 };
const now = () => 100_000;
const metadata = () => ({ id: 88, app_id: 77, suspended_at: null, account: { login: '707-Labs' }, permissions: { contents: 'write', pull_requests: 'write' } });
const issuance = () => ({ token, expires_at: new Date(200_000).toISOString(), permissions: { contents: 'write', pull_requests: 'write' } });
function setup() {
  const calls: Array<{ method: string; installation_id: number }> = [];
  const api: GitHubEngineeringInstallationApi = {
    async getInstallation(args) { calls.push({ method: 'observe', ...args }); return { data: metadata() }; },
    async createInstallationAccessToken(args) { calls.push({ method: 'issue', ...args }); return { data: issuance() }; },
  };
  return { api, calls };
}

describe('App-only engineering credential issuance', () => {
  test('accepts bounded bearer punctuation without accepting header injection or malformed padding', async () => {
    const bearer = 'synthetic.Header-part_payload+data/~==';
    const s = setup(); s.api.createInstallationAccessToken = async () => ({ data: { ...issuance(), token: bearer } });
    const services = createEngineeringGitHubRepositoryServices({ client: {
      engineeringInstallationCredential: () => readGitHubEngineeringInstallationCredential(s.api, binding, now),
    }, binding, fetch: (async () => { throw new Error('no network'); }) as unknown as typeof fetch, now });
    expect((await services.getCredential('707-Labs/synthetic')).token).toBe(bearer);
    for (const invalid of [bearer + '\r\nInjected: value', bearer + '\n', bearer + '\r', bearer + '\r\n', bearer + '\u2028', bearer + '\u2029', bearer + ' ', 'synthetic=embedded_padding_value', 'unicode_é'.repeat(4), 'a'.repeat(4097), 'short'])
      expect(isGitHubEngineeringToken(invalid)).toBe(false);
  });
  test('reads authenticated installation metadata then forces fresh issuance on every call', async () => {
    const s = setup();
    const result = await readGitHubEngineeringInstallationCredential(s.api, binding, now);
    expect(result).toEqual({ kind: 'app', ...binding, accountLogin: '707-Labs', token, issuedAtMs: 100_000, expiresAtMs: 200_000,
      permissions: { contents: 'write', pullRequests: 'write' } });
    expect(Object.isFrozen(result.permissions)).toBe(true);
    await readGitHubEngineeringInstallationCredential(s.api, binding, now);
    expect(s.calls.map(call => call.method)).toEqual(['observe', 'issue', 'observe', 'issue']);
    expect(s.calls.every(call => call.installation_id === 88)).toBe(true);
  });

  test('suspended, wrong-App, wrong-installation and missing account evidence never mint tokens', async () => {
    for (const patch of [{ id: 99 }, { app_id: 99 }, { suspended_at: new Date().toISOString() }, { account: null }, { permissions: null }]) {
      const s = setup();
      s.api.getInstallation = async () => ({ data: { ...metadata(), ...patch } });
      await expect(readGitHubEngineeringInstallationCredential(s.api, binding, now)).rejects.toThrow(/^github_engineering_installation_unavailable$/);
      expect(s.calls).toHaveLength(0);
    }
  });

  test('changed permissions, expired tokens and raw API errors remain fixed failures', async () => {
    for (const patch of [{ expires_at: new Date(99_000).toISOString() }, { token: '' }, { permissions: { contents: 'read', pull_requests: 'write' } }, { permissions: { contents: 'write', pull_requests: 'admin' } }]) {
      const s = setup(); s.api.createInstallationAccessToken = async () => ({ data: { ...issuance(), ...patch } });
      await expect(readGitHubEngineeringInstallationCredential(s.api, binding, now)).rejects.toThrow(/^github_engineering_installation_unavailable$/);
    }
    const s = setup(); s.api.getInstallation = async () => { throw new Error(token); };
    await expect(readGitHubEngineeringInstallationCredential(s.api, binding, now)).rejects.toThrow(/^github_engineering_installation_unavailable$/);
  });

  test('production factory rejects PAT clients and composes the existing App-only seam', async () => {
    const fetcher = (async () => Response.json({ total_count: 0, repositories: [] })) as unknown as typeof fetch;
    expect(() => createEngineeringGitHubRepositoryServices({ client: {}, binding, fetch: fetcher, now })).toThrow('github_app_required');
    expect(makeGitHubClient({ kind: 'pat', token: 'synthetic_pat_only', username: 'fixture' }).engineeringInstallationCredential).toBeUndefined();
    const s = setup();
    const services = createEngineeringGitHubRepositoryServices({ client: {
      engineeringInstallationCredential: () => readGitHubEngineeringInstallationCredential(s.api, binding, now),
    }, binding, fetch: fetcher, now });
    expect((await services.observer.installation()).accountLogin).toBe('707-Labs');
    expect((await services.observer.repositories(1)).repositories).toHaveLength(0);
    expect((await services.getCredential('707-Labs/synthetic')).token).toBe(token);
    expect(s.calls.filter(call => call.method === 'issue')).toHaveLength(3);
  });

  test('production factory rejects an observed installation account outside 707-Labs', async () => {
    const s = setup(); s.api.getInstallation = async () => ({ data: { ...metadata(), account: { login: 'other-org' } } });
    const fetcher = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    const services = createEngineeringGitHubRepositoryServices({ client: {
      engineeringInstallationCredential: () => readGitHubEngineeringInstallationCredential(s.api, binding, now),
    }, binding, fetch: fetcher, now });
    await expect(services.observer.repositories(1)).rejects.toThrow('credential_unavailable');
  });
});
