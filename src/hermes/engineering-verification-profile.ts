/** Host-selected verification from an independently proven pristine clone.
 * This module only reads files. It neither runs scripts nor proves tool/cache
 * availability. Every returned command still needs the host's bounded, offline
 * sandbox. Repository scripts are untrusted code, never additional authority. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface EngineeringVerificationProfile {
  readonly version: 1;
  readonly kind: 'javascript_bun' | 'javascript_npm';
  readonly dependencyCommands: readonly string[];
  readonly requiredCommands: readonly string[];
  readonly hash: string;
}
export const ENGINEERING_VERIFICATION_PROFILE_LIMITS = Object.freeze({ packageBytes: 1024 * 1024, lockBytes: 16 * 1024 * 1024, scripts: 128, scriptBytes: 8192 });
const profiles = new WeakSet<object>();
const originalProfiles = new WeakSet<object>();
const baselineInputs = new WeakMap<object, Record<string, Buffer | null>>();
const locks = ['bun.lock', 'bun.lockb', 'package-lock.json'] as const;
const unsupportedLocks = ['pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json'] as const;
const inputs = ['package.json', ...locks, ...unsupportedLocks] as const;
function fail(reason: string): never { throw new Error('engineering_verification_profile:' + reason); }
function sha(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sameNode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && a.mode === b.mode && a.uid === b.uid;
}
function sameFile(a: Stats, b: Stats): boolean {
  return sameNode(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function optionalStat(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function regular(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o7022) !== 0) fail('unsafe_file');
}
function capture(workspaceRoot: string): Record<string, Buffer | null> {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot
      || realpathSync(workspaceRoot) !== workspaceRoot) fail('unsafe_root');
  const root = lstatSync(workspaceRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o022) !== 0) fail('unsafe_root');
  const snapshots = new Map<string, Stats | null>();
  const result: Record<string, Buffer | null> = {};
  for (const name of inputs) {
    const path = join(workspaceRoot, name), stat = optionalStat(path);
    snapshots.set(name, stat);
    if (!stat) { result[name] = null; continue; }
    regular(stat);
    const maximum = name === 'package.json' ? ENGINEERING_VERIFICATION_PROFILE_LIMITS.packageBytes : ENGINEERING_VERIFICATION_PROFILE_LIMITS.lockBytes;
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maximum) fail('file_size');
    if (realpathSync(path) !== path) fail('unsafe_file');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); regular(opened);
      if (!sameFile(stat, opened)) fail('file_changed');
      const raw = Buffer.alloc(opened.size + 1);
      let count = 0;
      while (count < raw.length) {
        const read = readSync(fd, raw, count, raw.length - count, count);
        if (!read) break;
        count += read;
      }
      if (count !== opened.size || !sameFile(opened, fstatSync(fd))) fail('file_changed');
      result[name] = raw.subarray(0, count);
    } finally { closeSync(fd); }
  }
  // Pin absent lock names too: a concurrent new lock must not change selection.
  for (const [name, before] of snapshots) {
    const after = optionalStat(join(workspaceRoot, name));
    if (before === null ? after !== null : after === null || !sameFile(before, after)) fail('file_changed');
  }
  if (realpathSync(workspaceRoot) !== workspaceRoot || !sameNode(root, lstatSync(workspaceRoot))) fail('root_changed');
  return result;
}
function derive(workspaceRoot: string, files = capture(workspaceRoot)): EngineeringVerificationProfile {
  const raw = files['package.json'];
  if (!raw) fail('unsupported_toolchain');
  let manifest: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    manifest = JSON.parse(text);
  } catch { return fail('invalid_package_json'); }
  if (!object(manifest)) fail('invalid_package_json');
  const scripts = manifest.scripts;
  if (!object(scripts) || Object.keys(scripts).length > ENGINEERING_VERIFICATION_PROFILE_LIMITS.scripts) fail('unsupported_verification');
  for (const [name, script] of Object.entries(scripts)) {
    if (!name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name) || typeof script !== 'string' || !script.trim()
        || Buffer.byteLength(script) > ENGINEERING_VERIFICATION_PROFILE_LIMITS.scriptBytes || /[\x00-\x1f\x7f]/.test(script)) fail('invalid_scripts');
  }
  let dependencies = false;
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = manifest[key];
    if (value === undefined) continue;
    if (!object(value) || Object.values(value).some(v => typeof v !== 'string' || !v.trim())) fail('invalid_dependencies');
    dependencies ||= Object.keys(value).length > 0;
  }
  if (manifest.workspaces !== undefined) dependencies = true;
  if (unsupportedLocks.some(name => files[name] !== null)) fail('unsupported_lockfile');
  const present = locks.filter(name => files[name] !== null);
  if (present.length > 1) fail('ambiguous_lockfile');
  if (!present.length && dependencies) fail('offline_dependencies_unavailable_missing_lockfile');
  const lock = present[0] ?? null;
  const runner = lock === 'bun.lock' || lock === 'bun.lockb' ? 'bun' : 'npm';
  if (manifest.packageManager !== undefined && (typeof manifest.packageManager !== 'string'
      || !new RegExp('^' + runner + '@[0-9][^\\s]*$').test(manifest.packageManager))) fail('unsupported_package_manager');
  const selected = ['check', 'typecheck', Object.hasOwn(scripts, 'test:run') ? 'test:run' : 'test', 'lint']
    .filter(name => Object.hasOwn(scripts, name));
  const requiredCommands: string[] = [];
  for (const name of selected) {
    const script = (scripts[name] as string).trim();
    if (/^(?:echo|printf|true|false|exit|:)(?:\s|$)/.test(script)) continue;
    if (/(?:^|[\s;&|])(?:--watch(?:all)?(?:=(?:true|1))?|-w|watch|--interactive|--ui)(?=$|[\s;&|])/i.test(script)) fail('unsupported_interactive_verification');
    // Names are fixed above; untrusted script text never enters this shell command.
    // npm can suppress pre/post hooks. Bun run has no --ignore-scripts switch;
    // its pristine repository hooks remain untrusted code inside the sandbox.
    // Exact runner recognition changes presentation only: no filter or bail.
    // Passed-only omits successful-test logs but preserves failing-test console,
    // assertions and exit status. Preserve custom scripts/reporters.
    const conciseVitest = script === 'vitest run' && (name === 'test:run' || name === 'test');
    requiredCommands.push(runner === 'bun' ? `CI=1 bun --no-env-file --no-install run ${name}${conciseVitest ? ' --reporter=dot --silent=passed-only' : ''}`
      : `CI=1 npm run --ignore-scripts ${name}${conciseVitest ? ' -- --reporter=dot --silent=passed-only' : ''}`);
  }
  if (!requiredCommands.length) fail('unsupported_verification');
  const dependencyCommands = lock === null ? [] : [runner === 'bun'
    ? 'bun install --frozen-lockfile --offline --ignore-scripts'
    : 'npm ci --offline --ignore-scripts --no-audit --no-fund'];
  const body = { version: 1 as const, kind: runner === 'bun' ? 'javascript_bun' as const : 'javascript_npm' as const,
    dependencyCommands: Object.freeze(dependencyCommands), requiredCommands: Object.freeze(requiredCommands) };
  return Object.freeze({ ...body, hash: sha(JSON.stringify({ ...body,
    packageJsonSha256: sha(raw), lockfile: lock === null ? null : { name: lock, sha256: sha(files[lock]!) } })) });
}

/** Caller must establish a pristine, source-bound clone and exclude concurrent
 * writers while deriving this policy. File checks detect changes, but do not
 * authenticate Git history. Unsupported non-JS toolchains need a future explicit
 * trusted profile API; do not derive a new profile from model-edited files. */
