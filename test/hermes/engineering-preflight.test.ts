import { expect, test } from 'bun:test';
import { engineeringHeadroom } from '../../src/hermes/engineering-preflight.ts';
const info = { daemonId: 'e5f09239-f79d-40b7-91b2-981d1372cde5', cpus: 8, memoryBytes: 16734449664, runningContainers: 1 };
const containers = [{ id: 'a'.repeat(64), name: 'existing-service' }];
const stats = [{ id: 'a'.repeat(12), cpu: '1.25%', memory: '100MiB / 15.59GiB' }];
test('headroom preserves other service usage plus fixed overhead allowance', () => {
  expect(engineeringHeadroom(info, containers, stats)).toEqual({ availableCpus: 6, availableMemoryBytes: 16734449664 - 100 * 1024 ** 2 - 4 * 1024 ** 3 });
  expect(engineeringHeadroom(info, containers, [{ ...stats[0], cpu: '700%', memory: '14GiB / 15.59GiB' }])).toEqual({ availableCpus: 0, availableMemoryBytes: 0 });
});
test('incomplete, ambiguous and active Gary worker observations block admission', () => {
  expect(() => engineeringHeadroom(info, containers, [])).toThrow('unavailable');
  expect(() => engineeringHeadroom({ ...info, daemonId: 'other' }, containers, stats)).toThrow('unavailable');
  expect(() => engineeringHeadroom(info, [{ ...containers[0], name: 'gary-longjob-owned' }], stats)).toThrow('unavailable');
  expect(() => engineeringHeadroom(info, containers, [{ ...stats[0], memory: 'unknown' }])).toThrow('unavailable');
});
