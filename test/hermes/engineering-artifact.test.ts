import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyEngineeringArtifactFiles, captureEngineeringArtifactFiles,
  ENGINEERING_ARTIFACT_LIMITS, verifyEngineeringArtifactFiles,
  type EngineeringArtifactCapture,
} from '../../src/hermes/engineering-artifact.ts';
import { createEngineeringHostGitRunner } from '../../src/hermes/engineering-repository.ts';

const temporary: string[] = [];
function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'gary-artifact-test-')));
  temporary.push(value);
  return value;
}
function file(directory: string, path: string, content: string | Buffer, mode = 0o644): void {
  const absolute = join(directory, path);
  mkdirSync(join(absolute, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, content, { mode });
  chmodSync(absolute, mode);
}
const cleanConfig = '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nhooksPath = /dev/null\n[remote "origin"]\nurl = https://github.com/707-Labs/example.git\nfetch = +refs/heads/*:refs/remotes/origin/*\n';
function verifier(): string {
  const value = root();
  file(value, '.git/config', cleanConfig);
  file(value, '.git/HEAD', '0123456789abcdef0123456789abcdef01234567\n');
  mkdirSync(join(value, '.git/objects'), { mode: 0o700 });
  return value;
}
afterEach(() => { for (const value of temporary.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('host engineering artifact transfer', () => {
  test('imports into real Git metadata produced by the host clone setup with hooks disabled', async () => {
    const source = root(); file(source, 'a.ts', 'verified source\n');
    const capture = captureEngineeringArtifactFiles(source, ['a.ts']);
    const target = root(), git = createEngineeringHostGitRunner({ gitBinary: '/usr/bin/git' });
    const deadlineMs = Date.now() + 10_000;
    // These are the production acquisition's local setup commands. No fetch,
    // credentials, external repository, or model access is needed for this check.
    for (const args of [['init', '--quiet', '--template=', '.'], ['config', '--local', 'core.hooksPath', '/dev/null'],
      ['remote', 'add', 'origin', 'https://github.com/707-Labs/example.git']]) {
      await git.run({ cwd: target, args, deadlineMs });
    }
    const config = readFileSync(join(target, '.git/config'), 'utf8');
    expect(config).toMatch(/^\s*hooksPath = \/dev\/null$/m);
    expect(applyEngineeringArtifactFiles(target, capture, ['a.ts']).hash).toBe(capture.hash);
    expect(readFileSync(join(target, 'a.ts'), 'utf8')).toBe('verified source\n');
    expect(readFileSync(join(target, '.git/config'), 'utf8')).toBe(config);
    expect(() => verifyEngineeringArtifactFiles(target, capture, ['a.ts'])).not.toThrow();
  });

  test('transfers exact binary bytes, new nested files, executable mode, empty files and deletions', () => {
    const source = root();
    file(source, 'src/binary.bin', Buffer.from([0, 255, 13, 10]));
    file(source, 'test/run.sh', '#!/bin/sh\nexit 0\n', 0o755);
    file(source, 'test/empty.ts', '');
    const scope = ['test/run.sh', 'src/binary.bin', 'test/empty.ts', 'src/deleted.ts'];
    const captured = captureEngineeringArtifactFiles(source, scope);
    const target = verifier();
    file(target, 'src/deleted.ts', 'old source');
    file(target, 'unrelated.txt', 'preserved');
    const imported = applyEngineeringArtifactFiles(target, captured, [...scope].reverse());
    expect(imported.hash).toBe(captured.hash);
    expect(readFileSync(join(target, 'src/binary.bin'))).toEqual(Buffer.from([0, 255, 13, 10]));
    expect(lstatSync(join(target, 'test/run.sh')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(target, 'test/empty.ts')).size).toBe(0);
    expect(existsSync(join(target, 'src/deleted.ts'))).toBe(false);
    expect(readFileSync(join(target, 'unrelated.txt'), 'utf8')).toBe('preserved');
    expect(readFileSync(join(target, '.git/config'), 'utf8')).toBe(cleanConfig);
    expect(readdirSync(join(target, 'test')).sort()).toEqual(['empty.ts', 'run.sh']);
  });

  test('captures primary worktree bytes without trusting or even inspecting its malicious Git metadata', () => {
    const source = root();
    file(source, 'test/new.test.ts', 'real test');
    symlinkSync('/nonexistent-attacker-git', join(source, '.git'));
    const capture = captureEngineeringArtifactFiles(source, ['test/new.test.ts']);
    expect(Buffer.from(capture.files[0]!.base64!, 'base64').toString()).toBe('real test');
    expect(capture.files[0]!.kind).toBe('file');
  });

  test('stable hash includes exact scope, deletion and executable modes; read bits do not change Git artifact', () => {
    const source = root();
    file(source, 'a.ts', 'a');
    const first = captureEngineeringArtifactFiles(source, ['b.ts', 'a.ts']);
    expect(captureEngineeringArtifactFiles(source, ['a.ts', 'b.ts']).hash).toBe(first.hash);
    chmodSync(join(source, 'a.ts'), 0o600);
    expect(captureEngineeringArtifactFiles(source, ['a.ts', 'b.ts']).hash).toBe(first.hash);
    chmodSync(join(source, 'a.ts'), 0o700);
    expect(captureEngineeringArtifactFiles(source, ['a.ts', 'b.ts']).hash).not.toBe(first.hash);
    expect(captureEngineeringArtifactFiles(source, ['a.ts']).hash).not.toBe(first.hash);
    file(source, 'b.ts', '');
    expect(captureEngineeringArtifactFiles(source, ['a.ts', 'b.ts']).hash).not.toBe(first.hash);
  });

  test('freezes capture records, rejects forged or serialized captures, and binds exact original whitelist', () => {
    const source = root(); file(source, 'a.ts', 'a');
    const capture = captureEngineeringArtifactFiles(source, ['a.ts']);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.files)).toBe(true);
    expect(Object.isFrozen(capture.files[0])).toBe(true);
    expect(() => { (capture.files[0] as { base64: string }).base64 = 'b'; }).toThrow();
    const target = verifier();
    expect(() => applyEngineeringArtifactFiles(target, JSON.parse(JSON.stringify(capture)), ['a.ts'])).toThrow('capture_provenance');
    expect(() => applyEngineeringArtifactFiles(target, { ...capture }, ['a.ts'])).toThrow('capture_provenance');
    expect(() => applyEngineeringArtifactFiles(target, capture, ['a.ts', 'b.ts'])).toThrow('file_scope');
    expect(() => applyEngineeringArtifactFiles(target, capture, ['b.ts'])).toThrow('file_scope');
    expect(existsSync(join(target, 'a.ts'))).toBe(false);
  });

  test('rejects unsafe scope paths, aliases, path collisions and count overflow before any file is read', () => {
    const source = root();
    for (const path of ['../escape', '/absolute', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\nb', '.git/config',
      'src/.GIT/config', '.env', '.env.local', '.aws/config', '.ssh/id_rsa', 'secrets/token', 'credentials.json',
      'a./file', 'git~1/config', 'a/'.repeat(260), 'a:stream']) {
      expect(() => captureEngineeringArtifactFiles(source, [path])).toThrow('unsafe_path');
    }
    expect(() => captureEngineeringArtifactFiles(source, ['a.ts', 'A.ts'])).toThrow('duplicate_path');
    expect(() => captureEngineeringArtifactFiles(source, ['src', 'src/a.ts'])).toThrow('path_collision');
    expect(() => captureEngineeringArtifactFiles(source, [])).toThrow('file_count');
    expect(() => captureEngineeringArtifactFiles(source, Array.from({ length: 129 }, (_, i) => `f${i}`))).toThrow('file_count');
  });

  test('enforces total byte limit and accepts exactly the boundary without reading unrelated large files', () => {
    const source = root();
    file(source, 'a.ts', Buffer.alloc(ENGINEERING_ARTIFACT_LIMITS.bytes));
    file(source, 'huge.ignored', Buffer.alloc(ENGINEERING_ARTIFACT_LIMITS.bytes + 1));
    expect(captureEngineeringArtifactFiles(source, ['a.ts']).files).toHaveLength(1);
    expect(() => captureEngineeringArtifactFiles(source, ['huge.ignored'])).toThrow('byte_limit');
    file(source, 'b.ts', 'b');
    expect(() => captureEngineeringArtifactFiles(source, ['a.ts', 'b.ts'])).toThrow('byte_limit');
  });

  test('rejects root links, parent links, dangling leaves, hard links and directories as files', () => {
    const source = root(); const outside = root(); file(outside, 'outside.ts', 'unchanged');
    symlinkSync(source, join(outside, 'alias'));
    expect(() => captureEngineeringArtifactFiles(join(outside, 'alias'), ['a.ts'])).toThrow('unsafe_root');
    symlinkSync(outside, join(source, 'linked'));
    expect(() => captureEngineeringArtifactFiles(source, ['linked/outside.ts'])).toThrow('unsafe_directory');
    symlinkSync(join(outside, 'missing'), join(source, 'a.ts'));
    expect(() => captureEngineeringArtifactFiles(source, ['a.ts'])).toThrow('unsafe_file');
    rmSync(join(source, 'a.ts')); linkSync(join(outside, 'outside.ts'), join(source, 'a.ts'));
    expect(() => captureEngineeringArtifactFiles(source, ['a.ts'])).toThrow('unsafe_file');
    expect(() => captureEngineeringArtifactFiles(source, ['linked'])).toThrow('unsafe_file');
    mkdirSync(join(source, 'dir'));
    expect(() => captureEngineeringArtifactFiles(source, ['dir'])).toThrow('unsafe_file');
    expect(readFileSync(join(outside, 'outside.ts'), 'utf8')).toBe('unchanged');
  });

  test('rejects writable-by-others parents and files', () => {
    const source = root(); file(source, 'src/a.ts', 'a');
    chmodSync(join(source, 'src/a.ts'), 0o666);
    expect(() => captureEngineeringArtifactFiles(source, ['src/a.ts'])).toThrow('unsafe_file');
    chmodSync(join(source, 'src/a.ts'), 0o644); chmodSync(join(source, 'src'), 0o777);
    expect(() => captureEngineeringArtifactFiles(source, ['src/a.ts'])).toThrow('unsafe_directory');
  });

  test('preflights every destination before writing and never overwrites or deletes linked external data', () => {
    const source = root(); file(source, 'a.ts', 'new a'); file(source, 'z.ts', 'new z');
    const capture = captureEngineeringArtifactFiles(source, ['a.ts', 'z.ts']);
    const target = verifier(); const outside = root(); file(outside, 'outside.ts', 'external');
    file(target, 'a.ts', 'old a'); symlinkSync(join(outside, 'outside.ts'), join(target, 'z.ts'));
    expect(() => applyEngineeringArtifactFiles(target, capture, ['a.ts', 'z.ts'])).toThrow('unsafe_file');
    expect(readFileSync(join(target, 'a.ts'), 'utf8')).toBe('old a');
    expect(readFileSync(join(outside, 'outside.ts'), 'utf8')).toBe('external');
    const deleted = captureEngineeringArtifactFiles(source, ['delete.ts']);
    symlinkSync(join(outside, 'outside.ts'), join(target, 'delete.ts'));
    expect(() => applyEngineeringArtifactFiles(target, deleted, ['delete.ts'])).toThrow('unsafe_file');
    expect(readFileSync(join(outside, 'outside.ts'), 'utf8')).toBe('external');
  });

  test('rejects destination parent links and hard-linked regular files', () => {
    const source = root(); file(source, 'src/a.ts', 'new');
    const capture = captureEngineeringArtifactFiles(source, ['src/a.ts']);
    const target = verifier(); const outside = root(); file(outside, 'a.ts', 'external');
    symlinkSync(outside, join(target, 'src'));
    expect(() => applyEngineeringArtifactFiles(target, capture, ['src/a.ts'])).toThrow('unsafe_directory');
    rmSync(join(target, 'src')); mkdirSync(join(target, 'src'));
    linkSync(join(outside, 'a.ts'), join(target, 'src/a.ts'));
    expect(() => applyEngineeringArtifactFiles(target, capture, ['src/a.ts'])).toThrow('unsafe_file');
    expect(readFileSync(join(outside, 'a.ts'), 'utf8')).toBe('external');
  });

  test('rejects replay into the primary or a previously imported verifier root', () => {
    const source = root(); file(source, 'a.ts', 'a');
    const capture = captureEngineeringArtifactFiles(source, ['a.ts']);
    expect(() => applyEngineeringArtifactFiles(source, capture, ['a.ts'])).toThrow('verifier_reuse');
    const target = verifier(); applyEngineeringArtifactFiles(target, capture, ['a.ts']);
    expect(() => applyEngineeringArtifactFiles(target, capture, ['a.ts'])).toThrow('verifier_reuse');
    expect(verifyEngineeringArtifactFiles(target, capture, ['a.ts']).hash).toBe(capture.hash);
  });

  test('requires standalone Git metadata and rejects external/common object stores and metadata links', () => {
    const source = root(); file(source, 'a.ts', 'a');
    const capture = captureEngineeringArtifactFiles(source, ['a.ts']);
    const target = verifier();
    file(target, '.git/objects/info/alternates', '/external/objects');
    expect(() => applyEngineeringArtifactFiles(target, capture, ['a.ts'])).toThrow('shared_git_metadata');
    rmSync(join(target, '.git/objects/info/alternates'));
    file(target, '.git/commondir', '/external');
    expect(() => applyEngineeringArtifactFiles(target, capture, ['a.ts'])).toThrow('shared_git_metadata');
    rmSync(join(target, '.git/commondir'));
    symlinkSync('/nonexistent', join(target, '.git/index'));
    expect(() => applyEngineeringArtifactFiles(target, capture, ['a.ts'])).toThrow('unsafe_file');
    expect(existsSync(join(target, 'a.ts'))).toBe(false);
  });

  test('rejects credential or command-bearing Git configs rather than trusting clean-looking remote URL alone', () => {
    const source = root(); file(source, 'a.ts', 'a');
    const capture = captureEngineeringArtifactFiles(source, ['a.ts']);
    for (const suffix of ['[core]\nworktree = /outside', '[include]\npath = /external', '[core]\nhooksPath = /external',
      '[core]\nHOOKSPATH = /external', '[core]\nhooksPath = /dev/null/hooks', '[core]\nhooksPath = /dev/./null',
      '[core]\nhooksPath = "/dev/null"', '[core]\nhooksPath =', '[remote "origin"]\nhooksPath = /dev/null',
      '[core]\nsshCommand = arbitrary-command',
      '[filter "hostile"]\nsmudge = arbitrary-command', '[credential]\nhelper = arbitrary-command',
      '[http]\nextraheader = secret', '[remote "origin"]\nurl = https://github.com/707-Labs/another.git']) {
      const target = verifier(); file(target, '.git/config', `${cleanConfig}${suffix}\n`);
      expect(() => applyEngineeringArtifactFiles(target, capture, ['a.ts'])).toThrow('git_config');
      expect(existsSync(join(target, 'a.ts'))).toBe(false);
    }
  });

  test('verification rejects byte changes, deletion reversal, or executable mode changes after checks', () => {
    const source = root(); file(source, 'a.ts', 'a');
    const scope = ['a.ts', 'gone.ts'];
    const capture = captureEngineeringArtifactFiles(source, scope);
    const target = verifier(); applyEngineeringArtifactFiles(target, capture, scope);
    file(target, 'a.ts', 'b');
    expect(() => verifyEngineeringArtifactFiles(target, capture, scope)).toThrow('artifact_changed');
    file(target, 'a.ts', 'a'); chmodSync(join(target, 'a.ts'), 0o755);
    expect(() => verifyEngineeringArtifactFiles(target, capture, scope)).toThrow('artifact_changed');
    chmodSync(join(target, 'a.ts'), 0o644); file(target, 'gone.ts', '');
    expect(() => verifyEngineeringArtifactFiles(target, capture, scope)).toThrow('artifact_changed');
  });

  test('cannot manufacture provenance by casting or supplying a recomputed hash', () => {
    const target = verifier();
    const forged = Object.freeze({ files: Object.freeze([{ path: 'a.ts', kind: 'file', mode: 0o644,
      base64: 'YQ==', sha256: 'a'.repeat(64) }]), hash: 'b'.repeat(64) }) as EngineeringArtifactCapture;
    expect(() => applyEngineeringArtifactFiles(target, forged, ['a.ts'])).toThrow('capture_provenance');
    expect(() => verifyEngineeringArtifactFiles(target, forged, ['a.ts'])).toThrow('capture_provenance');
  });
});
