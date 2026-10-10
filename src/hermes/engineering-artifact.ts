import { createHash, randomUUID } from 'node:crypto';
import {
  constants, closeSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const ENGINEERING_ARTIFACT_LIMITS = Object.freeze({ files: 128, bytes: 128 * 1024 });

export type EngineeringArtifactFile = Readonly<{
  path: string; kind: 'file'; mode: 0o644 | 0o755; base64: string; sha256: string;
}> | Readonly<{
  path: string; kind: 'deleted'; mode: null; base64: null; sha256: null;
}>;

export interface EngineeringArtifactCapture {
  readonly files: readonly EngineeringArtifactFile[];
  readonly hash: string;
}

interface Root { path: string; stat: Stats }
interface Parent { path: string; stat: Stats }
interface Leaf { path: string; parents: Parent[]; stat: Stats | null }
interface CaptureBinding { paths: readonly string[]; sourceIdentity: string }
const captures = new WeakMap<object, CaptureBinding>();
const usedVerifiers = new Set<string>();

function fail(reason: string): never { throw new Error(`engineering_artifact:${reason}`); }
function sha(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function identity(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
function uid(): number {
  if (!process.getuid) fail('unsupported_host');
  return process.getuid();
}
function sameNode(a: Stats, b: Stats): boolean {
  return identity(a) === identity(b) && a.uid === b.uid && a.mode === b.mode;
}
function sameFile(a: Stats, b: Stats): boolean {
  return sameNode(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function statIfPresent(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function directory(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o022) !== 0) fail('unsafe_directory');
  return stat;
}
function regular(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid()
      || (stat.mode & 0o7022) !== 0) fail('unsafe_file');
}
function rootDirectory(path: string): Root {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail('unsafe_root');
  return { path, stat: directory(path) };
}
function checkRoot(root: Root): void {
  if (realpathSync(root.path) !== root.path || !sameNode(root.stat, directory(root.path))) fail('root_changed');
}
function allowedPaths(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths) || !paths.length || paths.length > ENGINEERING_ARTIFACT_LIMITS.files) fail('file_count');
  const seen = new Set<string>();
  const result = paths.map(path => {
    if (typeof path !== 'string' || path.length > 512 || !/^[A-Za-z0-9_./-]+$/.test(path) || isAbsolute(path)) fail('unsafe_path');
    const parts = path.split('/');
    for (const part of parts) {
      if (!part || part === '.' || part === '..' || part.endsWith('.') || part.length > 255
          || /^(?:\.git|\.git-credentials|\.gitconfig|git~\d|\.hg|\.svn|\.beads|\.aws|\.ssh|\.gnupg|\.azure|\.gcloud|\.kube|\.npmrc|\.pypirc|\.netrc|\.docker|\.env.*)$/i.test(part)
          || /^(?:secrets?|credentials?)(?:\..*)?$/i.test(part)
          || /^(?:id_rsa|id_ed25519)(?:\..*)?$/i.test(part)) fail('unsafe_path');
    }
    const folded = path.toLowerCase();
    if (seen.has(folded)) fail('duplicate_path');
    seen.add(folded);
    return path;
  }).sort();
  for (const path of result) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      if (seen.has(parent.toLowerCase())) fail('path_collision');
    }
  }
  return Object.freeze(result);
}
function inspectLeaf(root: Root, path: string): Leaf {
  checkRoot(root);
  const parts = path.split('/');
  const parents: Parent[] = [{ path: root.path, stat: root.stat }];
  let current = root.path;
  for (const component of parts.slice(0, -1)) {
    current = join(current, component);
    const stat = statIfPresent(current);
    if (!stat) return { path: join(root.path, path), parents, stat: null };
    const checked = directory(current);
    if (!sameNode(stat, checked) || realpathSync(current) !== current) fail('parent_changed');
    parents.push({ path: current, stat: checked });
  }
  const absolute = join(root.path, path);
  const stat = statIfPresent(absolute);
  if (stat) {
    regular(stat);
    if (realpathSync(absolute) !== absolute) fail('unsafe_file');
  }
  return { path: absolute, parents, stat };
}
function checkParents(root: Root, leaf: Leaf): void {
  checkRoot(root);
  for (const parent of leaf.parents) {
    if (!sameNode(parent.stat, directory(parent.path)) || realpathSync(parent.path) !== parent.path) fail('parent_changed');
  }
}
function checkLeaf(root: Root, leaf: Leaf): void {
  checkParents(root, leaf);
  const current = inspectLeaf(root, leaf.path.slice(root.path.length + 1)).stat;
  if (leaf.stat === null ? current !== null : current === null || !sameFile(leaf.stat, current)) fail('file_changed');
}
function readRegular(root: Root, leaf: Leaf, maximum: number): Buffer {
  if (!leaf.stat) fail('missing_file');
  regular(leaf.stat);
  if (leaf.stat.size > maximum) fail('byte_limit');
  const descriptor = openSync(leaf.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    regular(before);
    if (!sameFile(leaf.stat, before)) fail('file_changed');
    // An extra byte detects growth without ever allocating an unbounded buffer.
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, count);
      if (read === 0) break;
      count += read;
    }
    if (count !== before.size || !sameFile(before, fstatSync(descriptor))) fail('file_changed');
    checkLeaf(root, leaf);
    return bytes.subarray(0, count);
  } finally { closeSync(descriptor); }
}
function captureHash(files: readonly EngineeringArtifactFile[]): string {
  return sha(JSON.stringify({ version: 1, files }));
}

