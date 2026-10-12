import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants, closeSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync, mkdtempSync, rmSync, writeFileSync, opendirSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

/** Separate repository-scope limits; the original explicit-file API is unchanged. */
export const ENGINEERING_REPOSITORY_ARTIFACT_LIMITS = Object.freeze({
  files: 512, bytes: 2 * 1024 * 1024, inventoryEntries: 100_000,
  inventoryBytes: 512 * 1024 * 1024, ignoreBytes: 1024 * 1024, ignoreFiles: 1024,
});
export interface EngineeringRepositoryBaseline {
  readonly hash: string;
  readonly fileCount: number;
  readonly bytes: number;
}
type RepositoryEntry = Readonly<{ kind: 'directory' }> | Readonly<{
  kind: 'file'; size: number; mode: 0o644 | 0o755; sha256: string;
}>;
interface RepositoryInventory { entries: Map<string, RepositoryEntry>; bytes: number }
interface RepositoryBaselineBinding { root: Root; inventory: RepositoryInventory }
type IgnoreRule = Readonly<{ path: string; bytes: Buffer }>;
interface RepositoryCaptureBinding extends CaptureBinding {
  baseline: RepositoryInventory; expected: Map<string, RepositoryEntry>;
  verifierPath: string; verifierIdentity: string; ignores: readonly IgnoreRule[];
}
const repositoryBaselines = new WeakMap<object, RepositoryBaselineBinding>();
const repositoryCaptures = new WeakMap<object, RepositoryCaptureBinding>();
const protectedComponent = /^(?:\.git|\.git-credentials|\.gitconfig|git~\d|\.hg|\.svn|\.beads|\.aws|\.ssh|\.gnupg|\.azure|\.gcloud|\.kube|\.npmrc|\.pypirc|\.netrc|\.docker|\.env.*|(?:secrets?|credentials?)(?:\..*)?|(?:id_rsa|id_ed25519)(?:\..*)?)$/i;
function repositoryPath(path: string, permitProtected = false): boolean {
  if (typeof path !== 'string' || !path || path.length > 512 || /[\x00-\x1f\x7f-\x9f\\:]/.test(path)
      || isAbsolute(path) || path.normalize('NFC') !== path) fail('unsafe_path');
  let protectedPath = false;
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || part.endsWith('.') || part.trim() !== part || Buffer.byteLength(part) > 255) fail('unsafe_path');
    if (protectedComponent.test(part)) protectedPath = true;
  }
  if (protectedPath && !permitProtected) fail('protected_path');
  return protectedPath;
}
function repositoryPaths(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length > ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.files) fail('file_count');
  const paths = [...input].sort(), seen = new Set<string>();
  for (const path of paths) {
    repositoryPath(path);
    if (seen.has(path.toLowerCase())) fail('duplicate_path');
    seen.add(path.toLowerCase());
  }
  for (const path of paths) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
    if (seen.has(parent.toLowerCase())) fail('path_collision');
  }
  return Object.freeze(paths);
}
function entryEqual(a: RepositoryEntry | undefined, b: RepositoryEntry | undefined): boolean {
  return a?.kind === 'directory' ? b?.kind === 'directory'
    : a?.kind === 'file' && b?.kind === 'file' && a.size === b.size && a.mode === b.mode && a.sha256 === b.sha256;
}
function inventoryHash(entries: Map<string, RepositoryEntry>, filesOnly = false): string {
  return sha(JSON.stringify([...entries].filter(([, entry]) => !filesOnly || entry.kind === 'file').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
/** Stream baseline bytes instead of retaining a copy of the repository in RAM. */
function hashRepositoryFile(root: Root, leaf: Leaf, maximum: number): RepositoryEntry {
  if (!leaf.stat || leaf.stat.size > maximum) fail('inventory_byte_limit');
  regular(leaf.stat);
  const fd = openSync(leaf.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd); regular(before);
    if (!sameFile(leaf.stat, before)) fail('file_changed');
    const buffer = Buffer.alloc(64 * 1024), digest = createHash('sha256');
    let count = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - count + 1), count);
      if (!read) break;
      count += read;
      if (count > before.size) fail('file_changed');
      digest.update(buffer.subarray(0, read));
    }
    if (count !== before.size || !sameFile(before, fstatSync(fd))) fail('file_changed');
    checkLeaf(root, leaf);
    return Object.freeze({ kind: 'file', size: count, mode: before.mode & 0o111 ? 0o755 : 0o644, sha256: digest.digest('hex') });
  } finally { closeSync(fd); }
}
type IgnoreQuery = (paths: readonly string[]) => Set<string>;
function repositoryInventory(root: Root, baseline?: RepositoryInventory, ignored?: IgnoreQuery): RepositoryInventory {
  const entries = new Map<string, RepositoryEntry>(), aliases = new Set<string>();
  let bytes = 0, visited = 0;
  const pending = ['']; let cursor = 0;
  while (cursor < pending.length) {
    const relative = pending[cursor++]!, parent = join(root.path, relative);
    const parentStat = directory(parent);
    if (realpathSync(parent) !== parent) fail('parent_changed');
    const children: { path: string; stat: Stats }[] = [];
    const handle = opendirSync(parent);
    try {
      for (let child = handle.readSync(); child !== null; child = handle.readSync()) {
        if (relative === '' && child.name === '.git') continue;
        const path = relative ? `${relative}/${child.name}` : child.name;
        if (++visited > ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.inventoryEntries) fail('inventory_entry_limit');
        const protectedPath = repositoryPath(path, true);
        if (aliases.has(path.toLowerCase())) fail('duplicate_path');
        aliases.add(path.toLowerCase());
        if (path.split('/').length > 64) fail('inventory_depth_limit');
        if (baseline && protectedPath && !baseline.entries.has(path)) fail('protected_path_changed');
        children.push({ path, stat: lstatSync(join(root.path, path)) });
      }
    } finally { handle.closeSync(); }
    children.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // Only newly created paths may be ignored. Tracked baseline files remain
    // source even when the pristine base's ignore rules happen to match them.
    const candidates = children.filter(({ path }) => baseline && !baseline.entries.has(path))
      .map(({ path, stat }) => path + (stat.isDirectory() ? '/' : ''));
    const excluded = ignored && candidates.length ? ignored(candidates) : new Set<string>();
    for (const { path, stat } of children) {
      if (excluded.has(path + (stat.isDirectory() ? '/' : ''))) continue;
      if (stat.isDirectory()) {
        directory(join(root.path, path));
        entries.set(path, Object.freeze({ kind: 'directory' })); pending.push(path);
      } else {
        const entry = hashRepositoryFile(root, inspectLeaf(root, path), ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.inventoryBytes - bytes);
        if (entry.kind !== 'file') fail('inventory_invalid');
        bytes += entry.size; entries.set(path, entry);
      }
    }
    if (!sameNode(parentStat, directory(parent)) || realpathSync(parent) !== parent) fail('parent_changed');
    checkRoot(root);
  }
  return { entries, bytes };
}
function pristineIgnoreRules(root: Root, inventory: RepositoryInventory): readonly IgnoreRule[] {
  const rules: IgnoreRule[] = []; let bytes = 0;
  for (const [path, entry] of inventory.entries) {
    if (entry.kind !== 'file' || path.split('/').at(-1) !== '.gitignore') continue;
    if (rules.length >= ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.ignoreFiles) fail('ignore_limit');
    const raw = readRegular(root, inspectLeaf(root, path), ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.ignoreBytes - bytes);
    if (sha(raw) !== entry.sha256) fail('file_changed');
    bytes += raw.length; rules.push(Object.freeze({ path, bytes: raw }));
  }
  return Object.freeze(rules);
}
/** An ephemeral host-owned tree contains ONLY original verifier .gitignore
 * bytes. This preserves the base rules even when authored .gitignore changes
 * are imported. No author Git metadata or info/exclude is consulted. */
