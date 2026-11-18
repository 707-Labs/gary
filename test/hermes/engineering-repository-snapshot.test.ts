/** Offline fixtures only: local temporary Git repositories, no remotes or sandbox runtime. */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitRepositoryEvidenceRequest, gitRepositorySnapshotCommand } from '../../src/hermes/production-evidence.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gary-repository-snapshot-')); roots.push(root);
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: root, LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_PAGER: 'cat' };
  function git(args: string[], statuses = [0]) {
    const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.filemode=true', '-c', 'protocol.allow=never', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.signal || !statuses.includes(result.status!)) throw Error('fixture_git_failed: ' + result.stderr);
    return result.stdout;
  }
  function write(path: string, content: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
  }
  git(['init', '--quiet', '--template=', '.']);
  write('.gitignore', 'ignored/\n'); write('edit.ts', 'before\n'); write('delete.ts', 'delete me\n');
  write('mode.sh', '#!/bin/sh\nexit 0\n'); chmodSync(join(root, 'mode.sh'), 0o644);
  git(['add', '--', '.gitignore', 'edit.ts', 'delete.ts', 'mode.sh']); git(['commit', '--quiet', '-m', 'baseline']);
  const base = git(['rev-parse', '--verify', 'HEAD']).trim();
  function run(command: string, stdin?: string) {
    return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', command],
      { cwd: root, env, input: stdin, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  }
  function snapshot(paths: string[], commit = base) {
    const result = run(gitRepositorySnapshotCommand(commit, paths));
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    return JSON.parse(result.stdout) as { version: number; baseCommit: string; head: string; changedFiles: string[];
      workspaceDigest: string; taskDiffDigest: string | null; statusDigest: string };
  }
  function patch(path: string, isNew = false) {
    return isNew ? git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', '/dev/null', path], [0, 1])
      : git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', base, '--', path]);
  }
  return { root, env, base, git, write, run, snapshot, patch };
}

test('explicitly captured new ignored files remain evidence even when candidate ignore rules hide them', () => {
  const f = fixture();
  f.write('.gitignore', '*\n'); f.write('ignored/new.ts', 'captured ignored bytes\n');
  expect(f.git(['status', '--porcelain=v1', '--untracked-files=all'])).not.toContain('ignored/new.ts');
  const paths = ['ignored/new.ts', '.gitignore'], beforeIndex = readFileSync(join(f.root, '.git/index'));
  const result = f.snapshot(paths), sorted = [...paths].sort();
  const patches = sorted.map(path => ({ path, sha256: hash(f.patch(path, path === 'ignored/new.ts')) }));
  expect(result).toEqual({ version: 1, baseCommit: f.base, head: f.base, changedFiles: sorted,
    workspaceDigest: hash(JSON.stringify({ changedFiles: sorted, patches })),
    taskDiffDigest: hash(JSON.stringify({ changedFiles: sorted, patches })), statusDigest: hash(JSON.stringify(sorted)) });
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(beforeIndex);
  f.write('ignored/new.ts', 'different ignored bytes\n');
  expect(f.snapshot(paths).workspaceDigest).not.toBe(result.workspaceDigest);
});

test('dollar routes, bracket parameters, spaces and shell syntax remain literal manifest paths', () => {
  const f = fixture();
  const paths = ['routes/$slug.ts', 'routes/[id]/page with spaces.ts', "routes/owner's page.ts",
    'routes/$(touch INJECTED).ts', 'routes/`touch INJECTED_BACKTICK`.ts'];
  for (const path of paths) f.write(path, 'content for ' + path + '\n');
  const result = f.snapshot(paths);
  expect(result.changedFiles).toEqual([...paths].sort()); expect(result.taskDiffDigest).toBe(result.workspaceDigest);
  expect(existsSync(join(f.root, 'INJECTED'))).toBe(false); expect(existsSync(join(f.root, 'INJECTED_BACKTICK'))).toBe(false);
  // Literal Git pathspecs must not match this other path when the manifest names [id].
  f.write('routes/i/page with spaces.ts', 'not in this captured manifest\n');
  expect(f.snapshot(paths).workspaceDigest).toBe(result.workspaceDigest);
  f.write('routes/[id]/page with spaces.ts', 'changed literal parameter route\n');
  expect(f.snapshot(paths).workspaceDigest).not.toBe(result.workspaceDigest);
});

test('tracked edits, deletion and executable mode contribute exact independent patch hashes', () => {
  const f = fixture(); f.write('edit.ts', 'after\n'); unlinkSync(join(f.root, 'delete.ts')); chmodSync(join(f.root, 'mode.sh'), 0o755);
  const paths = ['mode.sh', 'edit.ts', 'delete.ts'], sorted = [...paths].sort();
  const patches = sorted.map(path => ({ path, sha256: hash(f.patch(path)) }));
  expect(f.patch('delete.ts')).toContain('deleted file mode');
  expect(f.patch('mode.sh')).toContain('old mode 100644\nnew mode 100755');
  const result = f.snapshot(paths);
  expect(result.changedFiles).toEqual(sorted);
  expect(result.workspaceDigest).toBe(hash(JSON.stringify({ changedFiles: sorted, patches })));
  expect(result.taskDiffDigest).toBe(result.workspaceDigest);
});

