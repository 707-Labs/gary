/** Fully in-memory holder/inspection/preflight fixtures: never acquires a lock. */
import { expect, test } from 'bun:test';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { acquireEngineeringResourceLease, ENGINEERING_RESOURCE_REQUIREMENTS,
  type EngineeringResourceLeaseOptions } from '../../src/executors/engineering-resource-lease.ts';
import { engineeringHeadroom } from '../../src/hermes/engineering-preflight.ts';

const binding = { taskId: 'task', sessionId: 'session', ownerEpoch: 'owner' };
function fixture(headroom = { availableCpus: 6, availableMemoryBytes: 16 * 1024 ** 3 }) {
  const counts = { inspected: 0, spawned: 0, checked: 0, released: 0 };
  const pin = { path: '/fixture/in-memory-lock', dev: 1, ino: 2, uid: 501, mode: 0o644, nlink: 1 };
  const options: EngineeringResourceLeaseOptions = { binding, lockPin: pin,
    inspection: { lstat() { counts.inspected++; return { ...pin, isFile: () => true, isSymbolicLink: () => false }; },
      realpath() { counts.inspected++; return pin.path; } },
    async preflight(requirements) {
      counts.checked++; expect(requirements).toEqual(ENGINEERING_RESOURCE_REQUIREMENTS);
      expect(Object.isFrozen(requirements)).toBe(true); return headroom;
    },
    spawn: ((_command: string, args: string[]) => {
      counts.spawned++;
      const manifest = JSON.parse(args.at(-1)!);
      const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
      const stdin = new Writable({ write(chunk, _encoding, done) {
        expect(JSON.parse(chunk.toString())).toEqual({ kind: 'release', birthToken: manifest.birthToken }); counts.released++;
        queueMicrotask(() => { stdout.write(JSON.stringify({ kind: 'released', birthToken: manifest.birthToken }) + '\n'); child.emit('close', 0); }); done();
      } });
      queueMicrotask(() => stdout.write(JSON.stringify({ kind: 'held', birthToken: manifest.birthToken,
        pid: 12345, startedAtUnixNs: '1000000000000' }) + '\n'));
      return Object.assign(child, { pid: 12345, stdin, stdout, stderr, kill() { throw Error('kill forbidden'); } });
    }) as unknown as typeof spawn,
  };
  return { options, counts };
}

test('6 CPU/16 GiB aggregate remains frozen and an aborted task retains its slot until exact confirmed cleanup', async () => {
  const f = fixture(), cancellation = new AbortController();
  const lease = await acquireEngineeringResourceLease({ ...f.options, signal: cancellation.signal });
  expect(lease.reference.requirements).toEqual({ cpus: 6, memoryBytes: 16 * 1024 ** 3 });
  expect(f.counts.checked).toBe(1); expect(f.counts.released).toBe(0); lease.assertHeld();
  cancellation.abort(); expect(lease.signal.aborted).toBe(true); expect(f.counts.released).toBe(0);
  for (const proof of [{ ...binding, cleanupConfirmed: false }, { ...binding, ownerEpoch: 'foreign', cleanupConfirmed: true }]) {
    await expect(lease.release(proof as Parameters<typeof lease.release>[0])).rejects.toThrow('cleanup_unconfirmed');
    expect(f.counts.released).toBe(0);
  }
  await lease.release({ ...binding, cleanupConfirmed: true }); expect(f.counts.released).toBe(1);
  await lease.release({ ...binding, cleanupConfirmed: true }); expect(f.counts.released).toBe(1);
});

test('insufficient aggregate headroom drains the unused holder and rejects admission', async () => {
  for (const room of [{ availableCpus: 5, availableMemoryBytes: 16 * 1024 ** 3 },
    { availableCpus: 6, availableMemoryBytes: 16 * 1024 ** 3 - 1 }]) {
    const f = fixture(room);
    await expect(acquireEngineeringResourceLease(f.options)).rejects.toThrow('headroom_unavailable');
    expect(f.counts.checked).toBe(1); expect(f.counts.released).toBe(1);
  }
});

test('above-ceiling resources reject before lock observation or holder creation', async () => {
  for (const requirements of [{ cpus: 7, memoryBytes: 16 * 1024 ** 3 }, { cpus: 6, memoryBytes: 16 * 1024 ** 3 + 1 }]) {
    const f = fixture();
    await expect(acquireEngineeringResourceLease({ ...f.options, requirements })).rejects.toThrow('invalid_requirements');
    expect(f.counts).toEqual({ inspected: 0, spawned: 0, checked: 0, released: 0 });
  }
});

test('headroom keeps existing workloads and host overhead outside the engineering aggregate', () => {
  const id = 'a'.repeat(64);
  const result = engineeringHeadroom({ daemonId: 'e5f09239-f79d-40b7-91b2-981d1372cde5', cpus: 8,
    memoryBytes: 22 * 1024 ** 3, runningContainers: 1 }, [{ id, name: 'other-service' }],
  [{ id, cpu: '100%', memory: '2GiB / 22GiB' }]);
  expect(result).toEqual({ availableCpus: 6, availableMemoryBytes: 16 * 1024 ** 3 });
});
