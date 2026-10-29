import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEngineeringResourceLockForBoot } from '../../src/executors/engineering-resource-reboot.ts';
import { createEngineeringResourceBindingGuard } from '../../src/executors/engineering-resource-binding.ts';
import { assertEngineeringRebootQuiescent } from '../../src/hermes/engineering-reboot-quiescence.ts';

const OLD_BOOT = '02D97A38-83D2-457D-967F-A01481D5EEFC', NEW_BOOT = '2C2DEAF4-4608-4037-97F1-6E3E007AEBA7';
const VOLUME = '7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697';
const PIN_PATH = '/private/tmp/apple-release-xcode.lock';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });

function fixture(boot = NEW_BOOT) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-reboot-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const receipts = join(root, 'receipts'); mkdirSync(receipts, { mode: 0o700 }); chmodSync(receipts, 0o700);
  const lockPath = join(root, 'apple-release-xcode.lock');
  let quiescentCalls = 0, current = boot;
  const configured = { path: PIN_PATH, dev: 16777232, ino: 176033673, uid: 501, mode: 0o644, nlink: 1, bootSessionUUID: OLD_BOOT, apfsVolumeUUID: VOLUME };
  const options = (extra: Record<string, unknown> = {}) => ({ configured, receiptDirectory: receipts, lockPath, uid: process.getuid!(),
    dataVolumeDev: () => 1, observeBoot: () => ({ bootSessionUUID: current, apfsVolumeUUID: VOLUME }),
    assertQuiescent: () => { quiescentCalls++; return { terminalTasks: 3, labelledContainers: 0 }; }, now: () => 1, ...extra });
  return { root, receipts, lockPath, configured, options, quiescentCalls: () => quiescentCalls, setBoot: (b: string) => { current = b; } };
}

test('same boot keeps the configured pin and never checks quiescence or touches the lock', () => {
  const f = fixture(OLD_BOOT);
  expect(resolveEngineeringResourceLockForBoot(f.options())).toEqual(f.configured);
  expect(f.quiescentCalls()).toBe(0); expect(() => lstatSync(f.lockPath)).toThrow(); expect(readdirSync(f.receipts)).toEqual([]);
});

test('first start after a reboot proves quiescence, creates the lock 0644 and records one boot receipt', () => {
  const f = fixture();
  const binding = resolveEngineeringResourceLockForBoot(f.options());
  const st = lstatSync(f.lockPath);
  expect(binding).toEqual({ path: PIN_PATH, dev: st.dev, ino: st.ino, uid: 501, mode: 0o644, nlink: 1, bootSessionUUID: NEW_BOOT, apfsVolumeUUID: VOLUME });
  expect(st.mode & 0o7777).toBe(0o644); expect(f.quiescentCalls()).toBe(1);
  const receiptPath = join(f.receipts, NEW_BOOT + '.json');
  expect(lstatSync(receiptPath).mode & 0o777).toBe(0o600);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  expect(receipt).toMatchObject({ version: 1, kind: 'engineering_resource_boot_rebind', lockCreated: true, binding, quiescence: { terminalTasks: 3, labelledContainers: 0 } });
  // The ordinary guard accepts the new pin in the new boot (path observed through the test lock).
  const guard = createEngineeringResourceBindingGuard(binding, { observeBoot: () => ({ bootSessionUUID: NEW_BOOT, apfsVolumeUUID: VOLUME }),
    inspection: { lstat: () => lstatSync(f.lockPath), realpath: p => p } });
  expect(guard().ino).toBe(st.ino);
});

test('later starts in the same boot reuse the recorded pin without re-deriving it, so a replaced lock is still rejected', () => {
  const f = fixture();
  const first = resolveEngineeringResourceLockForBoot(f.options());
  rmSync(f.lockPath); writeFileSync(f.lockPath, '', { mode: 0o644 }); chmodSync(f.lockPath, 0o644);
  const second = resolveEngineeringResourceLockForBoot(f.options());
  expect(second).toEqual(first); expect(f.quiescentCalls()).toBe(1);
  const guard = createEngineeringResourceBindingGuard(second, { observeBoot: () => ({ bootSessionUUID: NEW_BOOT, apfsVolumeUUID: VOLUME }),
    inspection: { lstat: () => lstatSync(f.lockPath), realpath: p => p } });
  if (lstatSync(f.lockPath).ino !== first.ino) expect(() => guard()).toThrow('engineering_resource_lock_identity_changed');
});

test('refuses to rebind when anything is in flight, and leaves no lock or receipt behind', () => {
  const f = fixture();
  expect(() => resolveEngineeringResourceLockForBoot(f.options({ assertQuiescent: () => { throw new Error('engineering_runtime:reboot_not_quiescent:task'); } })))
    .toThrow('reboot_not_quiescent:task');
  expect(() => lstatSync(f.lockPath)).toThrow(); expect(readdirSync(f.receipts)).toEqual([]);
});