/** Read only explicit paths, never primary Git metadata. The caller MUST first
 * prove all primary containers/processes/writers absent and keep them absent.
 * Node's path APIs do not provide an openat-based concurrent-writer boundary.
 * Keep the returned object host-private; JSON deserialization loses provenance. */
export function captureEngineeringArtifactFiles(rootPath: string, allowedFiles: readonly string[]): EngineeringArtifactCapture {
  const paths = allowedPaths(allowedFiles);
  const root = rootDirectory(rootPath);
  let total = 0;
  const files = paths.map(path => {
    const leaf = inspectLeaf(root, path);
    if (!leaf.stat) {
      checkLeaf(root, leaf);
      return Object.freeze({ path, kind: 'deleted' as const, mode: null, base64: null, sha256: null });
    }
    const bytes = readRegular(root, leaf, ENGINEERING_ARTIFACT_LIMITS.bytes - total);
    total += bytes.length;
    return Object.freeze({ path, kind: 'file' as const, mode: (leaf.stat.mode & 0o111 ? 0o755 : 0o644) as 0o644 | 0o755,
      base64: bytes.toString('base64'), sha256: sha(bytes) });
  });
  checkRoot(root);
  const capture = Object.freeze({ files: Object.freeze(files), hash: captureHash(files) });
  captures.set(capture, { paths, sourceIdentity: identity(root.stat) });
  return capture;
}

function validateCapture(capture: EngineeringArtifactCapture, allowedFiles: readonly string[]): CaptureBinding {
  const paths = allowedPaths(allowedFiles);
  const binding = capture && typeof capture === 'object' ? captures.get(capture) : undefined;
  if (!binding || !Object.isFrozen(capture) || !Object.isFrozen(capture.files)) fail('capture_provenance');
  if (JSON.stringify(paths) !== JSON.stringify(binding.paths)) fail('file_scope');
  if (capture.hash !== captureHash(capture.files) || capture.files.length !== paths.length) fail('capture_hash');
  let total = 0;
  for (const [index, file] of capture.files.entries()) {
    if (!Object.isFrozen(file) || file.path !== paths[index]) fail('capture_hash');
    if (file.kind === 'deleted') {
      if (file.mode !== null || file.base64 !== null || file.sha256 !== null) fail('capture_hash');
      continue;
    }
    if (file.kind !== 'file' || ![0o644, 0o755].includes(file.mode)) fail('capture_hash');
    const bytes = Buffer.from(file.base64, 'base64');
    total += bytes.length;
    if (bytes.toString('base64') !== file.base64 || sha(bytes) !== file.sha256 || total > ENGINEERING_ARTIFACT_LIMITS.bytes) fail('capture_hash');
  }
  return binding;
}

/** Defense in depth only: the caller's host repository adapter must separately
 * attest that this is a NEW independently fetched, pinned-base clone with no
 * model access. A directory's current shape cannot prove its acquisition history. */
