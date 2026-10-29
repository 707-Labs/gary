import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { EngineeringSessionJournal, EngineeringTaskJournal } from './engineering-session.ts';

const TABLE = 'engineering_session_journal_v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const PHASES = ['starting', 'active', 'closed', 'uncertain'];

function fail(reason: string): never { throw new Error(`engineering_journal_${reason}`); }
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_state');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || !descriptor.enumerable) fail('invalid_state');
  }
  if (Object.getOwnPropertySymbols(value).length) fail('invalid_state');
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid_state');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) fail('invalid_state');
}
function positive(value: unknown, zero = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail('invalid_state');
}
function path(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f]/.test(value)) fail('invalid_state');
}
function binding(value: unknown, taskId: string, sessionId?: string): void {
  record(value); keys(value, ['taskId', 'sessionId', 'ownerEpoch', 'admissionId']);
  for (const item of Object.values(value)) id(item);
  if (value.taskId !== taskId || (sessionId !== undefined && value.sessionId !== sessionId)) fail('invalid_state');
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function checksum(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Validate both stored JSON and each proposed snapshot before committing it. */
function validate(value: unknown, taskId: string): asserts value is EngineeringTaskJournal {
  record(value); keys(value, ['taskId', 'cleanupUncertain', 'activeSessionId', 'sessions', 'operations', 'receipts']);
  if (value.taskId !== taskId || typeof value.cleanupUncertain !== 'boolean') fail('invalid_state');
  record(value.sessions); record(value.operations);
  for (const [sessionId, session] of Object.entries(value.sessions)) {
    id(sessionId); record(session);
    keys(session, ['binding', 'phase', 'containerId', 'containerName', 'deadlineMs', 'workspaceRoot', 'image',
      'dockerBinary', 'dockerHost', 'daemonId', 'guardian', 'resourceProfile']);
    binding(session.binding, taskId, sessionId);
    if (typeof session.phase !== 'string' || !PHASES.includes(session.phase)) fail('invalid_state');
    if (session.containerId !== null && (typeof session.containerId !== 'string' || !HASH.test(session.containerId))) fail('invalid_state');
    if (session.phase === 'active' && session.containerId === null) fail('invalid_state');
    if (session.phase === 'uncertain' && !value.cleanupUncertain) fail('invalid_state');
    id(session.containerName); positive(session.deadlineMs); path(session.workspaceRoot); path(session.dockerBinary);
    record(session.resourceProfile); keys(session.resourceProfile, ['cpus', 'memoryMiB']);
    positive(session.resourceProfile.cpus); positive(session.resourceProfile.memoryMiB);
    if (session.resourceProfile.cpus > 4 || session.resourceProfile.memoryMiB < 256 || session.resourceProfile.memoryMiB > 12288) fail('invalid_state');
    if (typeof session.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(session.image)) fail('invalid_state');
    if (typeof session.dockerHost !== 'string' || !session.dockerHost.startsWith('unix://')) fail('invalid_state');
    path(session.dockerHost.slice(7));
    if (session.daemonId !== null) id(session.daemonId);
    if (session.guardian !== null) {
      record(session.guardian); keys(session.guardian, ['directory', 'databasePath', 'journalId', 'invocationId', 'pid']);
      path(session.guardian.directory); path(session.guardian.databasePath);
      id(session.guardian.journalId); id(session.guardian.invocationId); positive(session.guardian.pid);
    }
  }
  if (value.activeSessionId !== null) {
    id(value.activeSessionId);
    const active = value.sessions[value.activeSessionId];
    if (!Object.hasOwn(value.sessions, value.activeSessionId) || !active || typeof active !== 'object'
      || (active as { phase: unknown }).phase === 'closed') fail('invalid_state');
  }
  for (const [operation, consumed] of Object.entries(value.operations)) {
    const parts = operation.split('/');
    if (parts.length !== 2 || parts.some(part => !ID.test(part)) || consumed !== true) fail('invalid_state');
  }
  if (!Array.isArray(value.receipts)) fail('invalid_state');
  const receiptIds = new Set<string>();
  for (const receipt of value.receipts) {
    record(receipt);
    keys(receipt, ['receiptId', 'taskId', 'sessionId', 'ownerEpoch', 'admissionId', 'at', 'event'],
      ['operationId', 'processId', 'commandHash', 'exitCode']);
    for (const key of ['receiptId', 'taskId', 'sessionId', 'ownerEpoch', 'admissionId', 'event']) id(receipt[key]);
    if (receipt.taskId !== taskId || receiptIds.has(receipt.receiptId as string)) fail('invalid_state');
    receiptIds.add(receipt.receiptId as string); positive(receipt.at, true);
    for (const key of ['operationId', 'processId']) if (Object.hasOwn(receipt, key)) id(receipt[key]);
    if (Object.hasOwn(receipt, 'commandHash') && (typeof receipt.commandHash !== 'string' || !HASH.test(receipt.commandHash))) fail('invalid_state');
    if (Object.hasOwn(receipt, 'exitCode') && receipt.exitCode !== null
      && (typeof receipt.exitCode !== 'number' || !Number.isSafeInteger(receipt.exitCode))) fail('invalid_state');
    const session = value.sessions[receipt.sessionId as string] as { binding: Record<string, unknown> } | undefined;
    if (session && ['taskId', 'sessionId', 'ownerEpoch', 'admissionId'].some(key => session.binding[key] !== receipt[key])) fail('invalid_state');
  }
}

function monotone(before: EngineeringTaskJournal, after: EngineeringTaskJournal): void {
  if (before.cleanupUncertain && !after.cleanupUncertain) fail('uncertainty_is_sticky');
  for (const [key, session] of Object.entries(before.sessions)) {
    const next = after.sessions[key];
    if (!next) fail('history_changed');
    for (const field of ['binding', 'containerName', 'deadlineMs', 'workspaceRoot', 'image', 'dockerBinary', 'dockerHost', 'resourceProfile'] as const) {
      if (!equal(session[field], next[field])) fail('identity_changed');
    }
    for (const field of ['containerId', 'daemonId', 'guardian'] as const) {
      if (session[field] !== null && !equal(session[field], next[field])) fail('identity_changed');
    }
    if ((session.phase === 'active' && next.phase === 'starting')
      || (['closed', 'uncertain'].includes(session.phase) && ['starting', 'active'].includes(next.phase))) fail('history_changed');
  }
  for (const key of Object.keys(before.operations)) if (after.operations[key] !== true) fail('history_changed');
  if (after.receipts.length < before.receipts.length
    || before.receipts.some((receipt, index) => !equal(receipt, after.receipts[index]))) fail('history_changed');
  if (before.activeSessionId !== null && before.activeSessionId !== after.activeSessionId) {
    if (after.activeSessionId !== null || after.sessions[before.activeSessionId]?.phase !== 'closed'
      || !after.receipts.slice(before.receipts.length).some(receipt => receipt.sessionId === before.activeSessionId
        && receipt.event === 'session_cleanup_confirmed')) fail('cleanup_receipt_required');
  }
}

function durable(db: Database): void {
  const sync = db.query('PRAGMA synchronous').get() as { synchronous: number };
  const mode = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
  const databases = db.query('PRAGMA database_list').all() as { name: string; file: string }[];
  if (![2, 3].includes(sync.synchronous) || !['delete', 'truncate', 'persist', 'wal'].includes(mode.journal_mode.toLowerCase())
    || !databases.some(item => item.name === 'main' && item.file.length > 0)) fail('durability_required');
}

/** Caller owns the protected on-disk Database and its lifetime. This factory
 * never opens/closes a database, relaxes PRAGMAs, reconciles, or replays work.
 * FULL/EXTRA synchronous and a durable journal mode are required on every call.
 * A transaction must be the outermost transaction: returning before the caller's
 * eventual COMMIT would violate the session's durable-before-effect contract. */
export function createSqliteEngineeringSessionJournal(db: Database): EngineeringSessionJournal {
  if (db.inTransaction) fail('outer_transaction_forbidden');
  durable(db);
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (task_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL, state_sha256 TEXT NOT NULL)`);
  return { transaction<T>(taskId: string, change: (state: EngineeringTaskJournal) => T): T {
    id(taskId);
    if (db.inTransaction) fail('outer_transaction_forbidden');
    durable(db);
    return db.transaction(() => {
      const row = db.query(`SELECT state_json,state_sha256 FROM ${TABLE} WHERE task_id=?`).get(taskId) as { state_json: string; state_sha256: string } | null;
      if (row && (typeof row.state_json !== 'string' || row.state_sha256 !== checksum(row.state_json))) fail('integrity_mismatch');
      let state: unknown;
      try { state = row ? JSON.parse(row.state_json) : { taskId, cleanupUncertain: false, activeSessionId: null, sessions: {}, operations: {}, receipts: [] }; }
      catch { return fail('invalid_state'); }
      validate(state, taskId);
      const before = structuredClone(state);
      const result = change(state);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) fail('async_callback_forbidden');
      validate(state, taskId); monotone(before, state);
      const serialized = JSON.stringify(state);
      db.query(`INSERT INTO ${TABLE}(task_id,state_json,state_sha256) VALUES(?,?,?) ON CONFLICT(task_id)
        DO UPDATE SET state_json=excluded.state_json,state_sha256=excluded.state_sha256`).run(taskId, serialized, checksum(serialized));
      return result;
    }).immediate();
  } };
}