export function createEngineeringVerificationProfile(input: { workspaceRoot: string }): EngineeringVerificationProfile {
  const files = capture(input.workspaceRoot), profile = derive(input.workspaceRoot,files);
  if (derive(input.workspaceRoot).hash !== profile.hash) fail('profile_changed');
  profiles.add(profile); originalProfiles.add(profile); baselineInputs.set(profile,files); return profile;
}

/** Network admission must originate from the independently acquired pristine
 * profile, never a profile derived from worker-controlled candidate files. */
export function assertEngineeringOriginalVerificationProfile(profile: EngineeringVerificationProfile, input: {workspaceRoot:string}):void {
  if (!profile || !originalProfiles.has(profile)) fail('original_profile_required');
  assertEngineeringVerificationProfile(profile,input);
}

/** Recheck immediately before execution. A separate independently cloned verifier
 * may use the profile when the caller proves the same source revision; identical
 * package/lock bytes and commands are required. JSON copies lose provenance. */
export function assertEngineeringVerificationProfile(profile: EngineeringVerificationProfile, input: { workspaceRoot: string }): void {
  if (!profile || typeof profile !== 'object' || !profiles.has(profile)) fail('untrusted_profile');
  if (derive(input.workspaceRoot).hash !== profile.hash) fail('profile_changed');
}

/** Explicit host path for requested dependency/config edits. The baseline check
 * names, command text and every package script (including pre/post hooks) remain
 * unchanged. Only dependency declarations and the same lockfile format may
 * change. Returned profile is a separate host capability bound to candidate
 * bytes; it does not replace the original policy's verification authority. */
export function createEngineeringCandidateVerificationProfile(baseline:EngineeringVerificationProfile,input:{workspaceRoot:string}):EngineeringVerificationProfile {
  const previous=baselineInputs.get(baseline);if(!previous||!profiles.has(baseline))fail('untrusted_profile');
  const files=capture(input.workspaceRoot);
  if(!files['package.json'])fail('unsupported_toolchain');
  const before=JSON.parse(previous['package.json']!.toString('utf8')) as Record<string,unknown>;
  const after=JSON.parse(files['package.json']!.toString('utf8')) as Record<string,unknown>;
  const allowed=new Set(['dependencies','devDependencies','optionalDependencies','peerDependencies','peerDependenciesMeta','overrides','resolutions','trustedDependencies']);
  const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
  const fixed=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([key])=>!allowed.has(key)));
  if(canonical(fixed(before))!==canonical(fixed(after)))fail('verification_authority_changed');
  const hadLock=locks.some(name=>previous[name]!==null);
  for(const name of [...locks,...unsupportedLocks])if((previous[name]===null)!==(files[name]===null)
      && !(name==='package-lock.json'&&!hadLock&&baseline.kind==='javascript_npm'&&previous[name]===null&&files[name]!==null))fail('lockfile_kind_changed');
  const candidate=derive(input.workspaceRoot,files);
  if(derive(input.workspaceRoot).hash!==candidate.hash)fail('profile_changed');
  if(candidate.kind!==baseline.kind||JSON.stringify(candidate.requiredCommands)!==JSON.stringify(baseline.requiredCommands))fail('verification_authority_changed');
  profiles.add(candidate);baselineInputs.set(candidate,files);return candidate;
}