function withPristineIgnores<T>(rules: readonly IgnoreRule[], operation: (query: IgnoreQuery) => T): T {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'gary-repository-ignore-')));
  try {
    mkdirSync(join(path, '.git'), { mode: 0o700 });
    mkdirSync(join(path, '.git/objects'), { mode: 0o700 });
    mkdirSync(join(path, '.git/refs'), { mode: 0o700 });
    writeFileSync(join(path, '.git/HEAD'), 'ref: refs/heads/unused\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(path, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = /dev/null\n', { flag: 'wx', mode: 0o600 });
    for (const rule of rules) {
      mkdirSync(dirname(join(path, rule.path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(path, rule.path), rule.bytes, { flag: 'wx', mode: 0o400 });
    }
    let queries = 0;
    const deadline = Date.now() + 30_000;
    return operation(paths => {
      const matches = new Set<string>();
      for (let offset = 0; offset < paths.length; offset += 1024) {
        if (++queries > 512 || Date.now() >= deadline) fail('ignore_query_limit');
        const batch = paths.slice(offset, offset + 1024), requested = new Set(batch);
        const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
          '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null', '-c', 'credential.helper=',
          '-c', 'protocol.allow=never', 'check-ignore', '--no-index', '-z', '--stdin'], {
          cwd: path, shell: false, input: Buffer.from(batch.join('\0') + '\0'), encoding: 'buffer',
          env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false' },
          timeout: Math.min(5000, deadline - Date.now()), maxBuffer: 1024 * 1024,
        });
        // macOS's system Git wrapper can emit sandbox/cache warnings despite
        // a successful query. Exit status and the bounded NUL protocol decide
        // the result; raw stderr is never surfaced or treated as instructions.
        if (result.error || result.signal || ![0, 1].includes(result.status ?? -1)) fail('ignore_query_failed');
        const output = result.stdout.toString('utf8');
        if ((result.status === 0) !== !!output || output && !output.endsWith('\0')) fail('ignore_query_failed');
        for (const value of output ? output.slice(0, -1).split('\0') : []) {
          if (!requested.has(value)) fail('ignore_query_failed'); matches.add(value);
        }
      }
      return matches;
    });
  } finally { rmSync(path, { recursive: true, force: true }); }
}

