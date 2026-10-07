import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createReadonlyChildExecutor, type ReadonlyChildCommandRunner, type ReadonlyChildOptions } from '../../src/hermes/readonly-child.ts';
import type { ExecResult } from '../../src/executors/index.ts';

const imageDigest = `sha256:${'1'.repeat(64)}`;
const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0, timedOut: false });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function workspace(base = tmpdir()): Promise<string> {
  const path = realpathSync(await mkdtemp(join(base, 'gary-hermes-child-test-')));
  directories.push(path);
  await chmod(path, 0o755);
  return path;
}
function options(root: string): ReadonlyChildOptions {
  return { workspaceRoot: root, imageDigest, parentDepth: 0,
    admission: { taskId: 'task-1', requestId: 'req-1', ticketId: 'ticket-1', actionId: 'action-1',
      fingerprint: 'fingerprint-1', ownerEpoch: 'epoch-1', deadlineMs: Date.now() + 60_000 },
    assertActive() {},
  };
}
type Call = { executable: string; args: string[]; options: Parameters<ReadonlyChildCommandRunner>[2] };
function fakeRunner(run?: (call: Call) => Promise<ExecResult>) {
  const calls: Call[] = [];
  const runner: ReadonlyChildCommandRunner = async (executable, args, options) => {
    const call = { executable, args, options }; calls.push(call);
    if (args[0] === 'image') return ok(JSON.stringify({ Id: imageDigest, Volumes: null }));
    if (args[1] === 'rm') return ok(args[3]);
    return run ? run(call) : ok();
  };
  return { calls, runner };
}
function valueAfter(call: Call, key: string): string | undefined { return call.args[call.args.indexOf(key) + 1]; }

