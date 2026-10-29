/** Read-only local Docker headroom observation. No container mutation or credential inheritance. */
import { execFile } from 'node:child_process';
import { statfsSync } from 'node:fs';
export interface EngineeringHeadroom { availableCpus: number; availableMemoryBytes: number }
export type EngineeringPreflightRunner = (args: readonly string[]) => Promise<string>;
function fail(): never { throw new Error('engineering_headroom_unavailable'); }
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function bytes(value: unknown): number {
  if (typeof value !== 'string') fail();
  const m = /^(\d+(?:\.\d+)?)(B|kB|KB|MB|GB|KiB|MiB|GiB)$/.exec(value.trim()); if (!m) fail();
  const units: Record<string, number> = { B: 1, kB: 1000, KB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  return Math.ceil(Number(m[1]) * units[m[2]!]!);
}
/** Four GiB and one CPU remain outside the engineering allowance for existing services/VM overhead. */
export function engineeringHeadroom(info: unknown, containers: unknown[], stats: unknown[]): EngineeringHeadroom {
  if (!info || typeof info !== 'object') fail();
  const d = info as Record<string, unknown>;
  if (d.daemonId !== 'e5f09239-f79d-40b7-91b2-981d1372cde5' || !number(d.cpus) || !number(d.memoryBytes)
      || !Number.isInteger(d.runningContainers) || d.runningContainers !== containers.length || stats.length !== containers.length) fail();
  const ids = new Set<string>();
  for (const raw of containers) {
    if (!raw || typeof raw !== 'object') fail(); const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || !/^[a-f0-9]{64}$/.test(c.id) || ids.has(c.id) || typeof c.name !== 'string'
        || /(?:^|\/)gary-(?:hermes-worker|longjob|engineering)/.test(c.name)) fail();
    ids.add(c.id);
  }
  let usedCpu = 0, usedMemory = 0; const seen = new Set<string>();
  for (const raw of stats) {
    if (!raw || typeof raw !== 'object') fail(); const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || !/^[a-f0-9]{12,64}$/.test(s.id) || typeof s.cpu !== 'string'
      || !/^\d+(?:\.\d+)?%$/.test(s.cpu) || typeof s.memory !== 'string') fail();
    const matches = [...ids].filter(id => id.startsWith(s.id as string));
    if (matches.length !== 1 || seen.has(matches[0]!)) fail(); seen.add(matches[0]!);
    usedCpu += Number(s.cpu.slice(0, -1)) / 100; usedMemory += bytes(s.memory.split(' / ')[0]);
  }
  return { availableCpus: Math.max(0, Math.floor(d.cpus - usedCpu - 1)),
    availableMemoryBytes: Math.max(0, Math.floor(d.memoryBytes - usedMemory - 4 * 1024 ** 3)) };
}
export function createEngineeringHeadroomReader(input: { root: string; run?: EngineeringPreflightRunner }) {
  const run = input.run ?? (async args => await new Promise<string>((yes, no) => {
    execFile('/usr/local/bin/docker', [...args], { cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent',
      DOCKER_HOST: 'unix:///Users/tanner/.colima/default/docker.sock' }, timeout: 4000, maxBuffer: 256 * 1024, encoding: 'utf8' },
    (error, stdout) => error ? no(new Error('engineering_headroom_unavailable')) : yes(stdout));
  }));
  return async (): Promise<EngineeringHeadroom> => {
    const disk = statfsSync(input.root);
    if (Number(disk.bavail) * Number(disk.bsize) < 12 * 1024 ** 3) fail();
    const [info, containers, stats] = await Promise.all([
      run(['info', '--format', '{"daemonId":"{{.ID}}","cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"runningContainers":{{.ContainersRunning}}}']),
      run(['ps', '--no-trunc', '--format', '{"id":"{{.ID}}","name":"{{.Names}}"}']),
      run(['stats', '--no-stream', '--format', '{"id":"{{.ID}}","cpu":"{{.CPUPerc}}","memory":"{{.MemUsage}}"}']),
    ]);
    const rows = (s: string) => s.trim() ? s.trim().split('\n').map(line => JSON.parse(line)) : [];
    return engineeringHeadroom(JSON.parse(info), rows(containers), rows(stats));
  };
}