function checkVerifierMetadata(root: Root): void {
  const git = join(root.path, '.git');
  directory(git);
  for (const path of ['commondir', 'gitdir', 'worktrees', 'modules', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if (statIfPresent(join(git, path))) fail('shared_git_metadata');
  }
  let entries = 0;
  function walk(parent: string): void {
    for (const name of readdirSync(parent)) {
      if (++entries > 100_000) fail('git_metadata_limit');
      const path = join(parent, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { directory(path); walk(path); }
      else regular(stat);
    }
  }
  walk(git);
  const config = readRegular(root, inspectLeaf(root, '.git/config'), 64 * 1024).toString('utf8');
  let section = '';
  let urls = 0;
  for (const line of config.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#') || text.startsWith(';')) continue;
    if (text === '[core]') { section = 'core'; continue; }
    if (text === '[remote "origin"]') { section = 'origin'; continue; }
    const match = /^([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(text);
    if (!match) fail('git_config');
    // Git variable names are case-insensitive; values retain exact validation.
    const key = match[1]!.toLowerCase(), value = match[2]!;
    if (section === 'core' && ((key === 'repositoryformatversion' && value === '0')
      || (key === 'bare' && value === 'false')
      || (key === 'hookspath' && value === '/dev/null')
      || (['filemode', 'logallrefupdates', 'ignorecase', 'precomposeunicode'].includes(key!) && /^(true|false)$/.test(value!)))) continue;
    if (section === 'origin' && key === 'url' && /^https:\/\/github\.com\/707-Labs\/[A-Za-z0-9_.-]+\.git$/.test(value!)) { urls++; continue; }
    if (section === 'origin' && key === 'fetch' && value === '+refs/heads/*:refs/remotes/origin/*') continue;
    fail('git_config');
  }
  if (urls !== 1) fail('git_config');
  checkRoot(root);
}

function makeParents(root: Root, path: string): void {
  let current = root.path;
  for (const component of path.split('/').slice(0, -1)) {
    checkRoot(root);
    current = join(current, component);
    if (!statIfPresent(current)) mkdirSync(current, { mode: 0o700 });
    directory(current);
    if (realpathSync(current) !== current) fail('parent_changed');
  }
}

/** Import only a host-captured object into a fresh verifier after acquisition.
 * There must be no model or concurrent writer access to this root. All paths
 * are preflighted before mutation. Each file replacement is atomic; the batch
 * is not. On failure preserve/discard the isolated verifier, never retry it. */
export function applyEngineeringArtifactFiles(
  verifierRoot: string, capture: EngineeringArtifactCapture, allowedFiles: readonly string[],
): EngineeringArtifactCapture {
  const binding = validateCapture(capture, allowedFiles);
  const root = rootDirectory(verifierRoot);
  const verifierIdentity = identity(root.stat);
  if (verifierIdentity === binding.sourceIdentity || usedVerifiers.has(verifierIdentity)) fail('verifier_reuse');
  checkVerifierMetadata(root);
  const preflight = binding.paths.map(path => inspectLeaf(root, path));
  for (const leaf of preflight) checkLeaf(root, leaf);
  // Also fence failed partial imports: a fresh independently acquired root is required.
  usedVerifiers.add(verifierIdentity);
  for (const [index, file] of capture.files.entries()) {
    const original = preflight[index]!;
    checkLeaf(root, original);
    if (file.kind === 'deleted') {
      if (original.stat) unlinkSync(original.path);
      continue;
    }
    makeParents(root, file.path);
    const leaf = inspectLeaf(root, file.path);
    if (original.stat ? !leaf.stat || !sameFile(original.stat, leaf.stat) : leaf.stat !== null) fail('file_changed');
    const temporary = join(dirname(leaf.path), `.gary-artifact-${randomUUID()}`);
    let temporaryStat: Stats | undefined;
    let renamed = false;
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      temporaryStat = fstatSync(descriptor);
      regular(temporaryStat);
      const bytes = Buffer.from(file.base64, 'base64');
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(descriptor, bytes, written, bytes.length - written);
        if (count <= 0) fail('write_failed');
        written += count;
      }
      fchmodSync(descriptor, file.mode);
      fsyncSync(descriptor);
      temporaryStat = fstatSync(descriptor);
      regular(temporaryStat);
      checkLeaf(root, leaf);
      if (!sameFile(temporaryStat, lstatSync(temporary))) fail('file_changed');
      renameSync(temporary, leaf.path);
      renamed = true;
    } finally {
      closeSync(descriptor);
      if (!renamed && temporaryStat) {
        const current = statIfPresent(temporary);
        if (current && sameNode(current, temporaryStat)) unlinkSync(temporary);
      }
    }
  }
  return verifyEngineeringArtifactFiles(verifierRoot, capture, allowedFiles);
}

/** Recheck exact bytes/deletions and Git executable modes after host checks and
 * independent review. Hash equality does not assert that those checks passed. */
export function verifyEngineeringArtifactFiles(
  root: string, capture: EngineeringArtifactCapture, allowedFiles: readonly string[],
): EngineeringArtifactCapture {
  validateCapture(capture, allowedFiles);
  const current = captureEngineeringArtifactFiles(root, allowedFiles);
  if (current.hash !== capture.hash) fail('artifact_changed');
  return current;
}
