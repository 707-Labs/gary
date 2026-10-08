import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitMust, pushBranch } from '../src/git.ts';

const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
const BRANCH = 'gary/approved-change';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gary-push-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, 'local'), remote = join(root, 'origin.git'), bin = join(root, 'bin');
  const callsPath = join(root, 'git-calls.jsonl'); mkdirSync(bin);
  const realGit = Bun.which('git'); if (!realGit) throw new Error('local git executable required');
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
  const run = (args: string[], cwd = local) => gitMust(args, { cwd, env });
  await gitMust(['init', '--bare', '-b', 'main', remote], { env });
  await gitMust(['init', '-b', BRANCH, local], { env });
  await run(['config', 'core.hooksPath', '/dev/null']);
  await run(['config', 'user.name', 'Offline Fixture']);
  await run(['config', 'user.email', 'fixture@example.invalid']);
  await run(['config', 'commit.gpgsign', 'false']);
  const commit = async (contents: string) => {
    writeFileSync(join(local, 'result.txt'), contents + '\n');
    await run(['add', 'result.txt']); await run(['commit', '-m', contents]);
    return (await run(['rev-parse', 'HEAD'])).stdout.trim();
  };
  const base = await commit('baseline');
  const approved = await commit('reviewed and checked');
  const moved = await commit('later unreviewed branch tip');
  await run(['push', remote, `${base}:refs/heads/${BRANCH}`]);
  await run(['reset', '--hard', approved]);

  // Only this push invocation sees the wrapper. All child Git calls use the
  // resolved real executable, isolated config, and file-only protocol.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.GARY_PUSH_CALLS, JSON.stringify(args) + '\\n');
function real(argv, cwd = process.cwd()) {
  const result = spawnSync(process.env.GARY_PUSH_REAL_GIT, argv, { cwd, env: process.env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
const result = real(args);
if (args[0] === 'ls-remote' && result.status === 0) {
  if (process.env.GARY_PUSH_MOVE_LOCAL) {
    const move = real(['update-ref', 'refs/heads/' + process.env.GARY_PUSH_BRANCH, process.env.GARY_PUSH_MOVE_LOCAL]);
    if (move.status !== 0) { process.stderr.write(move.stderr); process.exit(move.status ?? 1); }
  }
  if (process.env.GARY_PUSH_MOVE_REMOTE) {
    const move = real(['push', process.env.GARY_PUSH_REMOTE, process.env.GARY_PUSH_MOVE_REMOTE + ':refs/heads/' + process.env.GARY_PUSH_BRANCH]);
    if (move.status !== 0) { process.stderr.write(move.stderr); process.exit(move.status ?? 1); }
  }
}
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const args = { worktreePath: local, freshTokenUrl: remote, branch: BRANCH,
    env: { ...env, PATH: `${bin}:${process.env.PATH ?? ''}`, GARY_PUSH_REAL_GIT: realGit,
      GARY_PUSH_CALLS: callsPath, GARY_PUSH_BRANCH: BRANCH, GARY_PUSH_REMOTE: remote },
    deadlineMs: Date.now() + 15_000 };
  const calls = (): string[][] => existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const remoteHead = async () => (await run(['rev-parse', `refs/heads/${BRANCH}`], remote)).stdout.trim();
  return { local, remote, base, approved, moved, args, calls, remoteHead, run };
}

test('pushes the approved immutable commit when the local branch moves after remote lookup', async () => {
  const f = await fixture();
  const args = { ...f.args, sourceCommit: f.approved, env: { ...f.args.env, GARY_PUSH_MOVE_LOCAL: f.moved } };
  await pushBranch(args);
  expect((await f.run(['rev-parse', BRANCH])).stdout.trim()).toBe(f.moved);
  expect(await f.remoteHead()).toBe(f.approved);
  expect((await f.run(['show', `${BRANCH}:result.txt`], f.remote)).stdout).toBe('reviewed and checked\n');
  expect(f.calls()).toEqual([
    ['ls-remote', f.remote, `refs/heads/${BRANCH}`],
    ['push', f.remote, `${f.approved}:refs/heads/${BRANCH}`, `--force-with-lease=${BRANCH}:${f.base}`],
  ]);
});

test('immutable source still rejects a changed remote branch through the explicit lease', async () => {
  const f = await fixture();
  const args = { ...f.args, sourceCommit: f.approved, env: { ...f.args.env, GARY_PUSH_MOVE_REMOTE: f.moved } };
  await expect(pushBranch(args)).rejects.toThrow('stale info');
  expect(await f.remoteHead()).toBe(f.moved);
  expect(f.calls().at(-1)).toEqual(['push', f.remote, `${f.approved}:refs/heads/${BRANCH}`, `--force-with-lease=${BRANCH}:${f.base}`]);
});

test('malformed source commits reject before every Git command', async () => {
  const f = await fixture();
  const invalid: unknown[] = ['', 'HEAD', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), ` ${f.approved}`,
    `${f.approved}\n`, `${f.approved}^`, `${f.approved}:refs/heads/other`, '--all', null, 7, [f.approved]];
  for (const sourceCommit of invalid) {
    const args = { ...f.args, sourceCommit } as unknown as Parameters<typeof pushBranch>[0];
    await expect(pushBranch(args)).rejects.toThrow();
    expect(f.calls()).toEqual([]);
  }
  expect(await f.remoteHead()).toBe(f.base);
});

test('omitting sourceCommit retains the legacy branch refspec and current branch tip', async () => {
  const f = await fixture();
  const args = { ...f.args, env: { ...f.args.env, GARY_PUSH_MOVE_LOCAL: f.moved } };
  await pushBranch(args);
  expect(await f.remoteHead()).toBe(f.moved);
  expect(f.calls()).toEqual([
    ['ls-remote', f.remote, `refs/heads/${BRANCH}`],
    ['push', f.remote, `${BRANCH}:${BRANCH}`, `--force-with-lease=${BRANCH}:${f.base}`],
  ]);
});

test('immutable source creates a previously absent branch using an empty explicit lease', async () => {
  const f = await fixture();
  await f.run(['update-ref', '-d', `refs/heads/${BRANCH}`], f.remote);
  await pushBranch({ ...f.args, sourceCommit: f.approved });
  expect(await f.remoteHead()).toBe(f.approved);
  expect(f.calls().at(-1)).toEqual(['push', f.remote, `${f.approved}:refs/heads/${BRANCH}`, `--force-with-lease=${BRANCH}:`]);
});
