/** Reviewed host policy, not a discovered lock identity. Import and construction
 * perform no I/O; calling the guard only observes the current boot and file.
 * Acquiring and retaining the lock remain the resource lease's responsibility. */
import { lstatSync, realpathSync } from 'node:fs';
import { observeEngineeringLedgerBootIdentity, type EngineeringLedgerBootIdentity } from '../hermes/engineering-budget-reboot.ts';
import type { EngineeringResourceLockInspection, EngineeringResourceLockPin } from './engineering-resource-lease.ts';

export interface EngineeringResourceLockBinding extends EngineeringResourceLockPin {
  readonly bootSessionUUID: string;
  readonly apfsVolumeUUID: string;
}

/** Trusted host test seams only; never populated from task or model arguments. */
export interface EngineeringResourceBindingDependencies {
  readonly observeBoot?: (dev: number) => Readonly<EngineeringLedgerBootIdentity>;
  readonly inspection?: EngineeringResourceLockInspection;
}

const PATH = '/private/tmp/apple-release-xcode.lock';
const UUID = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/;
const KEYS = ['path', 'dev', 'ino', 'uid', 'mode', 'nlink', 'bootSessionUUID', 'apfsVolumeUUID'] as const;
type Failure = 'binding_invalid' | 'boot_observation_failed' | 'boot_identity_changed' | 'lock_identity_changed';
function fail(reason: Failure): never { throw new Error(`engineering_resource_${reason}`); }

/** Exact flat data only. Snapshot property values without invoking accessors. */
export function parseEngineeringResourceLockBinding(value: unknown): Readonly<EngineeringResourceLockBinding> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('binding_invalid');
    const own = Reflect.ownKeys(value);
    if (own.length !== KEYS.length || KEYS.some(key => !own.includes(key))) fail('binding_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('binding_invalid');
    }
    const fields = Object.fromEntries(KEYS.map(key => [key, descriptors[key]!.value])) as Record<string, unknown>;
    if (fields.path !== PATH || fields.uid !== 501 || fields.mode !== 0o644 || fields.nlink !== 1
        || typeof fields.dev !== 'number' || !Number.isSafeInteger(fields.dev) || fields.dev <= 0
        || typeof fields.ino !== 'number' || !Number.isSafeInteger(fields.ino) || fields.ino <= 0
        || typeof fields.bootSessionUUID !== 'string' || !UUID.test(fields.bootSessionUUID)
        || typeof fields.apfsVolumeUUID !== 'string' || !UUID.test(fields.apfsVolumeUUID)) fail('binding_invalid');
    return Object.freeze({ path: PATH, dev: fields.dev, ino: fields.ino, uid: 501, mode: 0o644, nlink: 1,
      bootSessionUUID: fields.bootSessionUUID, apfsVolumeUUID: fields.apfsVolumeUUID });
  } catch { return fail('binding_invalid'); }
}

/** Every invocation rechecks the explicit pin. The default observer checks the
 * current Data-volume device each time, even when boot UUID queries are cached.
 * This guard neither learns a replacement identity nor claims a lock is held. */
export function createEngineeringResourceBindingGuard(
  binding: EngineeringResourceLockBinding,
  dependencies: EngineeringResourceBindingDependencies = {},
): () => Readonly<EngineeringResourceLockPin> {
  const expected = parseEngineeringResourceLockBinding(binding);
  const observeBoot = dependencies.observeBoot ?? observeEngineeringLedgerBootIdentity;
  const lstat = dependencies.inspection?.lstat ?? lstatSync;
  const realpath = dependencies.inspection?.realpath ?? realpathSync;
  const pin = Object.freeze({ path: expected.path, dev: expected.dev, ino: expected.ino,
    uid: expected.uid, mode: expected.mode, nlink: expected.nlink });
  return () => {
    let observed: Readonly<EngineeringLedgerBootIdentity>;
    try { observed = observeBoot(expected.dev); }
    catch { return fail('boot_observation_failed'); }
    try {
      if (observed?.bootSessionUUID !== expected.bootSessionUUID || observed?.apfsVolumeUUID !== expected.apfsVolumeUUID) {
        fail('boot_identity_changed');
      }
    } catch { return fail('boot_identity_changed'); }
    try {
      const before = lstat(pin.path);
      const canonical = realpath(pin.path);
      const after = lstat(pin.path);
      if (canonical !== pin.path || [before, after].some(st => !st.isFile() || st.isSymbolicLink()
          || st.dev !== pin.dev || st.ino !== pin.ino || st.uid !== pin.uid
          || (st.mode & 0o7777) !== pin.mode || st.nlink !== pin.nlink)) fail('lock_identity_changed');
    } catch { return fail('lock_identity_changed'); }
    return pin;
  };
}
