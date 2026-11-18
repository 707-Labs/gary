import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteEngineeringSessionJournal } from '../../src/executors/engineering-session-journal.ts';
import { EngineeringSession, type EngineeringSessionJournal, type EngineeringSessionRecord,
  type EngineeringTaskJournal } from '../../src/executors/engineering-session.ts';

const binding = { taskId: 'task-1', sessionId: 'session-1', ownerEpoch: 'owner-1', admissionId: 'admission-1' };
const containerId = 'a'.repeat(64);
const directories: string[] = [];
const connections: Database[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function open(file?: string) {
  if (!file) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gary-engineering-journal-')));
    directories.push(directory); file = join(directory, 'fixture.sqlite');
  }
  const db = new Database(file, { strict: true }); connections.push(db);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
  return { db, file, journal: createSqliteEngineeringSessionJournal(db) };
}
function sessionRecord(): EngineeringSessionRecord {
  return { binding: { ...binding }, phase: 'starting', containerId: null, containerName: 'gary-longjob-fixture',
    deadlineMs: 60_000, workspaceRoot: '/isolated/fixture', image: 'sha256:' + 'b'.repeat(64),
    resourceProfile: { cpus: 4, memoryMiB: 12288 },
    dockerBinary: '/usr/local/bin/docker', dockerHost: 'unix:///var/run/docker.sock', daemonId: null, guardian: null };
}
function seed(journal: EngineeringSessionJournal) {
  journal.transaction(binding.taskId, state => {
    state.activeSessionId = binding.sessionId;
    state.sessions[binding.sessionId] = sessionRecord();
    state.operations['session-1/operation-1'] = true;
    state.receipts.push({ ...binding, receiptId: 'receipt-1', at: 1000, event: 'session_create_intent' });
  });
}
function snapshot(journal: EngineeringSessionJournal): EngineeringTaskJournal {
  return journal.transaction(binding.taskId, state => structuredClone(state));
}
function dormantSession(journal: EngineeringSessionJournal, onCall: () => void) {
  return new EngineeringSession({ binding: { ...binding, sessionId: 'replacement', ownerEpoch: 'owner-2' },
    workspaceRoot: '/isolated/fixture', image: 'sha256:' + 'b'.repeat(64), deadlineMs: 60_000,
    now: () => 1000, validateWorkspace: () => {}, assertOwner: () => {}, journal,
    runner: { synthetic: true, run: async () => { onCall(); throw new Error('fixture_must_not_run'); },
      start: async () => { onCall(); throw new Error('fixture_must_not_run'); } } });
}

