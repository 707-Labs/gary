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
import { createEngineeringContinuation04Fixture } from './fixtures/engineering-continuation04.ts';
import { admitEngineeringContinuation, assertEngineeringContinuationBudget } from '../../src/hermes/engineering-continuation-budget.ts';

export const TOOL = { type: 'function', function: { name: 'terminal', description: 'Run foreground command.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
export function provider(content: unknown[] = [{ type: 'text', text: 'Done.' }], stop_reason = 'end_turn') {
  return { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek/deepseek-v4.1-flash', content, stop_reason,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
export function modelFixture(fetch?: EngineeringModelOptions['fetch'], fixture: {
  tools?: Record<string, unknown>[]; execute?: EngineeringProtocolOptions['execute']; deadlineMs?: number; acceptancePolicyVersion?: 2;
} = {}) {
  const continuation = fixture.acceptancePolicyVersion === 2 ? createEngineeringContinuation04Fixture() : null;
  const root = continuation?.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'engineering-model-')));
  const ledger = continuation?.ledger ?? new SpendLedger(join(root, 'spend.sqlite'));
  if (!continuation) {
    ledger.createCampaign('engineering-test', 5.65); ledger.enrollTicket('engineering-test', 'engineering-allocation', 5.65, { draftPr: true });
  }
  if (continuation) admitEngineeringContinuation({...continuation.o, apply:true});
  const continuationBaseline = continuation ? assertEngineeringContinuationBudget(continuation.o) : undefined;
  const spendDb = new Database(continuation?.o.ledgerPath ?? join(root, 'spend.sqlite'), { readonly: true }),
    journalDb = new Database(continuation?.journalPath ?? join(root, 'engineering.sqlite'));
  cleanup.push(() => { spendDb.close(); journalDb.close(); if(continuation) continuation.dispose();
    else {ledger.close(); rmSync(root, { recursive: true });} });
  const binding = { taskId: 'task', sessionId: 'session', ownerEpoch: 'owner', deadlineMs: fixture.deadlineMs ?? Date.now() + 30_000 };
  const authority = { authenticated: true as const, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
    surface: 'private_dm' as const, channelId: 'D123456789', threadTs: '1234567890.000001' };
  const repository = resolveEngineeringRepository('fixture', authority, [{ repositoryId: 1, installationId: 2,
    fullName: '707-Labs/fixture', appAccessible: true, contents: 'write', pullRequests: 'write',
    archived: false, disabled: false, sharedChannelIds: [] }]);
  const policy = createEngineeringTaskPolicy({ taskId: 'task', repository, baseCommit: 'a'.repeat(40),
    allowedFiles: ['file.ts'], requiredCommands: ['bun test'], publication: continuation ? 'patch_only' : 'draft_pr',
    ...(fixture.acceptancePolicyVersion === 2 ? {acceptancePolicyVersion:2 as const} : {}) });
  const fences: string[] = [], requests: Request[] = [], protocolReceipts: unknown[] = [];
  let owner = true;
  const assertOwner = () => { if (!owner) throw new Error('revoked'); };
  const token = 'x'.repeat(48);
  const tools = fixture.tools ?? [TOOL];
  const protocol = new EngineeringProtocol({ binding, transportCapability: token, allowedTools: tools.map(t => (t.function as any).name),
    assertOwner, append: r => protocolReceipts.push(r), fence: r => fences.push(r),
    execute: fixture.execute ?? (async () => ({ processId: 'process', stdout: 'ok', returncode: 0 })), close: async () => ({ cleanupConfirmed: true }) });
  const options: EngineeringModelOptions = { binding, policy, allocationId: continuation?.o.allocationId ?? 'engineering-allocation', ledger,
    ...(continuationBaseline ? {continuationBaseline} : {}),
    journalDb, spendDb, protocol, tools, systemPrompt: 'Host engineering instructions.',
    providerApiKey: 'fake-host-only-key', assertOwner, fence: r => fences.push(r), fetch: async request => {
      requests.push(request);
      const intent = journalDb.query('SELECT state,ledger_attempt FROM engineering_model_requests ORDER BY rowid DESC LIMIT 1').get() as any;
      expect(intent.state).toBe('in_flight'); expect(intent.ledger_attempt).toBeGreaterThan(0);
      return fetch ? fetch(request) : Response.json(provider());
    } };
  const model = createEngineeringModelAdapter(options);
  const body = (messages: unknown[] = [...model.history()]) => ({ model: 'deepseek/deepseek-v4.1-flash',
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


test('v2 twelve physical work calls and protected review settle against genuine six-row continuation without rewriting history', async () => {
  const s=modelFixture(undefined,{acceptancePolicyVersion:2}), allocation=s.options.allocationId;
  const prefix=s.options.spendDb.query('SELECT a.*,r.reason,r.details_json FROM spend_attempts a LEFT JOIN spend_receipts r ON r.attempt_id=a.id ORDER BY a.id').all();
  const schema=s.options.spendDb.query("SELECT name,sql FROM sqlite_master WHERE name IN ('spend_attempts','spend_receipts') ORDER BY name").all();
  expect(prefix).toHaveLength(6);expect(s.ledger.status(allocation)!.chargedMicros).toBe(232012);
  expect(s.model.nativeLimits).toEqual({policyVersion:2,model:'deepseek/deepseek-v4.1-flash',maxIterations:12,maxTokens:8192});
  expect(Object.isFrozen(s.model.nativeLimits)).toBe(true);
  for(let i=0;i<12;i++) {
    s.model.beginTurn({turnId:'v2-'+i,prompt:'Work '+i});
    expect((await s.model.handle(s.body(),new AbortController().signal)).status).toBe(200);
    s.model.finishTurn(s.model.history());
    const latest=s.options.spendDb.query('SELECT reserved_micros,charged_micros,state FROM spend_attempts ORDER BY id DESC LIMIT 1').get();
    expect(latest).toEqual({reserved_micros:648807,charged_micros:19667,state:'settled'});
    expect(s.ledger.status(allocation)!.remainingMicros).toBeGreaterThan(638962);
  }
  await s.model.review({prompt:'Review exact result.',systemPrompt:'Independent.',signal:new AbortController().signal});
  expect(s.requests).toHaveLength(13);expect(s.model.attempts()).toHaveLength(13);
  const final=s.ledger.status(allocation)!;
  expect(final.attemptCount).toBe(19);expect(final.chargedMicros).toBe(232012+12*19667+9822);
  expect(final.unknownAttempts).toBe(0);
  expect(s.options.spendDb.query('SELECT a.*,r.reason,r.details_json FROM spend_attempts a LEFT JOIN spend_receipts r ON r.attempt_id=a.id WHERE a.id<=152 ORDER BY a.id').all()).toEqual(prefix);
  expect(s.options.spendDb.query("SELECT name,sql FROM sqlite_master WHERE name IN ('spend_attempts','spend_receipts') ORDER BY name").all()).toEqual(schema);
  await expect(s.model.review({prompt:'Replay',systemPrompt:'Independent.',signal:new AbortController().signal})).rejects.toThrow('review_already_completed');
  expect(s.requests).toHaveLength(13);
});

test('v2 adapter rejects missing, copied, mismatched and legacy continuation baselines before claiming ownership', () => {
  const legacy=modelFixture(), v2=createEngineeringTaskPolicy({taskId:legacy.options.policy.taskId,
    repository:legacy.options.policy.repository,baseCommit:legacy.options.policy.baseCommit,
    allowedFiles:legacy.options.policy.allowedFiles,requiredCommands:legacy.options.policy.requiredCommands,
    publication:legacy.options.policy.publication,acceptancePolicyVersion:2});
  expect(() => createEngineeringModelAdapter({...legacy.options,policy:v2})).toThrow('policy_baseline_binding');
  const s=modelFixture(undefined,{acceptancePolicyVersion:2}),base=s.options.continuationBaseline!;
  for(const change of [{baselineAttemptCount:3},{baselineChargedMicros:0},{budgetPolicySha256:'0'.repeat(64)}])
    expect(() => createEngineeringModelAdapter({...s.options,continuationBaseline:{...base,...change} as any})).toThrow('policy_baseline_binding');
  expect(() => createEngineeringModelAdapter({...s.options,continuationBaseline:{...base}})).toThrow('untrusted_baseline');
  expect(() => createEngineeringModelAdapter({...s.options,policy:legacy.options.policy})).toThrow('policy_baseline_binding');
});

test('v2 worst-case physical receipts exhaust work headroom after seven and unknown usage never releases a reservation', async () => {
  const s=modelFixture(async()=>Response.json({...provider(),usage:{input_tokens:1048576,output_tokens:1,
    cache_read_input_tokens:0,cache_creation_input_tokens:0}}),{acceptancePolicyVersion:2});
  // 5_417_988 - 7*648_807 = 876_339 < 648_807 + protected review 638_962.
  for(let i=0;i<7;i++) {s.model.beginTurn({turnId:'max-'+i,prompt:'Work.'});
    await s.model.handle(s.body(),new AbortController().signal);s.model.finishTurn(s.model.history());}
  expect(s.ledger.status(s.options.allocationId)!.remainingMicros).toBe(876339);
  s.model.beginTurn({turnId:'max-eighth',prompt:'Work.'});
  await expect(s.model.handle(s.body(),new AbortController().signal)).rejects.toThrow('headroom');
  expect(s.requests).toHaveLength(7);expect(s.model.attempts()).toHaveLength(7);
  const unknown=modelFixture(async()=>Response.json({...provider(),usage:{input_tokens:10}}),{acceptancePolicyVersion:2});
  unknown.model.beginTurn({turnId:'unknown',prompt:'Work.'});
  await expect(unknown.model.handle(unknown.body(),new AbortController().signal)).rejects.toThrow();
  expect(unknown.ledger.status(unknown.options.allocationId)!.chargedMicros).toBe(232012+648807);
  expect(unknown.ledger.status(unknown.options.allocationId)!.unknownAttempts).toBe(1);
  await expect(unknown.model.handle(unknown.body(),new AbortController().signal)).rejects.toThrow('inactive');
  expect(unknown.requests).toHaveLength(1);
});