test('never rebinds across volumes, never adopts a misshapen or symlinked lock, and rejects a tampered receipt', () => {
  const f = fixture();
  expect(() => resolveEngineeringResourceLockForBoot(f.options({ observeBoot: () => ({ bootSessionUUID: NEW_BOOT, apfsVolumeUUID: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }) })))
    .toThrow('engineering_resource_boot_identity_changed');
  writeFileSync(f.lockPath, '', { mode: 0o666 }); chmodSync(f.lockPath, 0o666);
  expect(() => resolveEngineeringResourceLockForBoot(f.options())).toThrow('engineering_resource_lock_identity_changed');
  expect(lstatSync(f.lockPath).mode & 0o777).toBe(0o666); // never "fixed up"
  rmSync(f.lockPath); const target = join(f.root, 'target'); writeFileSync(target, '', { mode: 0o644 }); chmodSync(target, 0o644); symlinkSync(target, f.lockPath);
  expect(() => resolveEngineeringResourceLockForBoot(f.options())).toThrow('engineering_resource_lock_identity_changed');
  rmSync(f.lockPath);
  const binding = resolveEngineeringResourceLockForBoot(f.options());
  const receiptPath = join(f.receipts, NEW_BOOT + '.json');
  const tampered = JSON.parse(readFileSync(receiptPath, 'utf8')); tampered.binding.ino = binding.ino + 1;
  chmodSync(receiptPath, 0o600); rmSync(receiptPath); writeFileSync(receiptPath, JSON.stringify({ ...tampered, configuredBindingSha256: 'f'.repeat(64) }), { mode: 0o600 });
  expect(() => resolveEngineeringResourceLockForBoot(f.options())).toThrow('engineering_resource_reboot_receipt_invalid');
});

function stores() {
  const journal = new Database(':memory:'), spend = new Database(':memory:');
  cleanup.push(() => journal.close(), () => spend.close());
  journal.exec(`CREATE TABLE engineering_tasks(task_id TEXT, state TEXT, cleanup_confirmed INTEGER);
    CREATE TABLE engineering_ingress_requests(task_id TEXT, stage TEXT);
    CREATE TABLE engineering_runtime_runs(task_id TEXT, policy_hash TEXT, launch_state TEXT);
    INSERT INTO engineering_tasks VALUES('done','completed',1); INSERT INTO engineering_ingress_requests VALUES('done','completed');
    INSERT INTO engineering_runtime_runs VALUES('done','h','closed');`);
  spend.exec(`CREATE TABLE spend_attempts(id INTEGER PRIMARY KEY, ticket_id TEXT, state TEXT);
    CREATE TABLE standing_engineering_allocations(allocation_id TEXT);
    INSERT INTO standing_engineering_allocations VALUES('standing-1'); INSERT INTO spend_attempts(ticket_id,state) VALUES('standing-1','settled'),('other','unknown');`);
  return { journal, spend };
}

test('quiescence passes only with terminal cleaned-up tasks, closed runs, settled standing spend and no labelled containers', () => {
  const s = stores(), list = () => [] as string[];
  expect(assertEngineeringRebootQuiescent({ journalDb: s.journal, spendDb: s.spend, listLabelledContainers: list }))
    .toEqual({ terminalTasks: 1, standingAllocations: 1, labelledContainers: 0 });
  for (const [sql, db, reason] of [
    ["INSERT INTO engineering_tasks VALUES('t','running',0)", 'journal', 'task'],
    ["INSERT INTO engineering_tasks VALUES('t','cleanup_unknown',0)", 'journal', 'task'],
    ["INSERT INTO engineering_tasks VALUES('t','queued',1)", 'journal', 'task'],
    ["INSERT INTO engineering_tasks VALUES('t','completed',0)", 'journal', 'task'],
    ["INSERT INTO engineering_ingress_requests VALUES('t','preparing')", 'journal', 'ingress'],
    ["INSERT INTO engineering_runtime_runs VALUES('t','h','constructed')", 'journal', 'run'],
    ["INSERT INTO spend_attempts(ticket_id,state) VALUES('standing-1','reserved')", 'spend', 'spend_attempt'],
    ["INSERT INTO spend_attempts(ticket_id,state) VALUES('standing-1','unknown')", 'spend', 'spend_attempt'],
  ] as const) {
    const t = stores(); (db === 'journal' ? t.journal : t.spend).exec(sql);
    expect(() => assertEngineeringRebootQuiescent({ journalDb: t.journal, spendDb: t.spend, listLabelledContainers: list })).toThrow('reboot_not_quiescent:' + reason);
  }
  expect(() => assertEngineeringRebootQuiescent({ journalDb: s.journal, spendDb: s.spend, listLabelledContainers: () => ['abc'] })).toThrow('reboot_not_quiescent:container');
  expect(() => assertEngineeringRebootQuiescent({ journalDb: s.journal, spendDb: s.spend, listLabelledContainers: () => { throw new Error('docker down'); } }))
    .toThrow('reboot_not_quiescent:container_observation');
});
