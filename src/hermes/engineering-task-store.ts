/** Dormant engineering state. The caller supplies a PRIVATE test/host database.
 * No default path, enrollment, execution, recovery or live-store migration occurs here.
 * Host-authenticated admission, not a model tool, is the only writer of task authority. */
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { fingerprintJson } from './audit-trace.ts';

export interface EngineeringScope {
  teamId: string; surface: 'private_dm' | 'shared_channel'; audienceId: string; projectId: string;
}
export interface EngineeringTaskSpec {
  taskId: string; requestId: string; grantId: string; scope: EngineeringScope;
  repositoryId: string; repository: string; baseCommit: string;
  policyHash: string; allocationId: string; deadlineMs: number;
}
export type EngineeringTaskState = 'queued' | 'running' | 'paused' | 'completed' | 'blocked' | 'cleanup_unknown';
export interface EngineeringTaskView {
  taskId: string; spec: Readonly<EngineeringTaskSpec>; scopeKey: string;
  state: EngineeringTaskState; ownerEpoch: string | null; sessionId: string | null;
  cleanupConfirmed: boolean; updatedAtMs: number;
  /** This record is history. A separate current observation establishes liveness. */
  workerState: 'not_observed';
}
interface Row {
  task_id: string; request_id: string; spec_json: string; spec_hash: string; scope_key: string;
  state: EngineeringTaskState; owner_epoch: string | null; session_id: string | null;
  cleanup_confirmed: number; updated_ms: number;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function fail(code: string): never { throw new Error('engineering_task:' + code); }
function id(value: string): void { if (typeof value !== 'string' || !ID.test(value)) fail('invalid_identity'); }
export function engineeringScopeKey(scope: EngineeringScope): string {
  if (!scope || !['private_dm', 'shared_channel'].includes(scope.surface)) fail('invalid_scope');
  for (const value of [scope.teamId, scope.audienceId, scope.projectId]) id(value);
  return fingerprintJson([scope.teamId, scope.surface, scope.audienceId, scope.projectId]).sha256;
}
function copySpec(value: EngineeringTaskSpec): EngineeringTaskSpec {
  // Fingerprinting rejects accessors, cycles and non-JSON coercions before copying.
  fingerprintJson(value);
  const spec = structuredClone(value);
  for (const value of [spec.taskId, spec.requestId, spec.grantId, spec.repositoryId, spec.allocationId]) id(value);
  engineeringScopeKey(spec.scope);
  if (!/^707-Labs\/[A-Za-z0-9._-]+$/.test(spec.repository)
      || !/^[a-f0-9]{40}$/.test(spec.baseCommit) || !/^sha256:[a-f0-9]{64}$/.test(spec.policyHash)
      || !Number.isSafeInteger(spec.deadlineMs)) fail('invalid_spec');
  return spec;
}

export class EngineeringTaskStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS engineering_tasks (
      task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL,
      spec_hash TEXT NOT NULL, scope_key TEXT NOT NULL, state TEXT NOT NULL,
      owner_epoch TEXT, session_id TEXT, cleanup_confirmed INTEGER NOT NULL,
      updated_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_task_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, owner_epoch TEXT,
        kind TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_cleanup_proofs (receipt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, owner_epoch TEXT NOT NULL);`);
  }

  private row(taskId: string): Row {
    id(taskId);
    return this.db.query<Row, [string]>('SELECT * FROM engineering_tasks WHERE task_id=?').get(taskId)
      ?? fail('task_missing');
  }
  private record(taskId: string, owner: string | null, kind: string, evidence: unknown): void {
    this.db.query('INSERT INTO engineering_task_receipts(task_id,owner_epoch,kind,evidence_hash,created_ms) VALUES(?,?,?,?,?)')
      .run(taskId, owner, kind, fingerprintJson(evidence).sha256, this.now());
  }
  private view(row: Row): EngineeringTaskView {
    const spec = JSON.parse(row.spec_json) as EngineeringTaskSpec;
    if (fingerprintJson(spec).sha256 !== row.spec_hash || engineeringScopeKey(spec.scope) !== row.scope_key) fail('record_corrupt');
    Object.freeze(spec.scope); Object.freeze(spec);
    return Object.freeze({ taskId: row.task_id, spec, scopeKey: row.scope_key, state: row.state,
      ownerEpoch: row.owner_epoch, sessionId: row.session_id, cleanupConfirmed: row.cleanup_confirmed === 1,
      updatedAtMs: row.updated_ms, workerState: 'not_observed' });
  }
  /** Read does not claim an owner, reconcile containers, or infer worker liveness. */
  get(taskId: string, scope: EngineeringScope): EngineeringTaskView | null {
    const row = this.row(taskId);
    return row.scope_key === engineeringScopeKey(scope) ? this.view(row) : null;
  }
  lookupRequest(requestId: string, scope: EngineeringScope): EngineeringTaskView | null {
    id(requestId);
    const row = this.db.query<Row, [string]>('SELECT * FROM engineering_tasks WHERE request_id=?').get(requestId);
    return row && row.scope_key === engineeringScopeKey(scope) ? this.view(row) : null;
  }
  /** Host must validate the standing grant, repository and immutable allocation first. */
  admit(input: EngineeringTaskSpec, assertAuthorized: (spec: Readonly<EngineeringTaskSpec>) => void): EngineeringTaskView {
    const spec = copySpec(input); Object.freeze(spec.scope); Object.freeze(spec);
    return this.db.transaction(() => {
      assertAuthorized(spec);
      const hash = fingerprintJson(spec).sha256;
      const old = this.db.query<Row, [string]>('SELECT * FROM engineering_tasks WHERE request_id=?').get(spec.requestId);
      if (old) {
        if (old.spec_hash !== hash) fail('request_replay_conflict');
        return this.view(old); // Never reopen an old admission, even if completed.
      }
      if (spec.deadlineMs <= this.now() || spec.deadlineMs > this.now() + 150 * 60_000) fail('deadline');
      const taskId = spec.taskId;
      this.db.query('INSERT INTO engineering_tasks VALUES(?,?,?,?,?,\'queued\',NULL,NULL,1,?)')
        .run(taskId, spec.requestId, JSON.stringify(spec), hash, engineeringScopeKey(spec.scope), this.now());
      this.record(taskId, null, 'admitted', spec);
      return this.view(this.row(taskId));
    }).immediate();
  }
  claim(taskId: string, assertAuthorized: (spec: Readonly<EngineeringTaskSpec>) => void): EngineeringTaskView {
    return this.db.transaction(() => {
      const row = this.row(taskId); const view = this.view(row); assertAuthorized(view.spec);
      if (!['queued', 'paused'].includes(row.state) || row.cleanup_confirmed !== 1) fail('task_not_claimable');
      if (view.spec.deadlineMs <= this.now()) fail('deadline');
      if (this.db.query('SELECT task_id FROM engineering_tasks WHERE state IN (\'running\',\'cleanup_unknown\') LIMIT 1').get()) fail('execution_slot_busy');
      const owner = randomUUID(), session = randomUUID();
      this.db.query('UPDATE engineering_tasks SET state=\'running\',owner_epoch=?,session_id=?,cleanup_confirmed=0,updated_ms=? WHERE task_id=?')
        .run(owner, session, this.now(), taskId);
      this.record(taskId, owner, 'claimed', { sessionId: session });
      return this.view(this.row(taskId));
    }).immediate();
  }
  assertOwner(taskId: string, ownerEpoch: string): void {
    const row = this.row(taskId);
    if (row.state !== 'running' || row.owner_epoch !== ownerEpoch || this.view(row).spec.deadlineMs <= this.now()) fail('owner_inactive');
  }
  /** Failure never frees the task/workspace/slot. A new owner cannot evade this fence. */
  cleanupUnknown(taskId: string, ownerEpoch: string, evidence: unknown): void {
    this.db.transaction(() => {
      const row = this.row(taskId);
      if (!['running', 'cleanup_unknown'].includes(row.state) || row.owner_epoch !== ownerEpoch) fail('owner_mismatch');
      this.record(taskId, ownerEpoch, 'cleanup_unknown', evidence);
      this.db.query('UPDATE engineering_tasks SET state=\'cleanup_unknown\',cleanup_confirmed=0,updated_ms=? WHERE task_id=?').run(this.now(), taskId);
    }).immediate();
  }
  /** Trusted guardian/observer callback, never exposed as a model tool. Must prove absence. */
  finish(taskId: string, ownerEpoch: string, state: 'paused' | 'completed' | 'blocked',
    confirmPhysicalCleanup: () => { receiptId: string; taskId: string; sessionId: string; ownerEpoch: string; absent: true }): EngineeringTaskView {
    return this.db.transaction(() => {
      const row = this.row(taskId);
      if (!['running', 'cleanup_unknown'].includes(row.state) || row.owner_epoch !== ownerEpoch) fail('owner_mismatch');
      if (!['paused', 'completed', 'blocked'].includes(state)) fail('terminal_state');
      const cleanup = confirmPhysicalCleanup(); id(cleanup.receiptId);
      if (cleanup.absent !== true || cleanup.taskId !== row.task_id || cleanup.sessionId !== row.session_id
          || cleanup.ownerEpoch !== row.owner_epoch) fail('cleanup_unconfirmed');
      if (this.db.query('SELECT receipt_id FROM engineering_cleanup_proofs WHERE receipt_id=?').get(cleanup.receiptId)) fail('cleanup_receipt_reused');
      this.db.query('INSERT INTO engineering_cleanup_proofs VALUES(?,?,?,?)').run(cleanup.receiptId, taskId, cleanup.sessionId, ownerEpoch);
      this.record(taskId, ownerEpoch, 'cleanup_confirmed', cleanup);
      this.db.query('UPDATE engineering_tasks SET state=?,cleanup_confirmed=1,updated_ms=? WHERE task_id=?').run(state, this.now(), taskId);
      return this.view(this.row(taskId));
    }).immediate();
  }
}