test('a valid base commit is insufficient when verifier HEAD advanced', () => {
  const f = fixture(); f.write('edit.ts', 'new upstream commit\n');
  f.git(['add', '--', 'edit.ts']); f.git(['commit', '--quiet', '-m', 'advanced']); f.write('edit.ts', 'candidate\n');
  const result = f.run(gitRepositorySnapshotCommand(f.base, ['edit.ts']));
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
  expect(result.stdout).toBe(''); expect(result.stderr).toBe('git_snapshot_failed\n');
});

test('manifest-listed missing or unchanged paths fail closed without partial evidence', () => {
  const f = fixture(); f.write('edit.ts', 'candidate\n');
  for (const paths of [['edit.ts', 'missing.ts'], ['edit.ts', 'delete.ts']]) {
    const result = f.run(gitRepositorySnapshotCommand(f.base, paths));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stdout).toBe(''); expect(result.stderr).toBe('git_snapshot_failed\n');
  }
});

test('invalid repository manifests are rejected before command construction', () => {
  for (const paths of [['../outside.ts'], ['/absolute.ts'], ['a//b'], ['a/./b'], ['a\\b'], ['a\nb'],
    ['same.ts', 'same.ts'], ['x'.repeat(1025)], Array.from({ length: 513 }, (_, index) => `${index}.ts`)]) {
    expect(() => gitRepositorySnapshotCommand('a'.repeat(40), paths)).toThrow('invalid_repository_manifest');
    expect(() => gitRepositoryEvidenceRequest('a'.repeat(40), paths)).toThrow('invalid_repository_manifest');
  }
  expect(() => gitRepositorySnapshotCommand('HEAD', ['safe.ts'])).toThrow('invalid_repository_manifest');
});

test('stdin snapshot matches legacy evidence and patch mode includes ignored files, deletion and modes', () => {
  const f = fixture(); f.write('edit.ts', 'after\n'); unlinkSync(join(f.root, 'delete.ts')); chmodSync(join(f.root, 'mode.sh'), 0o755);
  const newPaths = ['ignored/new.ts', "routes/$slug/[id]/owner's page.ts"];
  for (const path of newPaths) f.write(path, 'new captured bytes\n');
  const paths = [...newPaths, 'edit.ts', 'delete.ts', 'mode.sh'];
  const snapshot = gitRepositoryEvidenceRequest(f.base, paths), patch = gitRepositoryEvidenceRequest(f.base, paths, { patch: true });
  expect(Object.keys(snapshot).sort()).toEqual(['command', 'stdin']); expect(patch.stdin).toBe(snapshot.stdin);
  const evidenceResult = f.run(snapshot.command, snapshot.stdin), patchResult = f.run(patch.command, patch.stdin);
  expect(evidenceResult.status).toBe(0); expect(evidenceResult.stderr).toBe('');
  expect(JSON.parse(evidenceResult.stdout)).toEqual(f.snapshot(paths));
  expect(patchResult.status).toBe(0); expect(patchResult.stderr).toBe('');
  expect(patchResult.stdout).toBe([...paths].sort().map(path => f.patch(path, newPaths.includes(path))).join(''));
  for (const invalidPaths of [['missing.ts'], ['.gitignore']]) {
    for (const patchMode of [false, true]) {
      const request = gitRepositoryEvidenceRequest(f.base, invalidPaths, { patch: patchMode });
      const result = f.run(request.command, request.stdin);
      expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('git_snapshot_failed\n');
    }
  }
  f.git(['add', '--', 'edit.ts']); f.git(['commit', '--quiet', '-m', 'advance verifier']);
  for (const request of [snapshot, patch]) {
    const result = f.run(request.command, request.stdin);
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('git_snapshot_failed\n');
  }
});

test('a manifest above 40 KiB travels as stdin while the command stays fixed below 32 KiB', () => {
  const f = fixture(), directory = Array.from({ length: 4 }, (_, index) => `segment-${index}-` + 'x'.repeat(180)).join('/');
  const paths = Array.from({ length: 48 }, (_, index) => `${directory}/${index}-$route-[id]-${'y'.repeat(100)}.ts`);
  for (const path of paths) f.write(path, 'large manifest file\n');
  const request = gitRepositoryEvidenceRequest(f.base, paths);
  expect(Buffer.byteLength(request.stdin)).toBeGreaterThan(40 * 1024);
  expect(Buffer.byteLength(request.command)).toBeLessThan(32 * 1024);
  expect(request.command).toBe(gitRepositoryEvidenceRequest(f.base, ['edit.ts']).command);
  const result = f.run(request.command, request.stdin);
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  const evidence = JSON.parse(result.stdout);
  expect(evidence.changedFiles).toEqual([...paths].sort()); expect(evidence.taskDiffDigest).toBe(evidence.workspaceDigest);
  const oversized = Array.from({ length: 300 }, (_, index) => `${directory}/${index}-${'z'.repeat(150)}.ts`);
  expect(() => gitRepositoryEvidenceRequest(f.base, oversized)).toThrow('invalid_repository_manifest');
}, 20_000);
