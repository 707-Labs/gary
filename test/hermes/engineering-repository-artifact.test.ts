import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyEngineeringArtifactFiles, applyEngineeringRepositoryArtifact, captureEngineeringArtifactFiles,
  captureEngineeringRepositoryBaseline, captureEngineeringRepositoryChanges,
  ENGINEERING_ARTIFACT_LIMITS, ENGINEERING_REPOSITORY_ARTIFACT_LIMITS,
  verifyEngineeringRepositoryArtifact,
} from '../../src/hermes/engineering-artifact.ts';

const roots: string[] = [];
function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'gary-repository-artifact-test-')));
  roots.push(value); return value;
}
function file(directory: string, path: string, value: string | Buffer, mode = 0o644): void {
  const target = join(directory, path);
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(target, value, { mode }); chmodSync(target, mode);
}
function pair(files: Record<string, string | Buffer> = {}) {
  const author = root(), verifier = root();
  for (const [path, value] of Object.entries(files)) { file(author, path, value); file(verifier, path, value); }
  // Synthetic, isolated metadata accepted by Git check-ignore; no Git init,
  // fetch, commit, credentials or external repository is involved in fixtures.
  file(verifier, '.git/config', '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nhooksPath = /dev/null\n[remote "origin"]\nurl = https://github.com/707-Labs/example.git\n');
  file(verifier, '.git/HEAD', 'ref: refs/heads/unused\n');
  mkdirSync(join(verifier, '.git/objects'), { mode: 0o700 });
  mkdirSync(join(verifier, '.git/refs'), { mode: 0o700 });
  const baseline = captureEngineeringRepositoryBaseline(author);
  return { author, verifier, baseline };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('repository-scope host artifact provenance', () => {
  test('transfers new routes, deletions, binary bytes and modes while a large unchanged baseline stays out of capture', () => {
    const { author, verifier, baseline } = pair({ 'large.dat': Buffer.alloc(3 * 1024 * 1024, 1), 'gone.ts': 'gone', 'run.sh': 'echo ok\n' });
    expect(baseline.bytes).toBeGreaterThan(ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.bytes);
    expect(baseline.fileCount).toBe(3);
    rmSync(join(author, 'gone.ts')); chmodSync(join(author, 'run.sh'), 0o755);
    const route = 'src/routes/$user/[id]/hello world.ts';
    file(author, route, Buffer.from([0, 255, 10]));
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    expect(paths).toEqual(['gone.ts', 'run.sh', route]);
    expect(capture.files.some(value => value.path === 'large.dat')).toBe(false);
    expect(applyEngineeringRepositoryArtifact(verifier, capture, paths)).toBe(capture);
    expect(readFileSync(join(verifier, route))).toEqual(Buffer.from([0, 255, 10]));
    expect(existsSync(join(verifier, 'gone.ts'))).toBe(false);
    expect(verifyEngineeringRepositoryArtifact(verifier, capture, paths)).toBe(capture);
  });

  test('only base ignore rules prune generated trees; edited ignores cannot hide new source', () => {
    const { author, verifier, baseline } = pair({ '.gitignore': 'node_modules/\n*.generated\n', 'tracked.generated': 'base' });
    file(author, '.gitignore', '*\n'); file(author, 'new source.ts', 'source');
    file(author, 'tracked.generated', 'tracked edit');
    file(author, 'cache.generated', 'generated');
    file(author, 'node_modules/pkg/.env', 'synthetic fixture');
    symlinkSync('/nonexistent', join(author, 'node_modules/ignored-link'));
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    expect(paths).toEqual(['.gitignore', 'new source.ts', 'tracked.generated']);
    applyEngineeringRepositoryArtifact(verifier, capture, paths);
    file(verifier, 'node_modules/pkg/generated.js', 'allowed generated output');
    expect(verifyEngineeringRepositoryArtifact(verifier, capture, paths)).toBe(capture);
    file(verifier, 'unexpected.ts', 'must not be hidden by authored *');
    expect(() => verifyEngineeringRepositoryArtifact(verifier, capture, paths)).toThrow('artifact_changed');
  });

  test('nested base ignore rules and negation apply without author Git config or info/exclude authority', () => {
    const { author, verifier, baseline } = pair({ 'src/.gitignore': '*.generated\n!keep.generated\n', 'source.ts': 'base' });
    file(author, 'src/drop.generated', 'generated'); file(author, 'src/keep.generated', 'source');
    file(verifier, '.git/info/exclude', '*\n');
    file(author, '.git/config', '[core]\nfsmonitor = malicious-command\n');
    file(author, '.git/info/exclude', '*\n');
    const { paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    expect(paths).toEqual(['src/keep.generated']);
  });

  test('author Git metadata can be replaced by a link and is never imported or followed', () => {
    const { author, verifier, baseline } = pair({ 'source.ts': 'base' });
    const outside = root(); file(outside, 'secret-marker', 'unchanged');
    symlinkSync(outside, join(author, '.git')); file(author, 'source.ts', 'edit');
    const config = readFileSync(join(verifier, '.git/config'));
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    applyEngineeringRepositoryArtifact(verifier, capture, paths);
    expect(readFileSync(join(verifier, '.git/config'))).toEqual(config);
    expect(readFileSync(join(outside, 'secret-marker'), 'utf8')).toBe('unchanged');
  });

  test('protected baseline edits/deletions and new secret paths fail even if base ignores them', () => {
    for (const mutation of ['edit', 'delete', 'new']) {
      const { author, verifier, baseline } = pair({ '.beads/state.json': '{}', '.gitignore': '.env*\n' });
      if (mutation === 'edit') file(author, '.beads/state.json', '{"changed":true}');
      else if (mutation === 'delete') rmSync(join(author, '.beads'), { recursive: true });
      else file(author, '.env.local', 'synthetic fixture');
      expect(() => captureEngineeringRepositoryChanges(author, baseline, verifier)).toThrow('protected_path_changed');
    }
  });

  test('rejects source symlinks and hardlinks without changing their targets', () => {
    for (const kind of ['symbolic', 'hard']) {
      const { author, verifier, baseline } = pair();
      const outside = root(); file(outside, 'external.ts', 'external');
      if (kind === 'symbolic') symlinkSync(join(outside, 'external.ts'), join(author, 'new.ts'));
      else linkSync(join(outside, 'external.ts'), join(author, 'new.ts'));
      expect(() => captureEngineeringRepositoryChanges(author, baseline, verifier)).toThrow('unsafe_file');
      expect(readFileSync(join(outside, 'external.ts'), 'utf8')).toBe('external');
    }
  });

  test('rejects forged baselines, root substitution and forged capture objects', () => {
    const { author, verifier, baseline } = pair({ 'a.ts': 'base' }); file(author, 'a.ts', 'edit');
    expect(() => captureEngineeringRepositoryChanges(author, { ...baseline }, verifier)).toThrow('baseline_provenance');
    expect(() => captureEngineeringRepositoryChanges(root(), baseline, verifier)).toThrow('baseline_provenance');
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    expect(Object.isFrozen(capture.files[0])).toBe(true);
    expect(() => applyEngineeringRepositoryArtifact(verifier, JSON.parse(JSON.stringify(capture)), paths)).toThrow('capture_provenance');
    expect(() => applyEngineeringRepositoryArtifact(verifier, capture, ['other.ts'])).toThrow('file_scope');
    expect(readFileSync(join(verifier, 'a.ts'), 'utf8')).toBe('base');
  });

  test('requires the same pristine baseline and exact verifier instance, and rejects replay', () => {
    const { author, verifier, baseline } = pair({ 'a.ts': 'base' }); file(author, 'a.ts', 'edit');
    const different = pair({ 'a.ts': 'different' });
    expect(() => captureEngineeringRepositoryChanges(author, baseline, different.verifier)).toThrow('baseline_mismatch');
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    const other = pair({ 'a.ts': 'base' });
    expect(() => applyEngineeringRepositoryArtifact(other.verifier, capture, paths)).toThrow('verifier_reuse');
    applyEngineeringRepositoryArtifact(verifier, capture, paths);
    expect(() => applyEngineeringRepositoryArtifact(verifier, capture, paths)).toThrow('verifier_reuse');
  });

  test('rejects verifier source mutation between capture and import before any writes', () => {
    const { author, verifier, baseline } = pair({ 'a.ts': 'base', 'z.ts': 'base' }); file(author, 'a.ts', 'edit');
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    file(verifier, 'z.ts', 'changed');
    expect(() => applyEngineeringRepositoryArtifact(verifier, capture, paths)).toThrow('baseline_mismatch');
    expect(readFileSync(join(verifier, 'a.ts'), 'utf8')).toBe('base');
  });

  test('verification checks unchanged source and protected files as well as selected edits', () => {
    const { author, verifier, baseline } = pair({ 'a.ts': 'base', 'unchanged.ts': 'base', '.beads/state': 'base' });
    file(author, 'a.ts', 'edit');
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    applyEngineeringRepositoryArtifact(verifier, capture, paths); file(verifier, 'unchanged.ts', 'changed by check');
    expect(() => verifyEngineeringRepositoryArtifact(verifier, capture, paths)).toThrow('artifact_changed');
    file(verifier, 'unchanged.ts', 'base'); file(verifier, '.beads/state', 'changed');
    expect(() => verifyEngineeringRepositoryArtifact(verifier, capture, paths)).toThrow();
  });

  test('allows literal shell punctuation through filesystem/stdin paths but rejects controls and backslashes', () => {
    const { author, verifier, baseline } = pair();
    const path = 'src/$(touch SHOULD_NOT_EXIST) [x].ts'; file(author, path, 'literal');
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    expect(paths).toEqual([path]); applyEngineeringRepositoryArtifact(verifier, capture, paths);
    expect(readFileSync(join(verifier, path), 'utf8')).toBe('literal');
    expect(existsSync(join(verifier, 'SHOULD_NOT_EXIST'))).toBe(false);
    for (const unsafe of ['back\\slash.ts', 'control\n.ts', 'trailing.']) {
      const fresh = pair(); file(fresh.author, unsafe, 'x');
      expect(() => captureEngineeringRepositoryChanges(fresh.author, fresh.baseline, fresh.verifier)).toThrow('unsafe_path');
    }
  });

  test('separate 512-file boundary does not widen the 128-file API or permit cross-API promotion', () => {
    const { author, verifier, baseline } = pair();
    for (let i = 0; i < 512; i++) file(author, `f${i}.ts`, 'x');
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    expect(paths).toHaveLength(512);
    expect(ENGINEERING_ARTIFACT_LIMITS).toEqual({ files: 128, bytes: 128 * 1024 });
    expect(() => captureEngineeringArtifactFiles(author, paths)).toThrow('file_count');
    expect(() => applyEngineeringArtifactFiles(verifier, capture, ['f0.ts'])).toThrow('capture_provenance');
    const legacy = captureEngineeringArtifactFiles(author, ['f0.ts']);
    expect(() => applyEngineeringRepositoryArtifact(verifier, legacy, ['f0.ts'])).toThrow('capture_provenance');
    file(author, 'extra.ts', 'x');
    expect(() => captureEngineeringRepositoryChanges(author, baseline, verifier)).toThrow('file_count');
  });

  test('enforces exactly 2 MiB changed bytes independently of the bounded streaming baseline', () => {
    const { author, verifier, baseline } = pair();
    file(author, 'large.bin', Buffer.alloc(ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.bytes));
    expect(captureEngineeringRepositoryChanges(author, baseline, verifier).paths).toEqual(['large.bin']);
    file(author, 'extra.ts', 'x');
    expect(() => captureEngineeringRepositoryChanges(author, baseline, verifier)).toThrow('byte_limit');
    const tooLarge = root(); file(tooLarge, 'sparse.bin', '');
    truncateSync(join(tooLarge, 'sparse.bin'), ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.inventoryBytes + 1);
    expect(() => captureEngineeringRepositoryBaseline(tooLarge)).toThrow('inventory_byte_limit');
  });

  test('no source changes produce an empty provenanced capture', () => {
    const { author, verifier, baseline } = pair({ 'a.ts': 'base' });
    const { capture, paths } = captureEngineeringRepositoryChanges(author, baseline, verifier);
    expect(paths).toEqual([]); expect(capture.files).toEqual([]);
    expect(applyEngineeringRepositoryArtifact(verifier, capture, paths)).toBe(capture);
  });
});