describe('durable engineering session journal', () => {
  it('retains exact context, receipts and consumed operations across closing and reopening the database', () => {
    const first = open(); seed(first.journal);
    first.journal.transaction(binding.taskId, state => {
      const session = state.sessions[binding.sessionId]!;
      session.containerId = containerId; session.daemonId = 'daemon-1';
      session.guardian = { directory: '/protected/guardian', databasePath: '/protected/guardian/jobs.sqlite',
        journalId: 'journal-1', invocationId: 'invocation-1', pid: 123 };
      session.phase = 'active';
    });
    const expected = snapshot(first.journal); first.db.close(); connections.splice(connections.indexOf(first.db), 1);
    const reopened = open(first.file);
    expect(snapshot(reopened.journal)).toEqual(expected);
    expect(reopened.db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
  });

  it('a reopened active session blocks replacement without a command or blind replay', async () => {
    const first = open(); seed(first.journal); const second = open(first.file);
    let calls = 0; const session = dormantSession(second.journal, () => { calls++; });
    await expect(session.operation({ operation: 'execute', arguments: {
      binding: session.binding, operationId: 'replacement-attempt', command: 'fixture', timeoutMs: 1000,
    } })).rejects.toThrow('reconciliation_required');
    expect(calls).toBe(0); expect(snapshot(second.journal).activeSessionId).toBe(binding.sessionId);
  });

  it('uncertainty persists through a fresh connection and rejects replacement owner execution', async () => {
    const first = open(); seed(first.journal);
    first.journal.transaction(binding.taskId, state => { state.cleanupUncertain = true; state.sessions[binding.sessionId]!.phase = 'uncertain'; });
    const second = open(first.file); let calls = 0; const session = dormantSession(second.journal, () => { calls++; });
    await expect(session.operation({ operation: 'execute', arguments: {
      binding: session.binding, operationId: 'replacement-attempt', command: 'fixture', timeoutMs: 1000,
    } })).rejects.toThrow('cleanup_uncertain');
    expect(calls).toBe(0);
    expect(() => second.journal.transaction(binding.taskId, state => { state.cleanupUncertain = false; state.sessions[binding.sessionId]!.phase = 'starting'; }))
      .toThrow('uncertainty_is_sticky');
  });

  it('integrates session execution and atomic cleanup using a synthetic runner only', async () => {
    const f = open(); let stopped = false;
    const session = new EngineeringSession({ binding, journal: f.journal, workspaceRoot: '/isolated/fixture',
      image: 'sha256:' + 'b'.repeat(64), deadlineMs: 60_000, now: () => 1000,
      assertOwner: () => {}, validateWorkspace: () => {},
      runner: { synthetic: true, async run(invocation) {
        let output = '';
        if (invocation.argv[1] === 'create') output = containerId;
        else if (invocation.argv[1] === 'inspect') output = JSON.stringify({ Id: containerId, Config: { Labels: {
          'gary.task': binding.taskId, 'gary.session': binding.sessionId, 'gary.owner': binding.ownerEpoch, 'gary.admission': binding.admissionId,
        } } });
        else if (!['start', 'rm', 'ps'].includes(invocation.argv[1]!)) throw new Error('unexpected_fixture_command');
        return { output, outputTruncated: false, exitCode: 0, timedOut: false };
      }, async start() { return {
        async poll() { return { running: !stopped, exitCode: stopped ? 137 : null, timedOut: false }; },
        async read() { return { output: 'fixture', outputTruncated: false }; },
        async stop() { stopped = true; },
      }; } },
    });
    const started = await session.operation({ operation: 'execute', arguments: {
      binding, operationId: 'execute-1', command: 'fixture-only', timeoutMs: 5000,
    } });
    expect(started.status).toBe('running');
    expect(snapshot(f.journal).sessions[binding.sessionId]!.phase).toBe('active');
    expect(await session.operation({ operation: 'close', arguments: { binding, operationId: 'close-1' } }))
      .toMatchObject({ status: 'closed', cleanupConfirmed: true });
    const state = snapshot(open(f.file).journal);
    expect(stopped).toBe(true); expect(state.activeSessionId).toBeNull();
    expect(state.sessions[binding.sessionId]!.phase).toBe('closed');
    expect(state.receipts.some(receipt => receipt.event === 'session_cleanup_confirmed')).toBe(true);
  });

  it('callback errors and returned mutable references cannot change committed state', () => {
    const f = open(); seed(f.journal);
    const before = snapshot(f.journal);
    expect(() => f.journal.transaction(binding.taskId, state => { state.cleanupUncertain = true; throw new Error('fixture_failure'); })).toThrow('fixture_failure');
    const escaped = f.journal.transaction(binding.taskId, state => state);
    escaped.cleanupUncertain = true; escaped.receipts.length = 0;
    expect(snapshot(f.journal)).toEqual(before);
  });

  it('rejects async callbacks and outer transactions that could return before durable commit', () => {
    const f = open();
    expect(() => f.journal.transaction(binding.taskId, async state => { state.cleanupUncertain = true; })).toThrow('async_callback_forbidden');
    expect(snapshot(f.journal).cleanupUncertain).toBe(false);
    expect(() => f.db.transaction(() => f.journal.transaction(binding.taskId, () => {}))()).toThrow('outer_transaction_forbidden');
    expect(() => f.db.transaction(() => createSqliteEngineeringSessionJournal(f.db))()).toThrow('outer_transaction_forbidden');
  });

  it('rejects non-durable databases and detects durability changes before invoking the callback', () => {
    const memory = new Database(':memory:'); connections.push(memory);
    expect(() => createSqliteEngineeringSessionJournal(memory)).toThrow('durability_required');
    const f = open(); let called = false; f.db.exec('PRAGMA synchronous=OFF');
    expect(() => f.journal.transaction(binding.taskId, () => { called = true; })).toThrow('durability_required');
    expect(called).toBe(false);
  });

  it.each(['{', JSON.stringify({ taskId: binding.taskId }), JSON.stringify({ taskId: binding.taskId,
    cleanupUncertain: false, activeSessionId: 'missing', sessions: {}, operations: {}, receipts: [] })])
  ('preserves corrupt state and refuses to invoke a callback (%s)', corrupt => {
    const f = open(); f.db.query('INSERT INTO engineering_session_journal_v1 VALUES(?,?,?)')
      .run(binding.taskId, corrupt, createHash('sha256').update(corrupt).digest('hex'));
    let called = false;
    expect(() => f.journal.transaction(binding.taskId, () => { called = true; })).toThrow('invalid_state');
    expect(called).toBe(false);
    expect(f.db.query('SELECT state_json FROM engineering_session_journal_v1 WHERE task_id=?').get(binding.taskId)).toEqual({ state_json: corrupt });
  });

  it('detects a changed but otherwise well-formed stored snapshot before invoking the callback', () => {
    const f = open(); seed(f.journal);
    const changed = snapshot(f.journal); changed.sessions[binding.sessionId]!.deadlineMs++;
    f.db.query('UPDATE engineering_session_journal_v1 SET state_json=? WHERE task_id=?').run(JSON.stringify(changed), binding.taskId);
    let called = false;
    expect(() => f.journal.transaction(binding.taskId, () => { called = true; })).toThrow('integrity_mismatch');
    expect(called).toBe(false);
  });

  it('rejects identity rewrites, removed operations and altered receipts', () => {
    const f = open(); seed(f.journal);
    f.journal.transaction(binding.taskId, state => { state.sessions[binding.sessionId]!.containerId = containerId; });
    expect(() => f.journal.transaction(binding.taskId, state => { state.sessions[binding.sessionId]!.containerId = 'c'.repeat(64); })).toThrow('identity_changed');
    expect(() => f.journal.transaction(binding.taskId, state => { state.sessions[binding.sessionId]!.deadlineMs++; })).toThrow('identity_changed');
    expect(() => f.journal.transaction(binding.taskId, state => { state.sessions[binding.sessionId]!.resourceProfile = { cpus: 2, memoryMiB: 4096 }; })).toThrow('identity_changed');
    expect(() => f.journal.transaction(binding.taskId, state => { delete state.operations['session-1/operation-1']; })).toThrow('history_changed');
    expect(() => f.journal.transaction(binding.taskId, state => { state.receipts = []; })).toThrow('history_changed');
    expect(snapshot(f.journal).sessions[binding.sessionId]!.containerId).toBe(containerId);
  });

  it.each([
    undefined, null, { cpus: 0, memoryMiB: 4096 }, { cpus: 5, memoryMiB: 4096 },
    { cpus: 1.5, memoryMiB: 4096 }, { cpus: 1, memoryMiB: 255 }, { cpus: 1, memoryMiB: 12289 },
    { cpus: 1, memoryMiB: 4096.5 }, { cpus: 1, memoryMiB: 4096, extra: true },
  ])('rejects missing or invalid durable resource profiles (%j)', resourceProfile => {
    const f = open();
    expect(() => f.journal.transaction(binding.taskId, state => {
      state.activeSessionId = binding.sessionId;
      state.sessions[binding.sessionId] = { ...sessionRecord(), resourceProfile } as EngineeringSessionRecord;
    })).toThrow('invalid_state');
    expect(snapshot(f.journal).sessions).toEqual({});
  });

  it('persists a selected executor profile unchanged across reopening', () => {
    const first = open();
    first.journal.transaction(binding.taskId, state => {
      state.activeSessionId = binding.sessionId;
      state.sessions[binding.sessionId] = { ...sessionRecord(), resourceProfile: { cpus: 2, memoryMiB: 4096 } };
    });
    expect(snapshot(open(first.file).journal).sessions[binding.sessionId]!.resourceProfile).toEqual({ cpus: 2, memoryMiB: 4096 });
  });

  it('requires the closed transition and exact cleanup receipt in one transaction', () => {
    const f = open(); seed(f.journal);
    expect(() => f.journal.transaction(binding.taskId, state => {
      state.sessions[binding.sessionId]!.phase = 'closed'; state.activeSessionId = null;
    })).toThrow('cleanup_receipt_required');
    f.journal.transaction(binding.taskId, state => {
      state.sessions[binding.sessionId]!.phase = 'closed'; state.activeSessionId = null;
      state.receipts.push({ ...binding, receiptId: 'cleanup-receipt', event: 'session_cleanup_confirmed', at: 1001 });
    });
    expect(snapshot(open(f.file).journal).activeSessionId).toBeNull();
  });

  it('failed terminal persistence leaves the previous active session across a fresh connection', () => {
    const f = open(); seed(f.journal);
    f.db.exec("CREATE TRIGGER fixture_disk_failure BEFORE UPDATE ON engineering_session_journal_v1 BEGIN SELECT RAISE(ABORT, 'fixture_disk_failed'); END");
    expect(() => f.journal.transaction(binding.taskId, state => {
      state.sessions[binding.sessionId]!.phase = 'closed'; state.activeSessionId = null;
      state.receipts.push({ ...binding, receiptId: 'cleanup-receipt', event: 'session_cleanup_confirmed', at: 1001 });
    })).toThrow('fixture_disk_failed');
    expect(() => f.journal.transaction(binding.taskId, state => { state.cleanupUncertain = true; })).toThrow('fixture_disk_failed');
    f.db.exec('DROP TRIGGER fixture_disk_failure');
    const reopened = open(f.file);
    expect(snapshot(reopened.journal).activeSessionId).toBe(binding.sessionId);
    expect(snapshot(reopened.journal).receipts).toHaveLength(1);
  });

  it('separate connections see each other’s committed history and keep tasks isolated', () => {
    const first = open(); seed(first.journal); const second = open(first.file);
    second.journal.transaction(binding.taskId, state => { state.operations['session-1/operation-2'] = true; });
    expect(Object.keys(snapshot(first.journal).operations)).toHaveLength(2);
    first.journal.transaction('different-task', state => { state.cleanupUncertain = true; });
    expect(snapshot(second.journal).cleanupUncertain).toBe(false);
    expect(second.journal.transaction('different-task', state => state.cleanupUncertain)).toBe(true);
  });
});
