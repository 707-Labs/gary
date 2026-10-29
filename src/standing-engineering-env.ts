/** Validates the private standing-engineering env file that scripts/deploy.sh
 * re-applies to the rendered LaunchAgent. Read-only; never writes or hashes it. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export const STANDING_ENGINEERING_ENV_KEYS = ['GARY_STANDING_ENGINEERING_CONFIG', 'GARY_STANDING_ENGINEERING_CONFIG_SHA256',
  'GARY_STANDING_ENGINEERING_AUTHORITY', 'GARY_STANDING_ENGINEERING_AUTHORITY_SHA256'] as const;
export type StandingEngineeringEnv = Readonly<Record<(typeof STANDING_ENGINEERING_ENV_KEYS)[number], string>>;

function fail(reason: string): never { throw new Error('standing_engineering_env:' + reason); }
function privateFile(path: string, mode: number): void {
  const st = lstatSync(path);
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !st.isFile() || st.isSymbolicLink()
      || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== mode) fail('file_metadata:' + path);
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Exactly the four keys; both pinned files must match their hashes now and the
 * config must be pinned to the release being deployed. */
export function loadStandingEngineeringEnv(path: string, release: string): StandingEngineeringEnv {
  privateFile(path, 0o600);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) fail('parent_metadata');
  const entries = readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => {
    const at = line.indexOf('='); if (at < 1) fail('syntax'); return [line.slice(0, at), line.slice(at + 1)] as const;
  });
  const env = Object.fromEntries(entries) as Record<string, string>;
  if (entries.length !== STANDING_ENGINEERING_ENV_KEYS.length || STANDING_ENGINEERING_ENV_KEYS.some(key => !Object.hasOwn(env, key))) fail('keys');
  for (const kind of ['CONFIG', 'AUTHORITY'] as const) {
    const file = env['GARY_STANDING_ENGINEERING_' + kind]!, digest = env[`GARY_STANDING_ENGINEERING_${kind}_SHA256`]!;
    if (!/^[a-f0-9]{64}$/.test(digest) || /[\x00-\x1f]/.test(file)) fail('value:' + kind);
    privateFile(file, 0o600);
    if (sha(file) !== digest) fail('hash_mismatch:' + kind);
  }
  let revision: unknown;
  try { revision = JSON.parse(readFileSync(env.GARY_STANDING_ENGINEERING_CONFIG!, 'utf8')).sourceRevision; } catch { fail('config_json'); }
  // Startup rejects a mismatch anyway; refusing here keeps deploy from dropping into a crash loop.
  if (revision !== release) fail(`source_revision_mismatch:config=${String(revision)} release=${release}`);
  return Object.freeze(env as StandingEngineeringEnv);
}