describe('read-only Hermes child', () => {
  it('fixes filesystem/network/resource boundaries and erases inherited environment', async () => {
    const root = await workspace();
    const fake = fakeRunner(async () => ok('found'));
    const parent = options(root);
    const handle = await createReadonlyChildExecutor({ ...parent, dockerHost: 'unix:///Users/tanner/.colima/default/docker.sock', runCommand: fake.runner });
    try {
      expect(handle.depth).toBe(1);
      expect(handle.admission).toEqual(parent.admission);
      expect(handle.admission).not.toBe(parent.admission);
      expect(Object.isFrozen(handle.admission)).toBe(true);
      expect(await handle.executor.readFile('hello.txt')).toBe('found');
      const run = fake.calls.find(call => call.args[1] === 'run')!;
      expect(valueAfter(run, '--network')).toBe('none');
      expect(run.args).toContain('--read-only');
      expect(valueAfter(run, '--user')).toBe('65532:65532');
      expect(valueAfter(run, '--cap-drop')).toBe('ALL');
      expect(valueAfter(run, '--security-opt')).toBe('no-new-privileges=true');
      expect(valueAfter(run, '--pull')).toBe('never');
      expect(valueAfter(run, '--restart')).toBe('no');
      expect(valueAfter(run, '--memory')).toBe('2g');
      expect(valueAfter(run, '--memory-swap')).toBe('2g');
      expect(valueAfter(run, '--mount')).toBe(`type=bind,src=${root},dst=/workspace,readonly,bind-recursive=disabled`);
      expect(run.args.filter(arg => arg === '--mount')).toHaveLength(1);
      expect(run.args.join(' ')).not.toContain('docker.sock');
      expect(run.args.join(' ')).not.toContain('bun-cache');
      expect(valueAfter(run, '--entrypoint')).toBe('/usr/bin/env');
      expect(run.args.slice(run.args.indexOf(imageDigest) + 1, -3)).toEqual(['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'CI=1', 'LANG=C.UTF-8']);
      expect(run.options.env).toEqual({ PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', DOCKER_HOST: 'unix:///Users/tanner/.colima/default/docker.sock', DOCKER_CONFIG: '/var/empty/gary-hermes-no-docker-config' });
      expect(run.options.deadlineMs).toBe(parent.admission.deadlineMs);
      expect(fake.calls.at(-1)?.args).toEqual(['container', 'rm', '--force', valueAfter(run, '--name')!]);
      expect(fake.calls.at(-1)?.options.signal).toBeUndefined();
      expect(fake.calls.at(-1)?.options.timeoutMs).toBe(5000);
    } finally { await handle.close(); }
  });

  it('refuses nested children, tags, remote daemons and non-canonical mount punctuation before Docker', async () => {
    const root = await workspace();
    const fake = fakeRunner();
    for (const change of [ { parentDepth: 1 }, { imageDigest: 'gary:latest' },
      { dockerHost: 'tcp://localhost:2375' }, { dockerHost: 'unix:///tmp/../docker.sock' },
      { dockerExecutable: '/tmp/docker' }, { workspaceRoot: 'relative' } ]) {
      await expect(createReadonlyChildExecutor({ ...options(root), ...change, runCommand: fake.runner } as ReadonlyChildOptions)).rejects.toThrow();
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects an image identity mismatch or image-declared anonymous volume', async () => {
    const root = await workspace();
    for (const metadata of [ { Id: `sha256:${'2'.repeat(64)}`, Volumes: null }, { Id: imageDigest, Volumes: { '/workspace': {} } } ]) {
      const calls: string[][] = [];
      await expect(createReadonlyChildExecutor({ ...options(root), runCommand: async (_exe, args) => {
        calls.push(args); return ok(JSON.stringify(metadata));
      } })).rejects.toThrow('identity/anonymous volume');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe('image');
    }
  });

  it('rejects writeFile, path/cwd escapes and environment overrides without invoking a container', async () => {
    const fake = fakeRunner();
    const handle = await createReadonlyChildExecutor({ ...options(await workspace()), runCommand: fake.runner });
    try {
      await expect(handle.executor.writeFile('any', 'x')).rejects.toThrow('read-only');
      await expect(handle.executor.readFile('../outside')).rejects.toThrow('path denied');
      await expect(handle.executor.run('pwd', { cwd: '/tmp' })).rejects.toThrow('path denied');
      await expect(handle.executor.run('pwd', { env: { HOME: '/workspace' } })).rejects.toThrow('environment override');
      expect(fake.calls).toHaveLength(1);
    } finally { await handle.close(); }
  });

  it('starts a new container per operation and reuses the parent deadline', async () => {
    const fake = fakeRunner(async call => ok(call.args.includes('cat') ? 'hello\n' : call.args.includes('--files') ? 'z.ts\na.ts\n' : './a.ts:3:value\n'));
    const handle = await createReadonlyChildExecutor({ ...options(await workspace()), runCommand: fake.runner });
    try {
      expect(await handle.executor.readFile('hello')).toBe('hello\n');
      expect(await handle.executor.listFiles('**/*.ts')).toEqual(['a.ts', 'z.ts']);
      expect(await handle.executor.grep('value')).toEqual([{ path: 'a.ts', line: 3, text: 'value' }]);
      const runs = fake.calls.filter(call => call.args[1] === 'run');
      expect(new Set(runs.map(call => valueAfter(call, '--name'))).size).toBe(3);
      expect(runs.every(call => call.options.deadlineMs === handle.admission.deadlineMs)).toBe(true);
      expect(fake.calls.filter(call => call.args[1] === 'rm')).toHaveLength(3);
    } finally { await handle.close(); }
  });

  it('checks parent ownership after image inspection and before every command', async () => {
    const fake = fakeRunner();
    let active = true;
    const handle = await createReadonlyChildExecutor({ ...options(await workspace()),
      assertActive() { if (!active) throw new Error('parent revoked'); }, runCommand: fake.runner });
    try {
      active = false;
      await expect(handle.executor.run('whoami')).rejects.toThrow('parent revoked');
      expect(fake.calls).toHaveLength(1);
    } finally { await handle.close(); }
    const parent = options(await workspace());
    let checks = 0;
    await expect(createReadonlyChildExecutor({ ...parent, assertActive() { if (++checks > 1) throw new Error('parent revoked'); }, runCommand: fake.runner })).rejects.toThrow('parent revoked');
  });

  it('awaits exact-container cleanup before reporting an ownership loss', async () => {
    let active = true;
    const fake = fakeRunner(async () => { active = false; return ok('untrusted late result'); });
    const handle = await createReadonlyChildExecutor({ ...options(await workspace()),
      assertActive() { if (!active) throw new Error('parent revoked'); }, runCommand: fake.runner });
    try {
      await expect(handle.executor.run('sleep 1')).rejects.toThrow('parent revoked');
      expect(fake.calls.at(-1)?.args[1]).toBe('rm');
    } finally { await handle.close(); }
  });

  it('close aborts and waits for running command plus cleanup, then denies all operations', async () => {
    let launched!: () => void;
    const started = new Promise<void>(resolve => { launched = resolve; });
    const fake = fakeRunner(async call => {
      launched();
      await new Promise<void>(resolve => call.options.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { ...ok(), exitCode: 124, timedOut: true };
    });
    const handle = await createReadonlyChildExecutor({ ...options(await workspace()), runCommand: fake.runner });
    const run = handle.executor.run('sleep 30').then(() => null, error => error as Error);
    await started;
    const firstClose = handle.close();
    expect(handle.close()).toBe(firstClose);
    await firstClose;
    expect((await run)?.message).toContain('closed');
    expect(fake.calls.at(-1)?.args[1]).toBe('rm');
    await expect(handle.executor.run('echo late')).rejects.toThrow('closed');
  });

  it('cleanup failure fails the result, latches the executor and is surfaced by close', async () => {
    const fake = fakeRunner();
    const handle = await createReadonlyChildExecutor({ ...options(await workspace()), runCommand: async (exe, args, opts) => {
      if (args[1] === 'rm') return { ...ok(), exitCode: 1, stderr: 'daemon unavailable' };
      return fake.runner(exe, args, opts);
    } });
    await expect(handle.executor.run('true')).rejects.toThrow('cleanup failed');
    await expect(handle.executor.run('true')).rejects.toThrow('cleanup failed');
    await expect(handle.close()).rejects.toThrow('cleanup failed');
    expect(fake.calls.filter(call => call.args[1] === 'run')).toHaveLength(1);
  });

  it('cleans after a launch exception, allowing only an exact already-absent container response', async () => {
    const fake = fakeRunner();
    const handle = await createReadonlyChildExecutor({ ...options(await workspace()), runCommand: async (exe, args, opts) => {
      if (args[1] === 'run') throw new Error('launch failed');
      if (args[1] === 'rm') return { ...ok(), exitCode: 1, stderr: `Error response from daemon: No such container: ${args[3]}\n` };
      return fake.runner(exe, args, opts);
    } });
    try { await expect(handle.executor.run('true')).rejects.toThrow('launch failed'); }
    finally { await handle.close(); }
  });

  it('does not start Docker after the parent deadline or cancellation', async () => {
    const fake = fakeRunner();
    const parent = options(await workspace());
    await expect(createReadonlyChildExecutor({ ...parent,
      admission: { ...parent.admission, deadlineMs: Date.now() - 1 }, runCommand: fake.runner })).rejects.toThrow();
    await expect(createReadonlyChildExecutor({ ...parent, signal: AbortSignal.abort(), runCommand: fake.runner })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

// Opt-in disposable containment rehearsal: an existing local image only, no pull.
const dockerImage = process.env.GARY_READONLY_CHILD_TEST_IMAGE;
const dockerTest = dockerImage ? it : it.skip;
dockerTest('enforces shell/symlink read-only boundaries, no network/secrets, and cancellation cleanup in Docker', async () => {
  const root = await workspace(process.env.GARY_READONLY_CHILD_TEST_WORKSPACES);
  await writeFile(join(root, 'hello.txt'), 'readable\n', { mode: 0o644 });
  await symlink('/tmp', join(root, 'host-tmp-link'));
  const parent = options(root);
  parent.admission = { ...parent.admission, deadlineMs: Date.now() + 55_000 };
  const handle = await createReadonlyChildExecutor({ ...parent, imageDigest: dockerImage!,
    ...(process.env.GARY_READONLY_CHILD_TEST_DOCKER_HOST ? { dockerHost: process.env.GARY_READONLY_CHILD_TEST_DOCKER_HOST } : {}) });
  try {
    const ready = await handle.executor.run('printf ready');
    if (ready.exitCode !== 0) throw new Error(`container startup failed: ${ready.stderr}`);
    expect(await handle.executor.readFile('hello.txt')).toBe('readable\n');
    const denied = await handle.executor.run('LC_ALL=C touch /workspace/should-not-exist');
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toMatch(/read-only file system/i);
    const probe = await handle.executor.run(`set -eu
test "$(id -u)" = 65532
test ! -S /var/run/docker.sock
test -z "\${HOME_HOST_SECRET:-}"
test ! -e /Users/tanner/.gary
test ! -e /Users/tanner/.ssh
test "$(ls /sys/class/net)" = lo
printf scratch >/workspace/host-tmp-link/inside-container-only
test -f /tmp/inside-container-only
printf isolated`);
    expect(probe).toMatchObject({ exitCode: 0, stdout: 'isolated', timedOut: false });
    const next = await handle.executor.run('test ! -e /tmp/inside-container-only');
    expect(next.exitCode).toBe(0);
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('readable\n');
    const timedOut = await handle.executor.run('printf ready; sleep 30', { timeoutMs: 2_000 });
    expect(timedOut).toMatchObject({ stdout: 'ready', exitCode: 124, timedOut: true });
  } finally { await handle.close(); }
}, 60_000);
