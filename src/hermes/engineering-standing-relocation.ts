/** Operator-only relocation of a standing engineering grant to a new aggregate
 * file. Planning is read-only; applying writes NEW files only (no existing file
 * is edited) and never touches the spend ledger. Enrollment of the new pool is
 * a separate explicit step. */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertEngineeringRebootQuiescent } from './engineering-reboot-quiescence.ts';
import { standingReconciliationAmounts } from './engineering-standing-reconciliation.ts';
import { planStandingFundingTransfer, type StandingFundingTransferPlan } from './engineering-standing-funding.ts';
import { parseStandingEngineeringConfig, type StandingEngineeringRuntimeConfig } from './standing-engineering-config.ts';

function fail(code: string): never { throw new Error('engineering_standing_relocation:' + code); }
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** What the old pool must keep: every committed task cap net of reviewed releases,
 * plus its conversation/auxiliary charges. Refuses anything unresolved. */
export function standingPoolRetainedMicros(spendDb: Database, config: StandingEngineeringRuntimeConfig): number {
  const a = config.funding;
  if (!hasTable(spendDb, 'standing_engineering_pools')) fail('pool_not_enrolled');
  const pool = spendDb.query('SELECT campaign_id FROM standing_engineering_pools WHERE pool_id=?').get(a.poolId) as { campaign_id: string } | null;
  if (!pool || pool.campaign_id !== a.campaignId) fail('pool_not_enrolled');
  if (hasTable(spendDb, 'standing_engineering_conversation_leases')
      && spendDb.query('SELECT 1 FROM standing_engineering_conversation_leases WHERE pool_id=? AND end_attempt_id IS NULL').get(a.poolId)) fail('conversation_lease_open');
  if (spendDb.query(`SELECT 1 FROM spend_attempts x JOIN spend_tickets t ON t.ticket_id=x.ticket_id WHERE t.campaign_id=? AND x.state<>'settled'`).get(a.campaignId)) fail('unsettled_attempt');
  const gross = (spendDb.query('SELECT COALESCE(SUM(cap_micros),0) n FROM spend_tickets WHERE campaign_id=?').get(a.campaignId) as { n: number }).n;
  const charged = (spendDb.query(`SELECT COALESCE(SUM(x.charged_micros),0) n FROM spend_attempts x JOIN spend_tickets t ON t.ticket_id=x.ticket_id WHERE t.campaign_id=?`).get(a.campaignId) as { n: number }).n;
  const { released, auxiliary } = standingReconciliationAmounts(spendDb, a);
  const retained = gross - released + auxiliary;
  if (!Number.isSafeInteger(retained) || retained < charged || retained > a.capMicros) fail('pool_accounting');
  return retained;
}

export interface StandingRelocationInput {
  config: StandingEngineeringRuntimeConfig; configPath: string;
  journalDb: Database; spendDb: Database; ledgerPath: string;
  listLabelledContainers: () => readonly string[];
  approvalEvidenceSha256: string;
  targetDirectory: string; next: { poolId: string; campaignId: string; taskCapMicros?: number };
  now: Date;
}
export interface StandingRelocationPlan extends StandingFundingTransferPlan {
  retainedMicros: number;
  newConfigPath: string; newConfigBytes: Buffer; newConfigSha256: string;
  tombstonePath: string; tombstoneBytes: Buffer;
  quiescence: Readonly<Record<string, number>>;
}

/** Read-only. Proves nothing is in flight, then computes every new file. */
export function planStandingRelocation(i: StandingRelocationInput): StandingRelocationPlan {
  const quiescence = assertEngineeringRebootQuiescent({ journalDb: i.journalDb, spendDb: i.spendDb, listLabelledContainers: i.listLabelledContainers });
  const retainedMicros = standingPoolRetainedMicros(i.spendDb, i.config);
  // No symlinked ancestors: the nearest existing ancestor must already be canonical.
  let ancestor = dirname(i.targetDirectory);
  for (;;) { try { lstatSync(ancestor); break; } catch { ancestor = dirname(ancestor); } }
  if (realpathSync(ancestor) !== ancestor) fail('target_parent');
  try { lstatSync(i.targetDirectory); fail('target_exists'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const sourceAggregateBytes = readFileSync(i.config.aggregatePath);
  const plan = planStandingFundingTransfer({ sourceAggregateBytes, sourceAggregatePath: i.config.aggregatePath,
    retired: { poolId: i.config.funding.poolId, authoritySha256: i.config.funding.authoritySha256, capMicros: i.config.funding.capMicros },
    retainedMicros, next: { poolId: i.next.poolId, campaignId: i.next.campaignId, taskCapMicros: i.next.taskCapMicros ?? i.config.funding.taskCapMicros },
    ledgerPath: i.ledgerPath, approvalEvidenceSha256: i.approvalEvidenceSha256, directory: i.targetDirectory,
    aggregatePath: join(i.targetDirectory, 'aggregate.json'), now: i.now });
  const raw = JSON.parse(readFileSync(i.configPath, 'utf8'));
  const next = { ...raw, funding: plan.authority, fundingAuthorityPath: plan.fundingAuthorityPath,
    fundingHoldReceiptPath: plan.fundingHoldReceiptPath, aggregatePath: plan.aggregatePath };
  parseStandingEngineeringConfig(next);
  const newConfigBytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  const stamp = i.now.toISOString().slice(0, 10).replaceAll('-', '');
  const tombstonePath = i.config.aggregatePath + '.admission.lock';
  const tombstoneBytes = Buffer.from(JSON.stringify({ version: 1, kind: 'standing_engineering_aggregate_transferred',
    transferredTo: plan.aggregatePath, retiredPoolId: i.config.funding.poolId, sourceSha256: sha(sourceAggregateBytes),
    note: 'Gary budget writers create this lock directory exclusively; its presence stops further admissions against this file.' }, null, 2) + '\n');
  return { ...plan, retainedMicros, quiescence,
    newConfigPath: join(dirname(i.configPath), basename(i.configPath, '.json') + '-relocated-' + stamp + '.json'),
    newConfigBytes, newConfigSha256: sha(newConfigBytes), tombstonePath, tombstoneBytes };
}

function writeNew(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { if (writeSync(fd, bytes) !== bytes.length) fail('short_write'); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** Writes only new paths (exclusive create); fails before writing if any exists. */
export function applyStandingRelocation(plan: StandingRelocationPlan, targetDirectory: string): void {
  for (const path of [plan.newConfigPath, plan.tombstonePath]) {
    try { lstatSync(path); fail('exists:' + path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  mkdirSync(dirname(targetDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(targetDirectory, { mode: 0o700 });
  for (const file of plan.files) writeNew(file.path, file.bytes);
  syncDirectory(targetDirectory);
  writeNew(plan.newConfigPath, plan.newConfigBytes); syncDirectory(dirname(plan.newConfigPath));
  mkdirSync(plan.tombstonePath, { mode: 0o700 });
  writeNew(join(plan.tombstonePath, 'transferred.json'), plan.tombstoneBytes); syncDirectory(dirname(plan.tombstonePath));
}
