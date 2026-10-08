import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerExecutor, type DockerExecutorOptions } from '../src/executors/docker.ts';
import { createWorkspaceExecutor } from '../src/executors/factory.ts';
import { HERMES_CODING_RUNTIME_POLICY } from '../src/hermes/coding-runtime-policy.ts';

const profile = HERMES_CODING_RUNTIME_POLICY.executor;
let workspace: string, binary: string, callsPath: string;
const envKeys = ['PATH', 'GARY_EXECUTOR', 'GARY_EXECUTOR_NETWORK', 'GARY_EXECUTOR_IMAGE', 'GARY_BUN_CACHE_VOLUME',
  'GARY_EXECUTOR_CPUS', 'GARY_EXECUTOR_MEMORY', 'GARY_EXECUTOR_PIDS_LIMIT', 'GARY_SENTINEL_SECRET'] as const;
let previous: Partial<Record<typeof envKeys[number], string | undefined>>;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gary-executor-profile-'));
  binary = join(workspace, 'docker'); callsPath = join(workspace, 'calls.jsonl');
  writeFileSync(callsPath, '');
  // Fake CLI only: record argv, never launch Docker or execute the supplied command.
  writeFileSync(binary, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst line=JSON.stringify(process.argv.slice(2));\nappendFileSync(${JSON.stringify(callsPath)},line+'\\n');\nconsole.log(line);\n`, { mode: 0o755 });
  previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.PATH = workspace + ':' + process.env.PATH;
  process.env.GARY_EXECUTOR = 'docker'; process.env.GARY_EXECUTOR_NETWORK = 'none';
  delete process.env.GARY_EXECUTOR_CPUS; delete process.env.GARY_EXECUTOR_MEMORY; delete process.env.GARY_EXECUTOR_PIDS_LIMIT;
  process.env.GARY_SENTINEL_SECRET = 'fake-host-secret-must-not-cross';
});
afterEach(() => {
  for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  rmSync(workspace, { recursive: true, force: true });
});
function calls(): string[][] { return readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function environment(args: string[]): Record<string, string> {
  return Object.fromEntries(args.flatMap((value, i) => value === '--env' ? [args[i + 1]!.split(/=(.*)/s).slice(0, 2)] : []));
}

test('fixed parent environment is snapshotted, used by every invocation and retains sandbox flags', async () => {
  const supplied: Record<string, string> = { ...profile.fixedEnvironment };
  const options: DockerExecutorOptions = { image: profile.image, bunCacheVolume: profile.bunCacheVolume,
    fixedEnvironment: supplied, storybookScratch: profile.storybookScratch, dockerBinary: binary };
  const executor = new DockerExecutor(workspace, options);
  delete options.storybookScratch;
  supplied.PUBLIC_PARTYKIT_HOST = 'mutated.invalid'; supplied.NEW_SECRET = 'fake-not-admitted';
  await executor.run('bun run ci:full');
  await executor.readFile('README.md');
  await executor.writeFile('fixture.txt', 'fake data');
  expect(calls()).toHaveLength(3);
  for (const args of calls()) {
    expect(environment(args)).toMatchObject(profile.fixedEnvironment);
    expect(environment(args).HOME).toBe('/tmp');
    expect(environment(args).BUN_INSTALL_CACHE_DIR).toBe('/tmp/bun-cache');
    expect(environment(args).GARY_SENTINEL_SECRET).toBeUndefined();
    expect(environment(args).NEW_SECRET).toBeUndefined();
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--read-only'); expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges'); expect(args).toContain('--pull=never');
    expect(args.flatMap((value, i) => value === '--tmpfs' ? [args[i + 1]] : [])).toEqual([
      `/tmp:rw,noexec,nosuid,nodev,size=1g,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000}`,
      `/workspace/storybook-static:rw,noexec,nosuid,nodev,size=512m,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000}`,
    ]);
    expect(args[args.indexOf('--memory') + 1]).toBe('12g');
    expect(args[args.indexOf('--user') + 1]).toBe(`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
    expect(args.flatMap((value, i) => value === '--mount' ? [args[i + 1]] : [])).toEqual([
      `type=bind,src=${workspace},dst=/workspace`,
      `type=volume,src=${profile.bunCacheVolume},dst=/bun-cache,readonly`,
    ]);
    expect(args).toContain(`type=volume,src=${profile.bunCacheVolume},dst=/bun-cache,readonly`);
    expect(args).toContain(profile.image);
  }
});

test('fixed-key conflicts reject before spawn without disclosing values; identical values emit once', async () => {
  const executor = new DockerExecutor(workspace, { image: profile.image, fixedEnvironment: profile.fixedEnvironment, dockerBinary: binary });
  await expect(executor.run('unused', { env: { TMPDIR: 'fake-sensitive-conflict' } })).rejects.toThrow('fixed_executor_environment_conflict');
  expect(calls()).toHaveLength(0);
  await executor.run('unused', { env: { TMPDIR: profile.fixedEnvironment.TMPDIR, EXTRA: 'explicit-host-option' } });
  const args = calls()[0]!;
  expect(args.filter(value => value === `TMPDIR=${profile.fixedEnvironment.TMPDIR}`)).toHaveLength(1);
  expect(environment(args).EXTRA).toBe('explicit-host-option');
});

