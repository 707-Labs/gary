import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../../src/spend.ts';
import { createEngineeringModelAdapter, type EngineeringModelOptions } from '../../src/hermes/engineering-model.ts';
import { EngineeringProtocol, type EngineeringProtocolOptions } from '../../src/hermes/engineering-protocol.ts';
import { createEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';

export const TOOL = { type: 'function', function: { name: 'terminal', description: 'Run foreground command.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
export function provider(content: unknown[] = [{ type: 'text', text: 'Done.' }], stop_reason = 'end_turn') {
  return { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content, stop_reason,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
export function modelFixture(fetch?: EngineeringModelOptions['fetch'], fixture: {
  tools?: Record<string, unknown>[]; execute?: EngineeringProtocolOptions['execute']; deadlineMs?: number;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-model-')));
  const ledger = new SpendLedger(join(root, 'spend.sqlite'));
  ledger.createCampaign('engineering-test', 5.65); ledger.enrollTicket('engineering-test', 'engineering-allocation', 5.65, { draftPr: true });
  const spendDb = new Database(join(root, 'spend.sqlite'), { readonly: true }), journalDb = new Database(join(root, 'engineering.sqlite'));
  cleanup.push(() => { spendDb.close(); journalDb.close(); ledger.close(); rmSync(root, { recursive: true }); });
  const binding = { taskId: 'task', sessionId: 'session', ownerEpoch: 'owner', deadlineMs: fixture.deadlineMs ?? Date.now() + 30_000 };
  const authority = { authenticated: true as const, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
    surface: 'private_dm' as const, channelId: 'D123456789', threadTs: '1234567890.000001' };
  const repository = resolveEngineeringRepository('fixture', authority, [{ repositoryId: 1, installationId: 2,
    fullName: '707-Labs/fixture', appAccessible: true, contents: 'write', pullRequests: 'write',
    archived: false, disabled: false, sharedChannelIds: [] }]);
  const policy = createEngineeringTaskPolicy({ taskId: 'task', repository, baseCommit: 'a'.repeat(40),
    allowedFiles: ['file.ts'], requiredCommands: ['bun test'], publication: 'draft_pr' });
  const fences: string[] = [], requests: Request[] = [], protocolReceipts: unknown[] = [];
  let owner = true;
  const assertOwner = () => { if (!owner) throw new Error('revoked'); };
  const token = 'x'.repeat(48);
  const tools = fixture.tools ?? [TOOL];
  const protocol = new EngineeringProtocol({ binding, transportCapability: token, allowedTools: tools.map(t => (t.function as any).name),
    assertOwner, append: r => protocolReceipts.push(r), fence: r => fences.push(r),
    execute: fixture.execute ?? (async () => ({ processId: 'process', stdout: 'ok', returncode: 0 })), close: async () => ({ cleanupConfirmed: true }) });
  const options: EngineeringModelOptions = { binding, policy, allocationId: 'engineering-allocation', ledger,
    journalDb, spendDb, protocol, tools, systemPrompt: 'Host engineering instructions.',
    providerApiKey: 'fake-host-only-key', assertOwner, fence: r => fences.push(r), fetch: async request => {
      requests.push(request);
      const intent = journalDb.query('SELECT state,ledger_attempt FROM engineering_model_requests ORDER BY rowid DESC LIMIT 1').get() as any;
      expect(intent.state).toBe('in_flight'); expect(intent.ledger_attempt).toBeGreaterThan(0);
      return fetch ? fetch(request) : Response.json(provider());
    } };
  const model = createEngineeringModelAdapter(options);
  const body = (messages: unknown[] = [...model.history()]) => ({ model: 'deepseek-v4-pro',
    messages: [{ role: 'system', content: options.systemPrompt }, ...messages], tools,
    max_tokens: 8192, stream: false, temperature: 0.3 });
  return { root, options, binding, token, protocol, model, body, requests, fences, ledger, journalDb, protocolReceipts,
    revoke() { owner = false; } };
}

test('three real ledger work reservations plus fresh no-tool review match the exact approval and receipts', async () => {
  const s = modelFixture();
  for (let i = 0; i < 3; i++) {
    s.model.beginTurn({ turnId: 'turn-' + i, prompt: 'Work ' + i });
    expect((await s.model.handle(s.body(), new AbortController().signal)).status).toBe(200);
    s.model.finishTurn(s.model.history());
  }
  await s.model.review({ prompt: 'Review exact artifact a/b/c and passing checks.', systemPrompt: 'Independent reviewer.', signal: new AbortController().signal });
  expect(s.requests).toHaveLength(4);
  const bodies = await Promise.all(s.requests.map(r => r.json()));
  expect(bodies.map(b => b.max_tokens)).toEqual([8192, 8192, 8192, 4090]);
  expect(bodies[3].tools).toBeUndefined();
  expect(bodies[3].messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Review exact artifact a/b/c and passing checks.' }] }]);
  expect(s.model.attempts().map(r => [r.role, r.state])).toEqual([['work','settled'],['work','settled'],['work','settled'],['review','settled']]);
  expect(s.ledger.status('engineering-allocation')!.attemptCount).toBe(4);
  expect(s.ledger.status('engineering-allocation')!.unknownAttempts).toBe(0);
  expect(s.journalDb.query('SELECT count(*) n FROM engineering_model_requests WHERE receipt_hash IS NOT NULL AND response_hash IS NOT NULL').get()).toEqual({ n: 4 });
  await expect(s.model.review({ prompt: 'Retry', systemPrompt: 'Independent.', signal: new AbortController().signal })).rejects.toThrow();
  expect(s.requests).toHaveLength(4);
});

test('host observes original model tool call before returning it and binds subsequent tool-result history', async () => {
  let request = 0;
  const s = modelFixture(async () => Response.json(++request === 1 ? provider([
    { type: 'tool_use', id: 'call_1', name: 'terminal', input: { command: 'bun test' } }], 'tool_use') : provider()));
  s.model.beginTurn({ turnId: 'turn', prompt: 'Inspect.' });
  await s.model.handle(s.body(), new AbortController().signal);
  let sequence = 0;
  const rpc = (kind: string, payload: object) => s.protocol.accept({ protocol: 'gary.engineering.v1', taskId: 'task', sessionId: 'session',
    ownerEpoch: 'owner', turnId: 'turn', sequence: ++sequence, kind, payload }, s.token);
  const admission = await rpc('tool.begin', { toolCallId: 'call_1', toolName: 'terminal', originalArgs: { command: 'bun test' }, effectiveArgs: { command: 'bun test' } });
  expect(admission.ok).toBe(true); // Would fail unless adapter observed the call already.
  const resultHash = fingerprintJson('native-result').sha256;
  expect((await rpc('tool.end', { toolCallId: 'call_1', admissionId: admission.admissionId,
    status: 'completed', resultHash, operationReceipts: [] })).ok).toBe(true);
  s.model.observeToolResult('call_1', resultHash);
  await s.model.handle(s.body([...s.model.history(), { role: 'tool', tool_call_id: 'call_1', content: 'native-result' }]), new AbortController().signal);
  expect(s.requests).toHaveLength(2);
  expect(s.model.history().at(-1)).toEqual({ role: 'assistant', content: 'Done.' });
});

test('changed system, tools, history and output limit are denied before any physical call', async () => {
  for (const modify of [
    (b: any) => { b.messages[0].content = 'worker override'; },
    (b: any) => { b.tools[0].function.description = 'changed'; },
    (b: any) => { b.messages[1].content = 'invented task'; },
    (b: any) => { b.max_tokens = 8193; },
  ]) {
    const s = modelFixture(); s.model.beginTurn({ turnId: 'turn', prompt: 'Approved task.' });
    const body = structuredClone(s.body()); modify(body);
    await expect(s.model.handle(body, new AbortController().signal)).rejects.toThrow();
    expect(s.requests).toHaveLength(0); expect(s.ledger.status('engineering-allocation')!.attemptCount).toBe(0);
  }
});

test('unknown spend, request replay and a second owner remain fenced without another call', async () => {
  const s = modelFixture(async () => Response.json({ ...provider(), usage: { input_tokens: 3 } }));
  expect(() => createEngineeringModelAdapter(s.options)).toThrow('owner_already_claimed');
  s.model.beginTurn({ turnId: 'turn', prompt: 'Work.' });
  await expect(s.model.handle(s.body(), new AbortController().signal)).rejects.toThrow();
  expect(s.model.attempts()[0]!.state).toBe('unknown');
  expect(s.ledger.status('engineering-allocation')!.unknownAttempts).toBe(1);
  await expect(s.model.handle(s.body(), new AbortController().signal)).rejects.toThrow('inactive');
  expect(s.requests).toHaveLength(1); expect(s.fences).toContain('model_request_unresolved');
});

test('revocation at the physical boundary prevents fetch and preserves the unresolved durable intent', async () => {
  const s = modelFixture(); s.model.beginTurn({ turnId: 'turn', prompt: 'Work.' });
  s.revoke();
  await expect(s.model.handle(s.body(), new AbortController().signal)).rejects.toThrow();
  expect(s.requests).toHaveLength(0);
});

test('failed durable intent blocks physical dispatch; failed receipt persistence cannot replay a settled request', async () => {
  const before = modelFixture(); before.model.beginTurn({ turnId: 'turn', prompt: 'Work.' });
  before.journalDb.exec("CREATE TRIGGER deny_intent BEFORE INSERT ON engineering_model_requests BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  await expect(before.model.handle(before.body(), new AbortController().signal)).rejects.toThrow();
  expect(before.requests).toHaveLength(0); expect(before.ledger.status('engineering-allocation')!.attemptCount).toBe(0);
  const after = modelFixture(); after.model.beginTurn({ turnId: 'turn', prompt: 'Work.' });
  after.journalDb.exec("CREATE TRIGGER deny_receipt BEFORE UPDATE OF state ON engineering_model_requests WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  await expect(after.model.handle(after.body(), new AbortController().signal)).rejects.toThrow('request_failed');
  expect(after.requests).toHaveLength(1); expect(after.ledger.status('engineering-allocation')!.unknownAttempts).toBe(0);
  expect(after.model.attempts()[0]!.state).toBe('unknown');
  await expect(after.model.handle(after.body(), new AbortController().signal)).rejects.toThrow('inactive');
  expect(after.requests).toHaveLength(1);
});

test('simultaneous worker model requests cannot acquire a second physical request slot', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), released = new Promise<void>(r => { release = r; });
  const s = modelFixture(async () => { entered(); await released; return Response.json(provider()); });
  s.model.beginTurn({ turnId: 'turn', prompt: 'Work.' });
  const first = s.model.handle(s.body(), new AbortController().signal); await started;
  await expect(s.model.handle(s.body(), new AbortController().signal)).rejects.toThrow('concurrent_or_inactive_turn');
  release(); await first;
  expect(s.requests).toHaveLength(1); expect(s.model.attempts()).toHaveLength(1);
});
