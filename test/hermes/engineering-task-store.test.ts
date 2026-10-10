import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { EngineeringTaskStore, engineeringScopeKey, type EngineeringTaskSpec } from '../../src/hermes/engineering-task-store.ts';
const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const scope = { teamId: 'team', surface: 'private_dm' as const, audienceId: 'owner', projectId: 'project' };
function setup() {
  const db = new Database(':memory:'); dbs.push(db);
  let now = 1000;
  return { db, store: new EngineeringTaskStore(db, () => now), advance() { now = 100_000; } };
}
const spec = (requestId = 'request'): EngineeringTaskSpec => ({ taskId: 'task-' + requestId, requestId, grantId: 'grant', scope,
  repositoryId: 'repo-1', repository: '707-Labs/example', baseCommit: 'a'.repeat(40),
  policyHash: 'sha256:' + 'b'.repeat(64), allocationId: 'allocation', deadlineMs: 10_000 });
const allowed = () => {};
describe('dormant engineering task ownership', () => {
  test('admission is idempotent, rejects changed event replay and does not reopen completed work', () => {
    const { store } = setup(); const first = store.admit(spec(), allowed);
    expect(store.admit(spec(), allowed).taskId).toBe(first.taskId);
    expect(() => store.admit({ ...spec(), baseCommit: 'c'.repeat(40) }, allowed)).toThrow('replay_conflict');
    const running = store.claim(first.taskId, allowed);
    store.finish(first.taskId, running.ownerEpoch!, 'completed', () => ({ receiptId: 'clean-1', taskId: running.taskId, sessionId: running.sessionId!, ownerEpoch: running.ownerEpoch!, absent: true }));
    expect(store.admit(spec(), allowed).state).toBe('completed');
    expect(() => store.claim(first.taskId, allowed)).toThrow('not_claimable');
  });
  test('uncertain cleanup survives a replacement store/owner and fences the execution slot', () => {
    const { store, db } = setup(); const a = store.claim(store.admit(spec(), allowed).taskId, allowed);
    const b = store.admit(spec('request-2'), allowed);
    store.cleanupUnknown(a.taskId, a.ownerEpoch!, { containerId: 'opaque-id' });
    const restarted = new EngineeringTaskStore(db, () => 1000);
    expect(() => restarted.claim(b.taskId, allowed)).toThrow('execution_slot_busy');
    expect(() => restarted.claim(a.taskId, allowed)).toThrow('not_claimable');
    expect(() => restarted.finish(a.taskId, 'wrong-owner', 'paused', () => ({ receiptId: 'bad', taskId: a.taskId, sessionId: a.sessionId!, ownerEpoch: a.ownerEpoch!, absent: true }))).toThrow('owner_mismatch');
    restarted.finish(a.taskId, a.ownerEpoch!, 'paused', () => ({ receiptId: 'verified-cleanup', taskId: a.taskId, sessionId: a.sessionId!, ownerEpoch: a.ownerEpoch!, absent: true }));
    const next = restarted.claim(a.taskId, allowed);
    expect(next.ownerEpoch).not.toBe(a.ownerEpoch);
    expect(() => restarted.finish(a.taskId, next.ownerEpoch!, 'completed', () => ({ receiptId: 'old-binding', taskId: a.taskId, sessionId: a.sessionId!, ownerEpoch: a.ownerEpoch!, absent: true }))).toThrow('cleanup_unconfirmed');
    expect(() => restarted.finish(next.taskId, next.ownerEpoch!, 'completed', () => ({ receiptId: 'verified-cleanup', taskId: next.taskId, sessionId: next.sessionId!, ownerEpoch: next.ownerEpoch!, absent: true }))).toThrow('cleanup_receipt_reused');
    expect(() => restarted.assertOwner(a.taskId, a.ownerEpoch!)).toThrow('owner_inactive');
  });
  test('audience surface and project are part of the key, and status never claims liveness', () => {
    const { store } = setup(); const task = store.admit(spec(), allowed);
    expect(store.get(task.taskId, { ...scope, surface: 'shared_channel' })).toBeNull();
    expect(store.get(task.taskId, { ...scope, projectId: 'other' })).toBeNull();
    expect(store.get(task.taskId, scope)?.workerState).toBe('not_observed');
    expect(engineeringScopeKey(scope)).not.toBe(engineeringScopeKey({ ...scope, surface: 'shared_channel' }));
  });
  test('expired pause cannot renew deadline and authorization callback runs again before claim', () => {
    const { store, advance } = setup(); const task = store.admit(spec(), allowed);
    expect(() => store.claim(task.taskId, () => { throw new Error('revoked'); })).toThrow('revoked');
    advance(); expect(() => store.claim(task.taskId, allowed)).toThrow('deadline');
  });
  test('failed authorization/cleanup do not manufacture durable admission or release slot', () => {
    const { store, db } = setup();
    expect(() => store.admit(spec(), () => { throw new Error('no grant'); })).toThrow('no grant');
    expect(db.query('SELECT COUNT(*) n FROM engineering_tasks').get()).toEqual({ n: 0 });
    const task = store.claim(store.admit(spec(), allowed).taskId, allowed);
    expect(() => store.finish(task.taskId, task.ownerEpoch!, 'completed', () => { throw new Error('daemon unavailable'); })).toThrow('daemon unavailable');
    expect(store.get(task.taskId, scope)?.cleanupConfirmed).toBe(false);
  });
});
