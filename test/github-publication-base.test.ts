import { expect, mock, test } from 'bun:test';
import { makeGitHubClient } from '../src/adapters/github.ts';

for (const mode of ['exact', 'moved', 'missing'] as const) test('GitHub adapter preserves ' + mode + ' observed PR base without substituting the requested one', async () => {
  const client = makeGitHubClient({ kind: 'pat', token: 'offline-fixture-only', username: 'fixture' });
  // Replace the entire instance transport: Octokit's lazy method getter cannot leak a real request.
  const requested = { ref: 'codex/prerequisite', sha: 'b'.repeat(40) };
  const observed = mode === 'moved' ? { ref: requested.ref, sha: 'c'.repeat(40) } : requested;
  const create = mock(async () => ({ data: {
    number: 42, html_url: 'https://github.invalid/fixture/repo/pull/42', state: 'open', draft: true,
    head: { sha: 'a'.repeat(40) }, created_at: '2026-10-08T00:00:00Z', ...(mode === 'missing' ? {} : { base: observed }),
  } }));
  const fakeApi = { pulls: { create } };
  Object.defineProperty(client, 'api', { value: fakeApi });
  expect((client as unknown as { api: unknown }).api).toBe(fakeApi);
  {
    const pr = await client.openPullRequest({ owner: 'fixture', repo: 'repo', head: 'task', base: requested.ref,
      title: 'Offline fixture', body: 'Offline fixture', draft: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(pr.baseRef).toBe(mode === 'missing' ? undefined : observed.ref);
    expect(pr.baseSha).toBe(mode === 'missing' ? undefined : observed.sha);
    expect(pr.number).toBe(42); expect(pr.headSha).toBe('a'.repeat(40));
  }
});
