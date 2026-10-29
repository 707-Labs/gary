/** Read-only proof, required before re-binding the resource lock in a new boot,
 * that nothing from the previous boot is still in flight. Any doubt refuses. */
import type { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import type { EngineeringQuiescenceEvidence } from '../executors/engineering-resource-reboot.ts';

export interface EngineeringRebootQuiescenceOptions {
  readonly journalDb: Database;
  readonly spendDb: Database;
  /** IDs of non-exited containers labelled gary.task (engineering sessions). */
  readonly listLabelledContainers: () => readonly string[];
}

function fail(reason: string): never { throw new Error('engineering_runtime:reboot_not_quiescent:' + reason); }
const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const count = (db: Database, sql: string) => (db.query(sql).get() as { n: number }).n;

export function assertEngineeringRebootQuiescent(options: EngineeringRebootQuiescenceOptions): EngineeringQuiescenceEvidence {
  const { journalDb: db, spendDb: spend } = options;
  const evidence: Record<string, number> = {};
  // Every task terminal with confirmed cleanup; no task owned, preparing or queued.
  if (hasTable(db, 'engineering_tasks')) {
    if (count(db, "SELECT COUNT(*) n FROM engineering_tasks WHERE state NOT IN ('completed','blocked','paused') OR cleanup_confirmed<>1")) fail('task');
    evidence.terminalTasks = count(db, 'SELECT COUNT(*) n FROM engineering_tasks');
  }
  if (hasTable(db, 'engineering_ingress_requests')
      && count(db, "SELECT COUNT(*) n FROM engineering_ingress_requests WHERE stage NOT IN ('completed','blocked','paused')")) fail('ingress');
  if (hasTable(db, 'engineering_runtime_runs')
      && count(db, "SELECT COUNT(*) n FROM engineering_runtime_runs WHERE launch_state<>'closed'")) fail('run');
  // A reserved or unknown paid attempt on any standing allocation keeps its hold until reconciled.
  if (hasTable(spend, 'standing_engineering_allocations')) {
    if (count(spend, `SELECT COUNT(*) n FROM spend_attempts a JOIN standing_engineering_allocations s ON s.allocation_id=a.ticket_id
      WHERE a.state<>'settled'`)) fail('spend_attempt');
    evidence.standingAllocations = count(spend, 'SELECT COUNT(*) n FROM standing_engineering_allocations');
  }
  let containers: readonly string[];
  try { containers = options.listLabelledContainers(); } catch { return fail('container_observation'); }
  if (!Array.isArray(containers)) fail('container_observation');
  if (containers.length) fail('container:' + String(containers[0]).slice(0, 64));
  evidence.labelledContainers = 0;
  return Object.freeze(evidence);
}

/** Lists engineering session containers (label gary.task) that have not exited.
 * Exited/dead ones hold no process or lock; dev.gary.executor-job is not used
 * because ordinary coding jobs carry it too. Remove leftover exited engineering
 * containers by their exact ID if you want them gone; they do not block. */
export function dockerLabelledContainerLister(dockerExecutable: string, dockerSocketPath: string): () => readonly string[] {
  return () => execFileSync(dockerExecutable,
    ['--host', 'unix://' + dockerSocketPath, 'ps', '-a', '--no-trunc', '--filter', 'label=gary.task', '--format', '{{.ID}} {{.State}}'],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map(line => line.trim().split(/\s+/)).filter(([id]) => !!id)
    .filter(([, state]) => state !== 'exited' && state !== 'dead').map(([id]) => id!);
}
