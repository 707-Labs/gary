import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStandingEngineeringEnv } from '../src/standing-engineering-env.ts';

const RELEASE = 'a'.repeat(40);
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture(revision = RELEASE) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'standing-env-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'runtime'); mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700);
  const config = join(dir, 'config.json'), authority = join(dir, 'authority.json'), env = join(dir, 'standing-engineering.env');
  const configText = JSON.stringify({ sourceRevision: revision }), authorityText = '{"kind":"authority"}';
  writeFileSync(config, configText, { mode: 0o600 }); writeFileSync(authority, authorityText, { mode: 0o600 });
  const lines = [`GARY_STANDING_ENGINEERING_CONFIG=${config}`, `GARY_STANDING_ENGINEERING_CONFIG_SHA256=${sha(configText)}`,
    `GARY_STANDING_ENGINEERING_AUTHORITY=${authority}`, `GARY_STANDING_ENGINEERING_AUTHORITY_SHA256=${sha(authorityText)}`];
  const write = (text: string, mode = 0o600) => { rmSync(env, { force: true }); writeFileSync(env, text, { mode }); chmodSync(env, mode); };
  write(lines.join('\n') + '\n');
  return { env, lines, write, config };
}

test('deploy re-applies exactly the four pinned standing variables when hashes and release match', () => {
  const f = fixture();
  expect(loadStandingEngineeringEnv(f.env, RELEASE)).toEqual(Object.fromEntries(f.lines.map(l => l.split('=') as [string, string])));
});

test('refuses stale release pins, hash drift, extra or missing keys and loose permissions', () => {
  expect(() => loadStandingEngineeringEnv(fixture('b'.repeat(40)).env, RELEASE)).toThrow('source_revision_mismatch');
  let f = fixture(); writeFileSync(f.config, JSON.stringify({ sourceRevision: RELEASE, edited: true }), { mode: 0o600 });
  expect(() => loadStandingEngineeringEnv(f.env, RELEASE)).toThrow('hash_mismatch:CONFIG');
  f = fixture(); f.write([...f.lines, 'GARY_EXTRA=1'].join('\n'));
  expect(() => loadStandingEngineeringEnv(f.env, RELEASE)).toThrow('keys');
  f = fixture(); f.write(f.lines.slice(1).join('\n'));
  expect(() => loadStandingEngineeringEnv(f.env, RELEASE)).toThrow('keys');
  f = fixture(); f.write(f.lines.join('\n'), 0o644);
  expect(() => loadStandingEngineeringEnv(f.env, RELEASE)).toThrow('file_metadata');
});
