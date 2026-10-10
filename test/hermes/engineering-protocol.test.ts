import { describe, expect, test } from 'bun:test';
import { EngineeringProtocol, type EngineeringProtocolReceipt } from '../../src/hermes/engineering-protocol.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';
const token = 'x'.repeat(48);
function setup() {
  let owner = true, cleanup = true, writes = 0, failAppend = false, closes = 0, invalidResult = false;
  const calls: string[] = [], receipts: EngineeringProtocolReceipt[] = [], fences: string[] = [];
  const binding = { taskId: 'task', sessionId: 'session', ownerEpoch: 'owner', deadlineMs: 10_000 };
  const protocol = new EngineeringProtocol({ binding, transportCapability: token, allowedTools: ['terminal', 'read_file'],
    now: () => 1000, assertOwner: () => { if (!owner) throw new Error('revoked'); },
    append: r => { if (failAppend) throw new Error('disk full'); receipts.push(r); },
    fence: reason => fences.push(reason), close: async () => { closes++; return { cleanupConfirmed: cleanup }; },
    execute: async (op) => { calls.push(op); return op === 'execute' ? invalidResult ? {} : { processId: 'process-' + ++writes } : { stdout: 'ok', returncode: 0 }; } });
  protocol.observeTurn('turn');
  let sequence = 0;
  // Worker frames deliberately do not carry the host-only deadline.
  const frame = (kind: string, payload: Record<string, unknown>, overrides = {}) => {
    const { deadlineMs: _, ...identity } = binding;
    return { protocol: 'gary.engineering.v1', ...identity, turnId: 'turn', sequence: ++sequence, kind, payload, ...overrides };
  };
  const accept = (kind: string, payload: Record<string, unknown>, overrides = {}) => protocol.accept(frame(kind, payload, overrides), token);
  const observed = (id = 'call') => protocol.observeToolCall({ turnId: 'turn', toolCallId: id, toolName: 'terminal', originalArgs: { command: 'bun test' } });
  return { protocol, accept, frame, observed, calls, receipts, fences,
    closes: () => closes, invalidResult() { invalidResult = true; }, revoke() { owner = false; }, ambiguousCleanup() { cleanup = false; }, failAppend() { failAppend = true; } };
}
const begin = (toolCallId = 'call') => ({ toolCallId, toolName: 'terminal', originalArgs: { command: 'bun test' }, effectiveArgs: { command: 'bun test' } });
describe('native engineering protocol', () => {
  test('actual host-observed call obtains nested execution receipts and result binding', async () => {
    const s = setup(); s.observed(); const admission = await s.accept('tool.begin', begin());
    const call = { toolCallId: 'call', admissionId: admission.admissionId };
    const run = await s.accept('environment.operation', { ...call, operation: 'execute', arguments: { operationId: 'op1', command: 'wrapped by native Hermes' } });
    const poll = await s.accept('environment.operation', { ...call, operation: 'poll', arguments: { operationId: 'op2', processId: run.processId } });
    expect(run.ok).toBe(true); expect(poll.stdout).toBe('ok');
    expect(await s.accept('tool.end', { ...call, status: 'completed', resultHash: fingerprintJson('ok').sha256,
      operationReceipts: [run.receiptId, poll.receiptId] })).toMatchObject({ ok: true });
    expect(s.calls).toEqual(['execute', 'poll']);
    expect(s.receipts.map(r => r.kind)).toEqual(['turn', 'tool_begin', 'operation_start', 'operation_result', 'operation_start', 'operation_result', 'tool_completed']);
    expect(JSON.stringify(s.receipts)).not.toContain('bun test');
  });
  test('a worker cannot invent observed calls, effective arguments or process ownership', async () => {
    const s = setup();
    expect(await s.accept('tool.begin', begin())).toMatchObject({ ok: false });
    s.observed();
    expect(await s.accept('tool.begin', { ...begin(), effectiveArgs: { command: 'curl evil' } })).toMatchObject({ ok: false });
    const admission = await s.accept('tool.begin', begin());
    expect(await s.accept('environment.operation', { toolCallId: 'call', admissionId: admission.admissionId,
      operation: 'cancel', arguments: { operationId: 'op1', processId: 'another-session-process' } })).toMatchObject({ ok: false });
    expect(s.calls).toHaveLength(0);
  });
  test('transport, session and frame replay are rejected without executing twice', async () => {
    const s = setup(); s.observed();
    const frame = s.frame('tool.begin', begin());
    expect(await s.protocol.accept(frame, 'bad')).toMatchObject({ ok: false });
    const admission = await s.protocol.accept(frame, token); expect(admission.ok).toBe(true);
    expect(await s.protocol.accept(frame, token)).toMatchObject({ ok: false });
    expect(await s.accept('environment.operation', { toolCallId: 'call', admissionId: admission.admissionId, operation: 'execute',
      arguments: { operationId: 'operation', command: 'touch harmless' } }, { sessionId: 'foreign' })).toMatchObject({ ok: false });
    expect(s.calls).toHaveLength(0);
  });
  test('receipt failure blocks effects; revoked owner can only close its existing session', async () => {
    const s = setup(); s.observed(); const admission = await s.accept('tool.begin', begin()); s.failAppend();
    expect(await s.accept('environment.operation', { toolCallId: 'call', admissionId: admission.admissionId, operation: 'execute', arguments: { operationId: 'op' } })).toMatchObject({ ok: false });
    expect(s.calls).toHaveLength(0); expect(s.fences).toContain('receipt_persistence_failed');
    const r = setup(); r.revoke();
    expect(await r.accept('tool.begin', begin())).toMatchObject({ ok: false });
    expect(await r.accept('session.close', {})).toMatchObject({ ok: true, cleanupConfirmed: true });
  });
  test('cleanup uncertainty is explicit and fences the host task', async () => {
    const s = setup(); s.ambiguousCleanup();
    expect(await s.accept('session.close', {})).toEqual({ ok: false, error: 'engineering_protocol:cleanup_unknown' });
    expect(s.fences).toEqual(['cleanup_unknown']);
  });
});

test('malformed post-effect executor result fences subsequent operations', async () => {
  const s = setup(); s.observed(); const admission = await s.accept('tool.begin', begin()); s.invalidResult();
  expect(await s.accept('environment.operation', { toolCallId: 'call', admissionId: admission.admissionId,
    operation: 'execute', arguments: { operationId: 'op1' } })).toMatchObject({ ok: false });
  expect(s.fences).toContain('operation_uncertain'); expect(s.calls).toHaveLength(1);
});
test('receipt disk failure cannot prevent physical cleanup', async () => {
  const s = setup(); s.failAppend();
  expect(await s.accept('session.close', {})).toMatchObject({ ok: false });
  expect(s.closes()).toBe(1);
});
