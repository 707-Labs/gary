import { describe, expect, test } from 'bun:test';
import { EngineeringProtocol, type EngineeringProtocolReceipt, type EngineeringProtocolOptions } from '../../src/hermes/engineering-protocol.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';
const token = 'x'.repeat(48);
function setup(resultPresentation?: 'native_batch', taskOperation?: EngineeringProtocolOptions['taskOperation'], codeTools?: readonly string[]) {
  let owner = true, cleanup = true, writes = 0, failAppend = false, closes = 0, invalidResult = false, now = 1000;
  const calls: string[] = [], receipts: EngineeringProtocolReceipt[] = [], fences: string[] = [];
  const contexts: Parameters<EngineeringProtocolOptions['execute']>[2][] = [];
  const binding = { taskId: 'task', sessionId: 'session', ownerEpoch: 'owner', deadlineMs: 10_000 };
  const protocol = new EngineeringProtocol({ binding, transportCapability: token,
    allowedTools: codeTools === undefined ? ['terminal', 'read_file']
      : ['terminal', 'read_file', 'write_file', 'patch', 'search_files', 'execute_code', 'delegate_task', 'process', 'memory'],
    ...(codeTools !== undefined ? { codeTools } : {}),
    ...(resultPresentation ? { resultPresentation } : {}),
    ...(taskOperation ? { taskOperation } : {}),
    now: () => now, assertOwner: () => { if (!owner) throw new Error('revoked'); },
    append: r => { if (failAppend) throw new Error('disk full'); receipts.push(r); },
    fence: reason => fences.push(reason), close: async () => { closes++; return { cleanupConfirmed: cleanup }; },
    execute: async (op, _args, context) => { calls.push(op); contexts.push(context);
      return op === 'execute' ? invalidResult ? {} : { processId: 'process-' + ++writes } : { stdout: 'ok', returncode: 0 }; } });
  protocol.observeTurn('turn');
  let sequence = 0;
  // Worker frames deliberately do not carry the host-only deadline.
  const frame = (kind: string, payload: Record<string, unknown>, overrides = {}) => {
    const { deadlineMs: _, ...identity } = binding;
    return { protocol: 'gary.engineering.v1', ...identity, turnId: 'turn', sequence: ++sequence, kind, payload, ...overrides };
  };
  const accept = (kind: string, payload: Record<string, unknown>, overrides = {}) => protocol.accept(frame(kind, payload, overrides), token);
  const observed = (id = 'call', toolName = 'terminal', originalArgs: Record<string, unknown> = { command: 'bun test' }) =>
    protocol.observeToolCall({ turnId: 'turn', toolCallId: id, toolName, originalArgs });
  return { protocol, accept, frame, observed, calls, contexts, receipts, fences,
    closes: () => closes, invalidResult() { invalidResult = true; }, revoke() { owner = false; }, expire() { now = binding.deadlineMs; },
    ambiguousCleanup() { cleanup = false; }, failAppend() { failAppend = true; } };
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

const rawResultHash = fingerprintJson('original native result').sha256;
const displayedHash = fingerprintJson('original native result\n[Tool loop warning: synthetic fixture]').sha256;
async function completed(s: ReturnType<typeof setup>, id = 'call') {
  s.observed(id);
  const admission = await s.accept('tool.begin', begin(id));
  const call = { toolCallId: id, admissionId: admission.admissionId };
  expect((await s.accept('tool.end', { ...call, status: 'completed', resultHash: rawResultHash, operationReceipts: [] })).ok).toBe(true);
  return { ...call, rawResultHash, resultHash: displayedHash };
}
test('explicit native presentation binds postprocessed output to its completed original call without execution', async () => {
  const s = setup('native_batch'), p = await completed(s);
  expect(() => s.protocol.observeTurn('next')).toThrow('turn_incomplete');
  expect(await s.accept('tool.presentation', p)).toMatchObject({ ok: true });
  expect(s.receipts.at(-1)?.kind).toBe('tool_presentation');
  expect(s.receipts.at(-1)?.digest).toBe(fingerprintJson(p).sha256);
  expect(s.calls).toHaveLength(0);
  expect(JSON.stringify(s.receipts)).not.toContain('original native result');
  expect(await s.accept('tool.presentation', p)).toMatchObject({ ok: false, error: 'engineering_protocol:tool_presentation_binding' });
  expect(() => s.protocol.observeTurn('next')).not.toThrow();
});
test('presentations reject unknown, incomplete, reordered, changed, foreign and replayed bindings', async () => {
  const s = setup('native_batch');
  const unbound = { toolCallId: 'call', admissionId: 'none', rawResultHash, resultHash: displayedHash };
  expect((await s.accept('tool.presentation', unbound)).ok).toBe(false);
  const first = await completed(s, 'first');
  s.observed('second'); const admission = await s.accept('tool.begin', begin('second'));
  expect((await s.accept('tool.presentation', first)).ok).toBe(false);
  const second = { toolCallId: 'second', admissionId: admission.admissionId, rawResultHash, resultHash: displayedHash };
  expect((await s.accept('tool.end', { toolCallId: 'second', admissionId: admission.admissionId,
    status: 'completed', resultHash: rawResultHash, operationReceipts: [] })).ok).toBe(true);
  expect((await s.accept('tool.presentation', second)).ok).toBe(false);
  for (const patch of [{ toolCallId: 'unknown' }, { admissionId: second.admissionId }, { rawResultHash: 'a'.repeat(64) },
    { resultHash: 'invalid' }, { resultHash: displayedHash + '\n' }, { command: 'unbound command' }]) {
    expect((await s.accept('tool.presentation', { ...first, ...patch })).ok).toBe(false);
  }
  const frame = s.frame('tool.presentation', first);
  expect((await s.protocol.accept({ ...frame, sessionId: 'foreign' }, token)).ok).toBe(false);
  expect((await s.protocol.accept(frame, token)).ok).toBe(true);
  expect((await s.accept('tool.presentation', second)).ok).toBe(true);
  expect(s.calls).toHaveLength(0);
});
test('legacy raw mode cannot use presentation and selected mode is host configuration only', async () => {
  const s = setup(), p = await completed(s);
  expect(s.protocol.resultPresentation).toBe('raw');
  expect((await s.accept('tool.presentation', p)).ok).toBe(false);
  expect(() => s.protocol.observeTurn('next')).not.toThrow();
});
test('presentation receipt failure and revoked ownership still permit exact existing session cleanup', async () => {
  for (const scenario of ['receipt', 'owner']) {
    const s = setup('native_batch'), p = await completed(s);
    if (scenario === 'receipt') s.failAppend(); else s.revoke();
    expect((await s.accept('tool.presentation', p)).ok).toBe(false);
    await s.accept('session.close', {});
    expect(s.closes()).toBe(1);
    expect(s.calls).toHaveLength(0);
  }
});

test('host task operation requires observed admission, consumes one use, and binds its receipt', async () => {
  const effects: unknown[] = [];
  const s = setup(undefined, async (op, args, context) => {
    effects.push({ op, args, context }); return { result: { summary: 'private child result' } };
  });
  s.observed(); const admission = await s.accept('tool.begin', begin());
  const call = { toolCallId: 'call', admissionId: admission.admissionId };
  const payload = { ...call, operation: 'delegate.run', arguments: { operationId: 'child-1', goal: 'private goal' } };
  expect((await s.accept('task.operation', { ...payload, admissionId: 'invented' })).ok).toBe(false);
  expect(effects).toHaveLength(0);
  const result = await s.accept('task.operation', payload);
  expect(result.ok).toBe(true);
  expect(effects).toEqual([{ op: 'delegate.run', args: payload.arguments,
    context: { ...call, toolName: 'terminal', originalArgs: { command: 'bun test' } } }]);
  expect((await s.accept('task.operation', payload)).ok).toBe(false);
  expect(effects).toHaveLength(1);
  const end = { ...call, status: 'completed', resultHash: fingerprintJson(result.result).sha256 };
  expect((await s.accept('tool.end', { ...end, operationReceipts: [] })).ok).toBe(false);
  expect((await s.accept('tool.end', { ...end, operationReceipts: [result.receiptId] })).ok).toBe(true);
  expect(s.receipts.map(r => r.kind)).toContain('task_operation_result');
  expect(JSON.stringify(s.receipts)).not.toContain('private');
});

test('disabled task service and failure to persist intent cannot cause task effects', async () => {
  for (const disabled of [true, false]) {
    let effects = 0;
    const s = setup(undefined, disabled ? undefined : async () => { effects++; return {}; });
    s.observed(); const admission = await s.accept('tool.begin', begin());
    if (!disabled) s.failAppend();
    expect((await s.accept('task.operation', { toolCallId: 'call', admissionId: admission.admissionId,
      operation: 'code.run', arguments: { operationId: 'code-1', code: 'private code' } })).ok).toBe(false);
    expect(effects).toBe(0);
  }
});

test('task operation uncertainty and owner revocation fence further effects but preserve cleanup', async () => {
  for (const revoke of [true, false]) {
    let effects = 0;
    const s = setup(undefined, async () => {
      effects++; if (revoke) { s.revoke(); return {}; } throw new Error('child exit unknown');
    });
    s.observed(); const admission = await s.accept('tool.begin', begin());
    const p = { toolCallId: 'call', admissionId: admission.admissionId, operation: 'delegate.run', arguments: { operationId: 'child-1' } };
    expect((await s.accept('task.operation', p)).ok).toBe(false);
    expect(s.fences).toContain('task_operation_uncertain');
    expect((await s.accept('task.operation', { ...p, arguments: { operationId: 'child-2' } })).ok).toBe(false);
    expect(effects).toBe(1);
    expect((await s.accept('session.close', {})).ok).toBe(true);
    expect(s.closes()).toBe(1);
  }
});

const coreCodeTools = ['terminal', 'read_file', 'write_file', 'patch', 'search_files'];
const codeArgs = { code: 'print("synthetic private code; never executed")' };
async function codeAdmission(s: ReturnType<typeof setup>) {
  s.observed('code-call', 'execute_code', codeArgs);
  const begin = await s.accept('tool.begin', { toolCallId: 'code-call', toolName: 'execute_code',
    originalArgs: codeArgs, effectiveArgs: codeArgs });
  expect(begin.ok).toBe(true);
  return { toolCallId: 'code-call', admissionId: begin.admissionId };
}
async function codeStarted(s: ReturnType<typeof setup>) {
  const parent = await codeAdmission(s);
  const authorized = await s.accept('code.authorize', { ...parent, codeHash: fingerprintJson(codeArgs.code).sha256 });
  expect(authorized.ok).toBe(true);
  const started = await s.accept('code.start', { ...parent, codeCapability: authorized.codeCapability });
  expect(started.ok).toBe(true);
  return { parent, authorized, started, invocation: started.codeInvocationId,
    outerReceipts: [authorized.receiptId, started.receiptId], nestedReceipts: [] as unknown[] };
}
type CodeState = Awaited<ReturnType<typeof codeStarted>>;
async function inheritedBegin(s: ReturnType<typeof setup>, state: CodeState, id = 'nested-1',
    toolName = 'read_file', originalArgs: Record<string, unknown> = { path: 'synthetic.txt' }) {
  const payload = { toolCallId: id, toolName, originalArgs, effectiveArgs: originalArgs,
    codeInvocationId: state.invocation, parentToolCallId: state.parent.toolCallId, parentAdmissionId: state.parent.admissionId };
  const result = await s.accept('tool.begin', payload);
  expect(result).toMatchObject({ ok: true, nested: true, codeInvocationId: state.invocation });
  state.nestedReceipts.push(result.receiptId);
  return { payload, call: { toolCallId: id, admissionId: result.admissionId }, begin: result };
}
async function inheritedEnd(s: ReturnType<typeof setup>, state: CodeState, call: Record<string, unknown>, receipts: unknown[] = []) {
  const result = await s.accept('tool.end', { ...call, codeInvocationId: state.invocation,
    status: 'completed', resultHash: rawResultHash, operationReceipts: receipts });
  expect(result).toMatchObject({ ok: true, nested: true, codeInvocationId: state.invocation });
  state.nestedReceipts.push(result.receiptId);
  return result;
}
async function codeEnd(s: ReturnType<typeof setup>, state: CodeState) {
  const result = await s.accept('code.end', { ...state.parent, codeInvocationId: state.invocation,
    status: 'completed', resultHash: rawResultHash, operationReceipts: state.nestedReceipts });
  expect(result.ok).toBe(true);
  state.outerReceipts.push(result.receiptId);
  return result;
}

describe('inherited native code capability', () => {
  test('native nested calls bind a flattened receipt chain and only the outer result enters presentation', async () => {
    const s = setup('native_batch', undefined, coreCodeTools), state = await codeStarted(s);
    expect(state.authorized.allowedTools).toEqual([...coreCodeTools].sort());
    expect(state.authorized.deadlineMs).toBe(10_000);
    expect(() => s.observed('invented-model-call')).toThrow('observed_call');
    expect(() => s.protocol.observeTurn('nested-model-turn')).toThrow('turn_incomplete');
    const nested = await inheritedBegin(s, state);
    const run = await s.accept('environment.operation', { ...nested.call, operation: 'execute',
      arguments: { operationId: 'nested-operation-1', command: 'synthetic private native wrapper' } });
    const poll = await s.accept('environment.operation', { ...nested.call, operation: 'poll',
      arguments: { operationId: 'nested-operation-2', processId: run.processId } });
    expect(run.ok).toBe(true); expect(poll.ok).toBe(true);
    state.nestedReceipts.push(run.receiptId, poll.receiptId);
    await inheritedEnd(s, state, nested.call, [run.receiptId, poll.receiptId]);
    expect(s.contexts[0] as unknown).toEqual({ ...nested.call, toolName: 'read_file', originalArgs: { path: 'synthetic.txt' },
      codeInvocationId: state.invocation, parentToolCallId: 'code-call', parentAdmissionId: state.parent.admissionId });
    const second = await inheritedBegin(s, state, 'nested-2', 'search_files', { pattern: 'synthetic private pattern' });
    await inheritedEnd(s, state, second.call);
    await codeEnd(s, state);
    expect((await s.accept('tool.end', { ...state.parent, status: 'completed', resultHash: rawResultHash,
      operationReceipts: state.outerReceipts })).ok).toBe(true);
    // A nested completion has no presentation entry. Only this exact outer call does.
    expect((await s.accept('tool.presentation', { ...nested.call, rawResultHash, resultHash: displayedHash })).ok).toBe(false);
    expect((await s.accept('tool.presentation', { ...state.parent, rawResultHash, resultHash: displayedHash })).ok).toBe(true);
    expect(() => s.protocol.observeTurn('next-real-model-turn')).not.toThrow();
    expect(s.receipts.map(receipt => receipt.kind)).toEqual(['turn', 'tool_begin', 'code_authorized', 'code_started',
      'code_tool_begin', 'operation_start', 'operation_result', 'operation_start', 'operation_result', 'tool_completed',
      'code_tool_begin', 'tool_completed', 'code_completed', 'tool_completed', 'tool_presentation', 'turn']);
    expect(s.calls).toEqual(['execute', 'poll']);
    expect(JSON.stringify(s.receipts)).not.toContain('synthetic private');
    expect(JSON.stringify(s.receipts)).not.toContain(String(state.authorized.codeCapability));
  });

  test('authorization requires the original observed code hash and is one-use through its whole lifetime', async () => {
    const s = setup(undefined, undefined, coreCodeTools), parent = await codeAdmission(s);
    for (const change of [{ codeHash: 'a'.repeat(64) }, { codeHash: 1 }, { codeHash: 'bad' }, { admissionId: 'foreign' },
      { codeHash: fingerprintJson(codeArgs.code).sha256, deadlineMs: 20_000 }]) {
      expect((await s.accept('code.authorize', { ...parent, codeHash: fingerprintJson(codeArgs.code).sha256, ...change })).ok).toBe(false);
    }
    const authorized = await s.accept('code.authorize', { ...parent, codeHash: fingerprintJson(codeArgs.code).sha256 });
    expect(authorized.ok).toBe(true);
    expect((await s.accept('code.authorize', { ...parent, codeHash: fingerprintJson(codeArgs.code).sha256 })).ok).toBe(false);
    expect((await s.accept('code.start', { ...parent, codeCapability: 'invented' })).ok).toBe(false);
    expect((await s.accept('code.start', { ...parent, codeCapability: authorized.codeCapability, allowedTools: ['memory'] })).ok).toBe(false);
    const started = await s.accept('code.start', { ...parent, codeCapability: authorized.codeCapability });
    expect(started.ok).toBe(true);
    expect((await s.accept('code.start', { ...parent, codeCapability: authorized.codeCapability })).ok).toBe(false);
    const end = { ...parent, codeInvocationId: started.codeInvocationId, status: 'completed', resultHash: rawResultHash, operationReceipts: [] };
    expect((await s.accept('code.end', end)).ok).toBe(true);
    expect((await s.accept('code.end', end)).ok).toBe(false);
    expect((await s.accept('code.authorize', { ...parent, codeHash: fingerprintJson(codeArgs.code).sha256 })).ok).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  test('absence disables code inheritance and explicit empty capability has no fallback', async () => {
    const disabled = setup(); disabled.observed(); const admission = await disabled.accept('tool.begin', begin());
    expect((await disabled.accept('code.authorize', { toolCallId: 'call', admissionId: admission.admissionId,
      codeHash: fingerprintJson(codeArgs.code).sha256 })).ok).toBe(false);
    const empty = setup(undefined, undefined, []), state = await codeStarted(empty);
    expect(state.authorized.allowedTools).toEqual([]);
    expect((await empty.accept('tool.begin', { toolCallId: 'nested', toolName: 'terminal',
      originalArgs: {}, effectiveArgs: {}, codeInvocationId: state.invocation,
      parentToolCallId: state.parent.toolCallId, parentAdmissionId: state.parent.admissionId })).ok).toBe(false);
    await codeEnd(empty, state);
    expect(empty.calls).toHaveLength(0);
    expect(() => setup(undefined, undefined, ['delegate_task'])).toThrow('code_configuration');
    expect(() => setup(undefined, undefined, ['terminal', 'terminal'])).toThrow('code_configuration');
  });

  test('nested begin requires exact invocation and parent binding and permits only the configured core tools', async () => {
    const s = setup(undefined, undefined, ['read_file']), state = await codeStarted(s);
    const request = { toolCallId: 'nested', toolName: 'read_file', originalArgs: { path: 'synthetic' }, effectiveArgs: { path: 'synthetic' },
      codeInvocationId: state.invocation, parentToolCallId: state.parent.toolCallId, parentAdmissionId: state.parent.admissionId };
    for (const change of [{ codeInvocationId: 'foreign' }, { parentToolCallId: 'foreign' }, { parentAdmissionId: 'foreign' },
      { toolCallId: 'code-call' }, { effectiveArgs: { path: 'changed' } }, { toolName: 'terminal' }, { toolName: 'execute_code' },
      { toolName: 'delegate_task' }, { toolName: 'memory' }, { toolName: 'process' }, { toolName: 'unknown' },
      { originalArgs: [] }, { effectiveArgs: [] }, { codeCapability: state.authorized.codeCapability }]) {
      expect((await s.accept('tool.begin', { ...request, ...change })).ok).toBe(false);
    }
    const { codeInvocationId: _, ...missing } = request;
    expect((await s.accept('tool.begin', missing)).ok).toBe(false);
    expect((await s.accept('tool.begin', { toolCallId: 'nested', toolName: 'read_file', originalArgs: {}, effectiveArgs: {} })).ok).toBe(false);
    const foreignFrame = s.frame('tool.begin', request);
    expect((await s.protocol.accept({ ...foreignFrame, ownerEpoch: 'foreign' }, token)).ok).toBe(false);
    expect((await s.protocol.accept(foreignFrame, token)).ok).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  test('nested calls cannot overlap, escalate, finish the outer call or create model results', async () => {
    let taskEffects = 0;
    const s = setup('native_batch', async () => { taskEffects++; return {}; }, coreCodeTools), state = await codeStarted(s);
    const nested = await inheritedBegin(s, state);
    expect((await s.accept('tool.begin', { ...nested.payload, toolCallId: 'overlap' })).ok).toBe(false);
    expect((await s.accept('code.authorize', { ...nested.call, codeHash: fingerprintJson(codeArgs.code).sha256 })).ok).toBe(false);
    expect((await s.accept('code.start', { ...nested.call, codeCapability: state.authorized.codeCapability })).ok).toBe(false);
    expect((await s.accept('code.end', { ...state.parent, codeInvocationId: state.invocation, status: 'completed',
      resultHash: rawResultHash, operationReceipts: state.nestedReceipts })).ok).toBe(false);
    expect((await s.accept('tool.end', { ...state.parent, status: 'completed', resultHash: rawResultHash, operationReceipts: [] })).ok).toBe(false);
    for (const operation of ['delegate.run', 'code.run']) expect((await s.accept('task.operation', { ...nested.call, operation,
      arguments: { operationId: operation.replace('.', '-') } })).ok).toBe(false);
    expect((await s.accept('tool.presentation', { ...nested.call, rawResultHash, resultHash: displayedHash })).ok).toBe(false);
    expect(() => s.observed('fabricated-model-call')).toThrow('observed_call');
    expect(taskEffects).toBe(0);
    await inheritedEnd(s, state, nested.call);
    expect((await s.accept('tool.begin', nested.payload)).ok).toBe(false);
  });

  test('nested terminal denies background, pty, notifications, watches, and force', async () => {
    const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s);
    for (const extra of [{ background: true }, { background: 'false' }, { background: 0 }, { pty: true },
      { notify_on_complete: true }, { watch_patterns: [] }, { force: true }]) {
      const originalArgs = { command: 'synthetic command', ...extra };
      expect((await s.accept('tool.begin', { toolCallId: 'nested-terminal', toolName: 'terminal', originalArgs, effectiveArgs: originalArgs,
        codeInvocationId: state.invocation, parentToolCallId: state.parent.toolCallId, parentAdmissionId: state.parent.admissionId })).ok).toBe(false);
    }
    const nested = await inheritedBegin(s, state, 'nested-terminal', 'terminal', { command: 'synthetic command', background: false, pty: false });
    await inheritedEnd(s, state, nested.call);
    expect(s.calls).toHaveLength(0);
  });

  test('code cannot bypass nested tools using outer environment or legacy task operations', async () => {
    let taskEffects = 0;
    const s = setup(undefined, async () => { taskEffects++; return {}; }, coreCodeTools), parent = await codeAdmission(s);
    for (const kind of ['environment.operation', 'task.operation']) {
      expect((await s.accept(kind, { ...parent, operation: kind === 'environment.operation' ? 'execute' : 'code.run',
        arguments: { operationId: kind.replace('.', '-'), code: codeArgs.code } })).ok).toBe(false);
    }
    expect(s.calls).toHaveLength(0); expect(taskEffects).toBe(0);
  });

  test('receipt chains reject omission, insertion, reordering and cross-level substitution', async () => {
    const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s), nested = await inheritedBegin(s, state);
    const run = await s.accept('environment.operation', { ...nested.call, operation: 'execute', arguments: { operationId: 'nested-op' } });
    expect(run.ok).toBe(true); state.nestedReceipts.push(run.receiptId);
    const end = { ...nested.call, status: 'completed', resultHash: rawResultHash, codeInvocationId: state.invocation };
    for (const operationReceipts of [[], [nested.begin.receiptId, run.receiptId], state.outerReceipts]) {
      expect((await s.accept('tool.end', { ...end, operationReceipts })).ok).toBe(false);
    }
    expect((await s.accept('tool.end', { ...end, codeInvocationId: 'foreign', operationReceipts: [run.receiptId] })).ok).toBe(false);
    await inheritedEnd(s, state, nested.call, [run.receiptId]);
    for (const operationReceipts of [[], [...state.nestedReceipts].reverse(), [...state.nestedReceipts, 'invented'], state.outerReceipts]) {
      expect((await s.accept('code.end', { ...state.parent, codeInvocationId: state.invocation,
        status: 'completed', resultHash: rawResultHash, operationReceipts })).ok).toBe(false);
    }
    await codeEnd(s, state);
    expect((await s.accept('tool.end', { ...state.parent, status: 'completed', resultHash: rawResultHash,
      operationReceipts: state.nestedReceipts })).ok).toBe(false);
    expect((await s.accept('tool.end', { ...state.parent, status: 'completed', resultHash: rawResultHash,
      operationReceipts: state.outerReceipts })).ok).toBe(true);
  });

  test('each invocation permits at most fifty nested calls and cannot authorize a second invocation', async () => {
    const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s);
    for (let i = 0; i < 50; i++) {
      const nested = await inheritedBegin(s, state, 'nested-' + i);
      await inheritedEnd(s, state, nested.call);
    }
    expect((await s.accept('tool.begin', { toolCallId: 'nested-over-limit', toolName: 'read_file', originalArgs: {}, effectiveArgs: {},
      codeInvocationId: state.invocation, parentToolCallId: state.parent.toolCallId, parentAdmissionId: state.parent.admissionId })).ok).toBe(false);
    await codeEnd(s, state);
    expect((await s.accept('code.authorize', { ...state.parent, codeHash: fingerprintJson(codeArgs.code).sha256 })).ok).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  test('nested operations cannot borrow another call process or close the whole environment', async () => {
    const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s), first = await inheritedBegin(s, state);
    const run = await s.accept('environment.operation', { ...first.call, operation: 'execute', arguments: { operationId: 'first-op' } });
    expect(run.ok).toBe(true); state.nestedReceipts.push(run.receiptId);
    await inheritedEnd(s, state, first.call, [run.receiptId]);
    const second = await inheritedBegin(s, state, 'nested-2');
    for (const operation of ['poll', 'cancel', 'write', 'close']) expect((await s.accept('environment.operation', {
      ...second.call, operation, arguments: { operationId: operation + '-op', processId: run.processId } })).ok).toBe(false);
    expect(s.calls).toEqual(['execute']);
  });

  test('ownership, deadline and receipt failures revoke code authority while exact cleanup remains available', async () => {
    for (const scenario of ['owner', 'deadline', 'receipt']) {
      const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s);
      if (scenario === 'owner') s.revoke(); else if (scenario === 'deadline') s.expire(); else s.failAppend();
      expect((await s.accept('tool.begin', { toolCallId: 'nested', toolName: 'read_file', originalArgs: {}, effectiveArgs: {},
        codeInvocationId: state.invocation, parentToolCallId: state.parent.toolCallId, parentAdmissionId: state.parent.admissionId })).ok).toBe(false);
      await s.accept('session.close', {});
      expect(s.closes()).toBe(1); expect(s.calls).toHaveLength(0);
      expect((await s.accept('code.start', { ...state.parent, codeCapability: state.authorized.codeCapability })).ok).toBe(false);
    }
  });

  test('failed code result closes its invocation without manufacturing completed native output', async () => {
    const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s);
    const end = await s.accept('code.end', { ...state.parent, codeInvocationId: state.invocation,
      status: 'failed', resultHash: fingerprintJson({ error: 'synthetic failure' }).sha256, operationReceipts: [] });
    expect(end.ok).toBe(true); expect(s.receipts.at(-1)?.kind).toBe('code_failed');
    expect((await s.accept('tool.end', { ...state.parent, status: 'failed', resultHash: rawResultHash,
      operationReceipts: [...state.outerReceipts, end.receiptId] })).ok).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  test('authorized but unstarted code cannot nest or prematurely complete and expiry invalidates its capability', async () => {
    const s = setup(undefined, undefined, coreCodeTools), parent = await codeAdmission(s);
    const authorized = await s.accept('code.authorize', { ...parent, codeHash: fingerprintJson(codeArgs.code).sha256 });
    expect(authorized.ok).toBe(true);
    expect((await s.accept('tool.begin', { toolCallId: 'nested-before-start', toolName: 'read_file', originalArgs: {}, effectiveArgs: {},
      codeInvocationId: authorized.codeCapability, parentToolCallId: parent.toolCallId, parentAdmissionId: parent.admissionId })).ok).toBe(false);
    expect((await s.accept('code.end', { ...parent, codeInvocationId: authorized.codeCapability,
      status: 'completed', resultHash: rawResultHash, operationReceipts: [] })).ok).toBe(false);
    expect((await s.accept('tool.end', { ...parent, status: 'completed', resultHash: rawResultHash,
      operationReceipts: [authorized.receiptId] })).ok).toBe(false);
    s.expire();
    expect((await s.accept('code.start', { ...parent, codeCapability: authorized.codeCapability })).ok).toBe(false);
    expect((await s.accept('session.close', {})).ok).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  test('inherited operation replay and malformed physical result fence only through the existing uncertainty path', async () => {
    const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s), nested = await inheritedBegin(s, state);
    const request = { ...nested.call, operation: 'execute', arguments: { operationId: 'one-use-operation' } };
    const run = await s.accept('environment.operation', request);
    expect(run.ok).toBe(true); state.nestedReceipts.push(run.receiptId);
    expect((await s.accept('environment.operation', request)).ok).toBe(false);
    expect(s.calls).toHaveLength(1);
    s.invalidResult();
    expect((await s.accept('environment.operation', { ...request, arguments: { operationId: 'malformed-result' } })).ok).toBe(false);
    expect(s.fences).toContain('operation_uncertain');
    expect((await s.accept('environment.operation', { ...request, arguments: { operationId: 'after-fence' } })).ok).toBe(false);
    expect(s.calls).toHaveLength(2);
    expect((await s.accept('session.close', {})).ok).toBe(true);
  });

  test('a completed invocation cannot reuse inherited identities or authorize another observed script', async () => {
    const s = setup(undefined, undefined, coreCodeTools), state = await codeStarted(s), nested = await inheritedBegin(s, state);
    await inheritedEnd(s, state, nested.call); await codeEnd(s, state);
    expect((await s.accept('tool.end', { ...state.parent, status: 'completed', resultHash: rawResultHash,
      operationReceipts: state.outerReceipts })).ok).toBe(true);
    expect(() => s.observed('nested-1')).toThrow('observed_call');
    expect((await s.accept('tool.begin', nested.payload)).ok).toBe(false);
    s.observed('next-script', 'execute_code', codeArgs);
    const next = await s.accept('tool.begin', { toolCallId: 'next-script', toolName: 'execute_code', originalArgs: codeArgs, effectiveArgs: codeArgs });
    expect(next.ok).toBe(true);
    expect((await s.accept('code.start', { toolCallId: 'next-script', admissionId: next.admissionId,
      codeCapability: state.authorized.codeCapability })).ok).toBe(false);
    expect((await s.accept('code.authorize', { toolCallId: 'next-script', admissionId: next.admissionId,
      codeHash: fingerprintJson(codeArgs.code).sha256 })).ok).toBe(true);
    expect(s.calls).toHaveLength(0);
  });
});
