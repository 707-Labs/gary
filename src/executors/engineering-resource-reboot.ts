/** Boot-scoped re-binding of the engineering resource lock after a macOS reboot.
 *
 * The reviewed config pins the lock file's identity (dev/ino) together with the
 * boot session it was observed in. macOS empties /private/tmp at boot, so that
 * pin can never match again after a reboot. A new boot session is itself proof
 * that every process of the previous boot is gone, including any lock holder and
 * its fd. What can survive a reboot is durable state (journal rows, spend
 * attempts) and Docker containers that Colima restores. So a new pin is minted
 * only when those show nothing in flight, it is recorded once per boot in an
 * exclusive receipt, and every later start in the same boot reuses that receipt
 * rather than re-deriving it. Within a boot (and within one process) the
 * existing guard still rejects any replacement of the lock file.
 *
 * Never rebinds across a different APFS volume, never follows symlinks, never
 * replaces or rewrites an existing lock file, and never edits the config.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { observeEngineeringLedgerBootIdentity, type EngineeringLedgerBootIdentity } from '../hermes/engineering-budget-reboot.ts';
import { parseEngineeringResourceLockBinding, type EngineeringResourceLockBinding } from './engineering-resource-binding.ts';

/** Bounded, non-secret summary of what was checked before minting a new pin. */
export type EngineeringQuiescenceEvidence = Readonly<Record<string, number>>;

export interface EngineeringResourceRebootOptions {
  readonly configured: EngineeringResourceLockBinding;
  /** Existing private (0700) directory owned by this runtime; receipts are 0600. */
  readonly receiptDirectory: string;
  /** Throws unless nothing from a previous boot can still be in flight. */
  readonly assertQuiescent: () => EngineeringQuiescenceEvidence;
  /** Trusted test seams only. */
  readonly dataVolumeDev?: () => number;
  readonly observeBoot?: (dev: number) => Readonly<EngineeringLedgerBootIdentity>;
  readonly lockPath?: string;
  readonly uid?: number;
  readonly now?: () => number;
}

const RECEIPT_KEYS = ['version', 'kind', 'configuredBindingSha256', 'binding', 'lockCreated', 'quiescence', 'observedAtMs'] as const;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(reason: string): never { throw new Error(`engineering_resource_${reason}`); }

function readReceipt(path: string, configuredSha: string, boot: EngineeringLedgerBootIdentity,
  configured: EngineeringResourceLockBinding, lockPath: string, uid: number): Readonly<EngineeringResourceLockBinding> {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || st.size > 16_384) fail('reboot_receipt_invalid');
  let value: Record<string, unknown>;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { return fail('reboot_receipt_invalid'); }
  if (!value || typeof value !== 'object' || Object.keys(value).length !== RECEIPT_KEYS.length || RECEIPT_KEYS.some(k => !Object.hasOwn(value, k))
      || value.version !== 1 || value.kind !== 'engineering_resource_boot_rebind' || value.configuredBindingSha256 !== configuredSha) fail('reboot_receipt_invalid');
  const binding = parseEngineeringResourceLockBinding(value.binding);
  if (binding.bootSessionUUID !== boot.bootSessionUUID || binding.apfsVolumeUUID !== boot.apfsVolumeUUID
      || binding.path !== configured.path || binding.uid !== uid || binding.mode !== 0o644 || binding.nlink !== 1) fail('reboot_receipt_invalid');
  // The recorded lock must still be the file on disk. Within a boot a replaced or
  // missing lock is never re-minted: a detached holder from a crashed Gary can
  // outlive it and still hold the old inode, which durable state cannot prove absent.
  let lock;
  try { lock = lstatSync(lockPath); } catch { return fail('lock_identity_changed'); }
  if (!lock.isFile() || lock.isSymbolicLink() || lock.dev !== binding.dev || lock.ino !== binding.ino || lock.uid !== uid
      || (lock.mode & 0o7777) !== 0o644 || lock.nlink !== 1) fail('lock_identity_changed');
  return binding;
}

/** Returns the configured pin in its own boot, this boot's recorded pin, or a newly minted one. */
export function resolveEngineeringResourceLockForBoot(options: EngineeringResourceRebootOptions): Readonly<EngineeringResourceLockBinding> {
  const configured = parseEngineeringResourceLockBinding(options.configured);
  const lockPath = options.lockPath ?? configured.path;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  let boot: Readonly<EngineeringLedgerBootIdentity>;
  try {
    const dev = (options.dataVolumeDev ?? (() => lstatSync('/System/Volumes/Data').dev))();
    boot = (options.observeBoot ?? observeEngineeringLedgerBootIdentity)(dev);
  } catch { return fail('boot_observation_failed'); }
  // Another volume is another machine or a restored disk: never rebind.
  if (boot.apfsVolumeUUID !== configured.apfsVolumeUUID) fail('boot_identity_changed');
  if (boot.bootSessionUUID === configured.bootSessionUUID) return configured;

  const configuredSha = sha(configured);
  const dir = options.receiptDirectory;
  const ds = lstatSync(dir);
  if (!ds.isDirectory() || ds.isSymbolicLink() || ds.uid !== uid || (ds.mode & 0o777) !== 0o700 || realpathSync(dir) !== dir) fail('reboot_receipt_directory');
  const receiptPath = join(dir, boot.bootSessionUUID + '.json');
  try { lstatSync(receiptPath); return readReceipt(receiptPath, configuredSha, boot, configured, lockPath, uid); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  // First start in this boot: prove nothing from the previous boot survives.
  const quiescence = options.assertQuiescent();

  let lockCreated = false;
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    try { fchmodSync(fd, 0o644); fsyncSync(fd); } finally { closeSync(fd); }
    lockCreated = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return fail('lock_create_failed'); }
  // Adopt an existing lock file only if it already has the reviewed shape; never fix it up.
  const st = lstatSync(lockPath);
  if (!st.isFile() || st.isSymbolicLink() || realpathSync(lockPath) !== lockPath || st.uid !== uid
      || (st.mode & 0o7777) !== 0o644 || st.nlink !== 1 || realpathSync(dirname(lockPath)) !== dirname(lockPath)) fail('lock_identity_changed');
  const binding = parseEngineeringResourceLockBinding({ path: configured.path, dev: st.dev, ino: st.ino, uid: st.uid,
    mode: st.mode & 0o7777, nlink: st.nlink, bootSessionUUID: boot.bootSessionUUID, apfsVolumeUUID: boot.apfsVolumeUUID });

  const receipt = { version: 1, kind: 'engineering_resource_boot_rebind', configuredBindingSha256: configuredSha,
    binding, lockCreated, quiescence, observedAtMs: (options.now ?? Date.now)() };
  let fd: number;
  try { fd = openSync(receiptPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    // A concurrent start in this boot recorded first; its pin is authoritative.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readReceipt(receiptPath, configuredSha, boot, configured, lockPath, uid);
    throw error;
  }
  try {
    const bytes = Buffer.from(JSON.stringify(receipt));
    if (writeSync(fd, bytes) !== bytes.length || fstatSync(fd).size !== bytes.length) fail('reboot_receipt_write_failed');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  return binding;
}