/** Host MUST call before any dependency, sandbox or model command in the newly
 * acquired author clone. Source root .git is deliberately never inspected. */
export function captureEngineeringRepositoryBaseline(authorRoot: string): EngineeringRepositoryBaseline {
  const root = rootDirectory(authorRoot), inventory = repositoryInventory(root);
  const baseline = Object.freeze({ hash: inventoryHash(inventory.entries),
    fileCount: [...inventory.entries.values()].filter(entry => entry.kind === 'file').length, bytes: inventory.bytes });
  repositoryBaselines.set(baseline, { root, inventory });
  return baseline;
}

/** Host MUST first prove primary writers absent. The verifier must be a fresh
 * independently acquired clone at the same base, with no dependency/model access. */
export function captureEngineeringRepositoryChanges(authorRoot: string, baseline: EngineeringRepositoryBaseline,
  freshVerifierRoot: string): Readonly<{ capture: EngineeringArtifactCapture; paths: readonly string[] }> {
  const original = repositoryBaselines.get(baseline);
  if (!original || !Object.isFrozen(baseline) || original.root.path !== authorRoot) fail('baseline_provenance');
  checkRoot(original.root);
  const verifier = rootDirectory(freshVerifierRoot);
  if (identity(verifier.stat) === identity(original.root.stat) || usedVerifiers.has(identity(verifier.stat))) fail('verifier_reuse');
  checkVerifierMetadata(verifier);
  const pristine = repositoryInventory(verifier);
  if (inventoryHash(pristine.entries) !== baseline.hash) fail('baseline_mismatch');
  const ignores = pristineIgnoreRules(verifier, pristine);
  const current = withPristineIgnores(ignores, query => repositoryInventory(original.root, original.inventory, query));
  const changed: string[] = [];
  for (const path of new Set([...original.inventory.entries.keys(), ...current.entries.keys()])) {
    const before = original.inventory.entries.get(path), after = current.entries.get(path);
    if (entryEqual(before, after)) continue;
    if (repositoryPath(path, true)) fail('protected_path_changed');
    if (before?.kind === 'file' || after?.kind === 'file') {
      if (before?.kind === 'directory' || after?.kind === 'directory') fail('path_collision');
      changed.push(path);
    }
  }
  const paths = repositoryPaths(changed);
  let bytes = 0;
  const files = paths.map(path => {
    const leaf = inspectLeaf(original.root, path), entry = current.entries.get(path);
    if (!entry) {
      if (leaf.stat) fail('file_changed'); checkLeaf(original.root, leaf);
      return Object.freeze({ path, kind: 'deleted' as const, mode: null, base64: null, sha256: null });
    }
    if (entry.kind !== 'file') fail('path_collision');
    const raw = readRegular(original.root, leaf, ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.bytes - bytes);
    bytes += raw.length;
    if (sha(raw) !== entry.sha256 || (leaf.stat!.mode & 0o111 ? 0o755 : 0o644) !== entry.mode) fail('file_changed');
    return Object.freeze({ path, kind: 'file' as const, mode: entry.mode, base64: raw.toString('base64'), sha256: entry.sha256 });
  });
  checkRoot(original.root); checkRoot(verifier);
  const capture = Object.freeze({ files: Object.freeze(files), hash: captureHash(files) });
  repositoryCaptures.set(capture, { paths, sourceIdentity: identity(original.root.stat), baseline: pristine,
    expected: current.entries, verifierPath: freshVerifierRoot, verifierIdentity: identity(verifier.stat), ignores });
  return Object.freeze({ capture, paths });
}
function repositoryCapture(capture: EngineeringArtifactCapture, scope: readonly string[]): RepositoryCaptureBinding {
  const paths = repositoryPaths(scope), binding = repositoryCaptures.get(capture);
  if (!binding || !Object.isFrozen(capture) || !Object.isFrozen(capture.files)) fail('capture_provenance');
  if (JSON.stringify(paths) !== JSON.stringify(binding.paths)) fail('file_scope');
  if (capture.hash !== captureHash(capture.files)) fail('capture_hash');
  return binding;
}

