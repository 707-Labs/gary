import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireEngineeringResourceLease, ENGINEERING_RESOURCE_REQUIREMENTS,
  type EngineeringResourceLease, type EngineeringResourceLeaseOptions, type EngineeringResourceLockPin,
  type EngineeringResourceRequirements } from '../../src/executors/engineering-resource-lease.ts';

const binding = { taskId: 'fixture-task', sessionId: 'fixture-session', ownerEpoch: 'fixture-owner' };
const proof = { ...binding, cleanupConfirmed: true as const };
const roots: string[] = [], leases: EngineeringResourceLease[] = [];
afterEach(async () => {
  // Fixtures never launch task workloads, so physical absence is known here.
  for (const lease of leases.splice(0)) await lease.release(proof);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): EngineeringResourceLockPin {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-resource-lease-fixture-'))); roots.push(root);
  const path = join(root, 'fixture.lock'); writeFileSync(path, 'fixture lock remains untouched\n', { mode: 0o600 });
  const st = lstatSync(path);
  return { path, dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode & 0o777, nlink: st.nlink };
}
const preflight = async () => ({ availableCpus: 6, availableMemoryBytes: 16 * 1024 ** 3 });
async function acquire(lockPin: EngineeringResourceLockPin, extra: Partial<EngineeringResourceLeaseOptions> = {}) {
  const lease = await acquireEngineeringResourceLease({ binding, lockPin, preflight, ...extra }); leases.push(lease); return lease;
}
async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_abort_timeout')), 3000);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

describe('isolated engineering resource lease', () => {
  it('requires an explicit lock pin before observation or spawning; no historical default exists', async () => {
    let observations = 0, spawns = 0;
    await expect(acquireEngineeringResourceLease({ binding, preflight,
      inspection: { lstat() { observations++; throw Error('must not observe'); }, realpath() { observations++; throw Error('must not observe'); } },
      spawn: (() => { spawns++; throw Error('must not spawn'); }) as typeof spawn,
    } as unknown as EngineeringResourceLeaseOptions)).rejects.toThrow('engineering_resource_invalid_pin');
    expect(observations).toBe(0); expect(spawns).toBe(0);
    expect(ENGINEERING_RESOURCE_REQUIREMENTS).toEqual({ cpus: 6, memoryBytes: 17179869184 });
  });

  it('holds an exclusive descriptor, checks aggregate headroom and leaves the file untouched', async () => {
    const pin = fixture(); let checks = 0;
    const lease = await acquire(pin, { preflight: async requirements => {
      expect(requirements).toEqual(ENGINEERING_RESOURCE_REQUIREMENTS); checks++; return preflight();
    } });
    expect(checks).toBe(1); expect(lease.reference.binding).toEqual(binding);
    expect(lease.reference.pid).toBeGreaterThan(1); expect(lease.reference.birthToken).toMatch(/^[a-f0-9-]{36}$/);
    expect(lease.reference.startedAtUnixNs).toMatch(/^[0-9]+$/); expect(lease.reference.lock).toEqual(pin);
    expect(lease.reference.requirements).toEqual(ENGINEERING_RESOURCE_REQUIREMENTS);
    lease.assertHeld(); expect(lease.signal.aborted).toBe(false);
    expect(readFileSync(pin.path, 'utf8')).toBe('fixture lock remains untouched\n');
    expect(lstatSync(pin.path).ino).toBe(pin.ino);
    await lease.release(proof); await lease.release(proof); expect(() => lease.assertHeld()).toThrow('not_held');
    const next = await acquire(pin); next.assertHeld();
  });

  it('admits the exact reviewed 3 CPU/6 GiB sum and records a frozen snapshot', async () => {
    const pin = fixture(), requirements = { cpus: 3, memoryBytes: 6 * 1024 ** 3 };
    let observed: Readonly<EngineeringResourceRequirements> | undefined;
    const pending = acquire(pin, { requirements, preflight: async selected => {
      observed = selected;
      expect(Object.isFrozen(selected)).toBe(true);
      return { availableCpus: 3, availableMemoryBytes: 6 * 1024 ** 3 };
    } });
    requirements.cpus = 6; requirements.memoryBytes = 16 * 1024 ** 3;
    const lease = await pending;
    expect(observed).toEqual({ cpus: 3, memoryBytes: 6 * 1024 ** 3 });
    expect(lease.reference.requirements).toEqual(observed!);
    expect(Object.isFrozen(lease.reference.requirements)).toBe(true);
    lease.assertHeld();
  });

  it('requires headroom for every byte and CPU in the selected aggregate', async () => {
    const pin = fixture(), requirements = { cpus: 3, memoryBytes: 6 * 1024 ** 3 };
    await expect(acquire(pin, { requirements, preflight: async () => ({
      availableCpus: 2, availableMemoryBytes: requirements.memoryBytes,
    }) })).rejects.toThrow('headroom_unavailable');
    await expect(acquire(pin, { requirements, preflight: async () => ({
      availableCpus: requirements.cpus, availableMemoryBytes: requirements.memoryBytes - 1,
    }) })).rejects.toThrow('headroom_unavailable');
    (await acquire(pin, { requirements })).assertHeld();
  });

  it.each([
    { cpus: 0, memoryBytes: 1 }, { cpus: 7, memoryBytes: 1 }, { cpus: 1.5, memoryBytes: 1 },
    { cpus: NaN, memoryBytes: 1 }, { cpus: Infinity, memoryBytes: 1 },
    { cpus: 1, memoryBytes: 0 }, { cpus: 1, memoryBytes: 16 * 1024 ** 3 + 1 },
    { cpus: 1, memoryBytes: 1.5 }, { cpus: 1, memoryBytes: NaN }, { cpus: 1, memoryBytes: Infinity },
    { cpus: 1 }, { cpus: 1, memoryBytes: 1, extra: true }, null,
  ])('rejects malformed or over-ceiling resource requirements before spawning (%j)', async value => {
    const pin = fixture(); let spawns = 0, checks = 0;
    const noSpawn = (() => { spawns++; throw new Error('must_not_spawn'); }) as typeof spawn;
    await expect(acquire(pin, { requirements: value as EngineeringResourceRequirements, spawn: noSpawn,
      preflight: async () => { checks++; return preflight(); } })).rejects.toThrow('invalid_requirements');
    expect(spawns).toBe(0); expect(checks).toBe(0);
  });

  it('rejects a contending owner without waiting, preflight, lock stealing or file changes', async () => {
    const pin = fixture(), first = await acquire(pin); let checks = 0;
    await expect(acquire(pin, { preflight: async () => { checks++; return preflight(); } })).rejects.toThrow('busy');
    expect(checks).toBe(0); first.assertHeld();
    expect(lstatSync(pin.path).ino).toBe(pin.ino); expect(readFileSync(pin.path, 'utf8')).toContain('untouched');
    await first.release(proof); (await acquire(pin)).assertHeld();
  });

  it.each(['dev', 'ino', 'uid', 'mode', 'nlink'] as const)('rejects the wrong %s pin before spawning', async field => {
    const pin = fixture(); let spawns = 0;
    const noSpawn = (() => { spawns++; throw new Error('must_not_spawn'); }) as typeof spawn;
    await expect(acquire({ ...pin, [field]: pin[field] + 1 }, { spawn: noSpawn })).rejects.toThrow();
    expect(spawns).toBe(0);
  });

  it('rejects symlink lock paths without touching the target', async () => {
    const pin = fixture(), link = join(roots.at(-1)!, 'link.lock'); symlinkSync(pin.path, link);
    await expect(acquire({ ...pin, path: link })).rejects.toThrow('lock_identity_changed');
    expect(readFileSync(pin.path, 'utf8')).toContain('untouched');
  });

  it('failed preflight drains its own holder before rejecting, with no workload admitted', async () => {
    const pin = fixture();
    await expect(acquire(pin, { preflight: async () => ({ availableCpus: 5, availableMemoryBytes: 32 * 1024 ** 3 }) })).rejects.toThrow('headroom_unavailable');
    await expect(acquire(pin, { preflight: async () => ({ availableCpus: 8, availableMemoryBytes: 15 * 1024 ** 3 }) })).rejects.toThrow('headroom_unavailable');
    await expect(acquire(pin, { preflight: async () => { throw new Error('fixture_observation_failed'); } })).rejects.toThrow('fixture_observation_failed');
    (await acquire(pin)).assertHeld();
  });

  it('cancellation interrupts a stalled read-only preflight and drains before returning', async () => {
    const pin = fixture(), cancellation = new AbortController(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = acquire(pin, { signal: cancellation.signal, preflight: async () => {
      entered(); return await new Promise<never>(() => {});
    } });
    await started; cancellation.abort();
    await expect(pending).rejects.toThrow('cancelled'); (await acquire(pin)).assertHeld();
  });

  it('does not miss cancellation occurring inside spawn before listener registration', async () => {
    const pin = fixture(), cancellation = new AbortController(); let checks = 0;
    const spawnFixture: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args); cancellation.abort(); return child;
    }) as typeof spawn;
    await expect(acquire(pin, { signal: cancellation.signal, spawn: spawnFixture, preflight: async () => {
      checks++; return preflight();
    } })).rejects.toThrow('cancelled');
    expect(checks).toBe(0); (await acquire(pin)).assertHeld();
  });

  it('requires exact task, session, owner and confirmed cleanup before release', async () => {
    const pin = fixture(), lease = await acquire(pin);
    for (const field of ['taskId', 'sessionId', 'ownerEpoch']) {
      await expect(lease.release({ ...proof, [field]: 'foreign' })).rejects.toThrow('cleanup_unconfirmed'); lease.assertHeld();
    }
    await expect(lease.release({ ...proof, cleanupConfirmed: false } as unknown as typeof proof)).rejects.toThrow('cleanup_unconfirmed');
    await expect(acquire(pin)).rejects.toThrow('busy'); lease.assertHeld();
  });

  it('aborts on child loss so the host can terminate both task containers', async () => {
    const pin = fixture(); let child: ChildProcessWithoutNullStreams | undefined;
    const spawnFixture: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args) as ChildProcessWithoutNullStreams; return child;
    }) as typeof spawn;
    const lease = await acquire(pin, { spawn: spawnFixture });
    // Only this fixture's exact spawned holder; there are no native/executor workloads.
    child!.kill('SIGKILL'); await aborted(lease.signal);
    expect(() => lease.assertHeld()).toThrow('not_held'); await lease.release(proof);
  });

  it('lock path replacement aborts but keeps the old inode leased until verified cleanup', async () => {
    const pin = fixture(), lease = await acquire(pin), oldPath = pin.path + '.old';
    renameSync(pin.path, oldPath); writeFileSync(pin.path, 'replacement', { mode: pin.mode });
    await aborted(lease.signal); expect(() => lease.assertHeld()).toThrow('not_held');
    await expect(acquire({ ...pin, path: oldPath })).rejects.toThrow('busy');
    await lease.release(proof); (await acquire({ ...pin, path: oldPath })).assertHeld();
  });

  it('mode changes abort admission without changing the lock or releasing it', async () => {
    const pin = fixture(), lease = await acquire(pin); chmodSync(pin.path, 0o644);
    await aborted(lease.signal); expect(() => lease.assertHeld()).toThrow('not_held');
    await expect(acquire({ ...pin, mode: 0o644 })).rejects.toThrow('busy');
    await lease.release(proof); expect(lstatSync(pin.path).mode & 0o777).toBe(0o644);
  });

  it('cancellation retains the lock until both workloads are proven absent', async () => {
    const pin = fixture(), cancellation = new AbortController();
    const lease = await acquire(pin, { signal: cancellation.signal }); cancellation.abort();
    await aborted(lease.signal); await expect(acquire(pin)).rejects.toThrow('busy');
    await lease.release(proof); (await acquire(pin)).assertHeld();
  });

  it('parent EOF retains an orphan lock, and confirmed cleanup drains only that holder', async () => {
    const pin = fixture(); let child: ChildProcessWithoutNullStreams | undefined;
    const spawnFixture: typeof spawn = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args) as ChildProcessWithoutNullStreams; return child;
    }) as typeof spawn;
    const lease = await acquire(pin, { spawn: spawnFixture }); child!.stdin.end();
    await aborted(lease.signal); await expect(acquire(pin)).rejects.toThrow('busy');
    await lease.release(proof); expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    (await acquire(pin)).assertHeld();
  });
});
