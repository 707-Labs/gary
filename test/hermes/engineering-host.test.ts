import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createEngineeringHost, type HostEngineeringRequest, type HostEngineeringReceipt } from '../../src/hermes/engineering-host.ts';
const dbs: Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
const request: HostEngineeringRequest = { requestId: 'request', eventId: 'event', eventKey: 'event-key', messageKey: 'message',
  authority: { authenticated: true, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ', surface: 'private_dm', channelId: 'D0C7EJELQJX', threadTs: '1234.1234' },
  repository: '707-Labs/gary', task: 'Make the scoped edit and test it.' };
function fixture() {
  const db = new Database(':memory:'); dbs.push(db);
  let executions = 0, preparations = 0, failCleanup = false;
  const delivered: HostEngineeringReceipt[] = [];
  const options = { db, grantId: 'grant', allocationId: 'allocation', now: () => 1000,
    assertGrant() {}, assertBudget() {},
    async prepare(r: HostEngineeringRequest, taskId: string) {
      preparations++; return { runtime: null, spec: { taskId, requestId: r.requestId, grantId: 'grant', allocationId: 'allocation',
        scope: { teamId: r.authority.teamId, surface: r.authority.surface, audienceId: r.authority.requesterId, projectId: '707-labs:gary' },
        repositoryId: '123', repository: r.repository, baseCommit: 'a'.repeat(40), policyHash: 'sha256:' + 'b'.repeat(64), deadlineMs: 10000 } };
    },
    async execute() { executions++; return { completed: true, artifactReceiptId: 'artifact', summary: 'Verified scoped patch and tests.' }; },
    async cleanup(t: any) { if (failCleanup) throw Error('unavailable'); return { receiptId: 'cleanup', taskId: t.taskId, sessionId: t.sessionId, ownerEpoch: t.ownerEpoch, absent: true as const }; },
    async deliver(r: HostEngineeringReceipt) { delivered.push(r); },
  };
  return { host: createEngineeringHost(options), options, delivered, executions: () => executions, preparations: () => preparations, failCleanup() { failCleanup = true; } };
}
const signal = () => new AbortController().signal;
test('durable receipt precedes execution; repeated event and start never repeat paid work', async () => {
  const f = fixture(); const ack = await f.host.admit(request, signal()) as HostEngineeringReceipt;
  expect(ack.phase).toBe('admitted'); expect(f.executions()).toBe(0);
  expect(f.host.readReceipt({requestId:request.requestId,taskId:ack.taskId})).toEqual(ack);
  expect(f.host.readReceipt({requestId:request.requestId,taskId:'foreign-task'})).toBeNull();
  expect(await f.host.admit({ ...request, eventId: 'different-event', eventKey: 'different' }, signal())).toEqual(ack);
  f.host.start(ack); f.host.start(ack); await new Promise(resolve => setTimeout(resolve, 0)); await f.host.stop();
  expect(f.executions()).toBe(1); expect(f.preparations()).toBe(1);
  expect(f.delivered[0]?.status).toBe('completed'); expect(f.host.verifyReceipt(f.delivered[0]!)).toBe(true);
  expect(f.host.readReceipt({requestId:request.requestId,taskId:ack.taskId})).toEqual(f.delivered[0]!);
  expect(f.executions()).toBe(1);
  expect(f.host.verifyReceipt({ ...f.delivered[0]!, text: 'forged' })).toBe(false);
});
test('fresh host cannot adopt old ownership or reuse the acceptance allocation', async () => {
  const f = fixture(); const ack = await f.host.admit(request, signal()) as HostEngineeringReceipt;
  const restarted = createEngineeringHost(f.options); restarted.start(ack);
  expect(f.executions()).toBe(0);
  expect(await restarted.admit({ ...request, requestId: 'other', messageKey: 'other' }, signal())).toEqual({ kind: 'rejected', code: 'busy' });
  await restarted.stop(); await f.host.stop();
});
test('uncertain cleanup is reported without freeing task or claiming success', async () => {
  const f = fixture(); f.failCleanup(); const ack = await f.host.admit(request, signal()) as HostEngineeringReceipt;
  f.host.start(ack); await f.host.stop(); expect(f.delivered[0]?.status).toBe('cleanup_unknown');
  const state = f.options.db.query('SELECT state,cleanup_confirmed FROM engineering_tasks').get();
  expect(state).toEqual({ state: 'cleanup_unknown', cleanup_confirmed: 0 });
});
test('unauthenticated and shared requests cannot enter a private pilot', async () => {
  const f = fixture();
  expect(await f.host.admit({ ...request, authority: { ...request.authority, requesterId: 'other' } }, signal())).toMatchObject({ kind: 'rejected' });
  expect(await f.host.admit({ ...request, authority: { ...request.authority, surface: 'shared_channel', channelId: 'C0BBUCPN3FX' } }, signal())).toMatchObject({ kind: 'rejected' });
  expect(f.preparations()).toBe(0); await f.host.stop();
});

test('stop fences an admitted but unstarted task; invalid executor evidence never becomes success', async () => {
  const stopped = fixture(); const ack = await stopped.host.admit(request, signal()) as HostEngineeringReceipt;
  await stopped.host.stop(); stopped.host.start(ack); expect(stopped.executions()).toBe(0);
  const bad = fixture(); bad.options.execute = async () => ({ completed: true, artifactReceiptId: '', summary: 'invalid success' });
  const ack2 = await bad.host.admit(request, signal()) as HostEngineeringReceipt;
  bad.host.start(ack2); await new Promise(resolve => setTimeout(resolve, 0)); await bad.host.stop();
  expect(bad.delivered[0]?.status).toBe('blocked');
});