/** Import once into the exact pristine verifier pinned during change capture.
 * A failed partial import consumes this verifier. Old scoped captures cannot
 * be promoted to this API or vice versa. */
export function applyEngineeringRepositoryArtifact(verifierRoot: string, capture: EngineeringArtifactCapture,
  paths: readonly string[]): EngineeringArtifactCapture {
  const binding = repositoryCapture(capture, paths), root = rootDirectory(verifierRoot);
  if (verifierRoot !== binding.verifierPath || identity(root.stat) !== binding.verifierIdentity
      || usedVerifiers.has(identity(root.stat))) fail('verifier_reuse');
  checkVerifierMetadata(root);
  if (inventoryHash(repositoryInventory(root).entries) !== inventoryHash(binding.baseline.entries)) fail('baseline_mismatch');
  const preflight = binding.paths.map(path => inspectLeaf(root, path));
  for (const leaf of preflight) checkLeaf(root, leaf);
  usedVerifiers.add(identity(root.stat));
  for (const [index, file] of capture.files.entries()) {
    const original = preflight[index]!; checkLeaf(root, original);
    if (file.kind === 'deleted') { if (original.stat) unlinkSync(original.path); continue; }
    makeParents(root, file.path);
    const leaf = inspectLeaf(root, file.path);
    if (original.stat ? !leaf.stat || !sameFile(original.stat, leaf.stat) : leaf.stat !== null) fail('file_changed');
    const temporary = join(dirname(leaf.path), `.gary-artifact-${randomUUID()}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let created: Stats | undefined, renamed = false;
    try {
      created = fstatSync(fd); regular(created);
      const bytes = Buffer.from(file.base64, 'base64');
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (count <= 0) fail('write_failed'); written += count;
      }
      fchmodSync(fd, file.mode); fsyncSync(fd); created = fstatSync(fd); regular(created);
      checkLeaf(root, leaf);
      if (!sameFile(created, lstatSync(temporary))) fail('file_changed');
      renameSync(temporary, leaf.path); renamed = true;
    } finally {
      closeSync(fd);
      if (!renamed && created) { const stat = statIfPresent(temporary); if (stat && sameNode(created, stat)) unlinkSync(temporary); }
    }
  }
  return verifyEngineeringRepositoryArtifact(verifierRoot, capture, paths);
}

/** Verify the complete non-generated source inventory, including unchanged and
 * protected files. New files created by tests cannot escape the exact artifact
 * by modifying .gitignore; only original base rules are used. */
export function verifyEngineeringRepositoryArtifact(verifierRoot: string, capture: EngineeringArtifactCapture,
  paths: readonly string[]): EngineeringArtifactCapture {
  const binding = repositoryCapture(capture, paths), root = rootDirectory(verifierRoot);
  if (verifierRoot !== binding.verifierPath || identity(root.stat) !== binding.verifierIdentity) fail('verifier_reuse');
  const current = withPristineIgnores(binding.ignores, query => repositoryInventory(root, binding.baseline, query));
  if (inventoryHash(current.entries, true) !== inventoryHash(binding.expected, true)) fail('artifact_changed');
  for (const [path, before] of binding.baseline.entries) {
    if (repositoryPath(path, true) && !entryEqual(before, current.entries.get(path))) fail('protected_path_changed');
  }
  return capture;
}