test('factory uses the immutable profile even if ambient image/cache/resource values drift', async () => {
  process.env.GARY_EXECUTOR_IMAGE = 'unreviewed:tag'; process.env.GARY_BUN_CACHE_VOLUME = 'unreviewed-cache';
  for (const [cpus, memory, pids] of [['100', '100g', '100000'], ['1', '1g', '1'], ['invalid', 'invalid', 'invalid']]) {
    process.env.GARY_EXECUTOR_CPUS = cpus; process.env.GARY_EXECUTOR_MEMORY = memory; process.env.GARY_EXECUTOR_PIDS_LIMIT = pids;
    await createWorkspaceExecutor(workspace, { profile }).run('unused');
  }
  expect(calls()).toHaveLength(3);
  for (const args of calls()) {
    expect(args).toContain(profile.image);
    expect(args).toContain(`type=volume,src=${profile.bunCacheVolume},dst=/bun-cache,readonly`);
    expect(args).not.toContain('unreviewed:tag'); expect(args.join(' ')).not.toContain('unreviewed-cache');
    expect(environment(args)).toMatchObject(profile.fixedEnvironment);
    expect(args).toContain(`/workspace/storybook-static:rw,noexec,nosuid,nodev,size=512m,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000}`);
    expect(args[args.indexOf('--cpus') + 1]).toBe('4');
    expect(args[args.indexOf('--memory') + 1]).toBe('12g');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('512');
  }
});

test('profile cannot select local/networked/read-only execution or mutable images', () => {
  process.env.GARY_EXECUTOR = 'local';
  expect(() => createWorkspaceExecutor(workspace, { profile })).toThrow('fixed_executor_profile_requires_writable_offline_docker');
  process.env.GARY_EXECUTOR = 'docker';
  expect(() => createWorkspaceExecutor(workspace, { profile, readOnly: true })).toThrow('fixed_executor_profile_requires_writable_offline_docker');
  process.env.GARY_EXECUTOR_NETWORK = 'bridge';
  expect(() => createWorkspaceExecutor(workspace, { profile })).toThrow('invalid_fixed_executor_profile');
  process.env.GARY_EXECUTOR_NETWORK = 'none';
  expect(() => createWorkspaceExecutor(workspace, { profile: { ...profile, image: 'mutable:tag' } })).toThrow('invalid_fixed_executor_profile');
  expect(calls()).toHaveLength(0);
});

test('omitted profile preserves legacy factory selection and read-only behavior', async () => {
  process.env.GARY_EXECUTOR_IMAGE = 'legacy-fixture'; process.env.GARY_BUN_CACHE_VOLUME = 'legacy-cache';
  process.env.GARY_EXECUTOR_CPUS = '2'; process.env.GARY_EXECUTOR_MEMORY = '3g'; process.env.GARY_EXECUTOR_PIDS_LIMIT = '64';
  await createWorkspaceExecutor(workspace, { readOnly: true }).run('unused', { env: { EXPLICIT: 'legacy' } });
  const args = calls()[0]!;
  expect(args).toContain('legacy-fixture'); expect(args).toContain(`type=bind,src=${workspace},dst=/workspace,readonly`);
  expect(args).toContain('type=volume,src=legacy-cache,dst=/bun-cache,readonly');
  expect(environment(args).EXPLICIT).toBe('legacy'); expect(environment(args).TMPDIR).toBeUndefined();
  expect(environment(args).PUBLIC_PARTYKIT_HOST).toBeUndefined();
  expect(args.filter(value => value === '--tmpfs')).toHaveLength(1);
  expect(args.join(' ')).not.toContain('storybook-static');
  expect(args[args.indexOf('--cpus') + 1]).toBe('2');
  expect(args[args.indexOf('--memory') + 1]).toBe('3g');
  expect(args[args.indexOf('--pids-limit') + 1]).toBe('64');
});

test('scratch omission preserves a writable executor and cannot be selected through environment', async () => {
  await new DockerExecutor(workspace, { image: profile.image, dockerBinary: binary }).run('unused',
    { env: { GARY_STORYBOOK_SCRATCH: 'true' } });
  const args = calls()[0]!;
  expect(args.filter(value => value === '--tmpfs')).toHaveLength(1);
  expect(args.join(' ')).not.toContain('storybook-static');
});

test('fixed scratch opt-in rejects readonly, networked and non-literal constructor options before spawn', () => {
  for (const options of [
    { storybookScratch: true, readOnly: true },
    { storybookScratch: true, networkMode: 'bridge' },
    { storybookScratch: false },
    { storybookScratch: '/host/arbitrary-path' },
  ]) {
    expect(() => new DockerExecutor(workspace, { image: profile.image, dockerBinary: binary,
      ...options } as DockerExecutorOptions)).toThrow('invalid_storybook_scratch');
  }
  expect(() => createWorkspaceExecutor(workspace, { profile: { ...profile, storybookScratch: false as never } }))
    .toThrow('invalid_storybook_scratch');
  expect(calls()).toHaveLength(0);
});

test('malformed or reserved fixed environment fails without evaluating getters', () => {
  let read = false;
  const getter = Object.defineProperty({}, 'TMPDIR', { get() { read = true; return 'ignored'; }, enumerable: true });
  for (const fixedEnvironment of [getter, { HOME: '/host-home' }, { BAD: 'nul\0value' }, { 'invalid-name': 'value' }]) {
    expect(() => new DockerExecutor(workspace, { image: profile.image, fixedEnvironment, dockerBinary: binary })).toThrow('invalid_fixed_executor_environment');
  }
  expect(read).toBe(false); expect(calls()).toHaveLength(0);
});
