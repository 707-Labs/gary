/** Disposable SQLite + mocked provider only; no real network, model or workload. */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { standingBudgetFixture } from './fixtures/engineering-standing.ts';
import { createEngineeringModelAdapter, type EngineeringModelAdapter, type EngineeringModelChildOptions,
  type EngineeringModelOptions } from '../../src/hermes/engineering-model.ts';
import { EngineeringProtocol, type EngineeringProtocolBinding } from '../../src/hermes/engineering-protocol.ts';
import { createStandingEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';

const clean: (() => void)[] = []; afterEach(() => clean.splice(0).reverse().forEach(fn => fn()));
const TOOL = { type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: {} } } };
const provider = () => ({ id: 'synthetic', type: 'message', role: 'assistant', model: 'deepseek/deepseek-v4.1-flash',
  content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost: 0 } });
const signal = () => new AbortController().signal;
function fixture(input: { fetch?: EngineeringModelOptions['fetch']; family?: false; cap?: number } = {}) {
  const f = standingBudgetFixture(input.cap ?? 4_000_000); f.allocator.enrollPool(); const budget = f.allocator.allocate(f.input());
  const journalDb = new Database(join(f.root, 'model.sqlite')), spendDb = new Database(f.path, { readonly: true });
  clean.push(() => { journalDb.close(); spendDb.close(); f.dispose(); });
  const binding = { taskId: budget.taskId, sessionId: 'parent-session', ownerEpoch: 'owner', deadlineMs: Date.now() + 150 * 60_000 };
  const repository = resolveEngineeringRepository('fixture', { authenticated: true, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
    surface: 'private_dm', channelId: 'D123456789', threadTs: '1234567890.000001' }, [{ repositoryId: 1, installationId: 2,
    fullName: '707-Labs/fixture', appAccessible: true, contents: 'write', pullRequests: 'write', archived: false, disabled: false, sharedChannelIds: [] }]);
  const policy = createStandingEngineeringTaskPolicy({ taskId: budget.taskId, repository, baseCommit: 'a'.repeat(40),
    requiredCommands: ['bun test'], verificationProfileSha256: 'c'.repeat(64), publication: 'patch_only', capMicros: budget.taskCapMicros });
  const fences: string[] = [], requests: Request[] = [];
  function protocol(value: EngineeringProtocolBinding) {
    return new EngineeringProtocol({ binding: value, transportCapability: 'x'.repeat(48), allowedTools: ['terminal'],
      assertOwner() { budget.assertCurrent(); }, append() {}, fence(reason) { fences.push(reason); },
      execute: async () => { throw Error('fixture_forbids_tools'); }, close: async () => ({ cleanupConfirmed: true }) });
  }
  const options: EngineeringModelOptions = { binding, policy, allocationId: budget.allocationId, standingBudget: budget,
    ...(input.family === false ? {} : { family: true as const }), ledger: f.ledger, journalDb, spendDb,
    protocol: protocol(binding), tools: [TOOL], systemPrompt: 'Parent host instructions.', providerApiKey: 'synthetic',
    assertOwner() { budget.assertCurrent(); }, fence(reason) { fences.push(reason); },
    fetch: async request => { requests.push(request); return input.fetch ? input.fetch(request) : Response.json(provider()); } };
  const model = createEngineeringModelAdapter(options);
  const childOptions = (sessionId = 'child-session'): EngineeringModelChildOptions => {
    const childBinding = { ...binding, sessionId };
    return { binding: childBinding, protocol: protocol(childBinding), tools: [TOOL], systemPrompt: 'Independent child instructions.', assertOwner() { budget.assertCurrent(); } };
  };
  return { ...f, budget, binding, options, journalDb, spendDb, model, requests, fences, childOptions, protocol };
}
const body = (model: EngineeringModelAdapter, systemPrompt: string) => ({ model: 'deepseek/deepseek-v4.1-flash',
  messages: [{ role: 'system', content: systemPrompt }, ...model.history()], tools: [TOOL], max_tokens: 8192, stream: false, temperature: 0.3 });
async function work(model: EngineeringModelAdapter, systemPrompt: string, turnId: string, prompt = 'Approved work.') {
  model.beginTurn({ turnId, prompt }); const result = await model.handle(body(model, systemPrompt), signal());
  model.finishTurn(model.history()); return result;
}

test('parent, two children and independent skill calls share twelve work slots and one protected final review', async () => {
  const f = fixture(), one = f.childOptions('child-one'), two = f.childOptions('child-two');
  const first = f.model.createChild!(one), second = f.model.createChild!(two);
  expect(f.ledger.status(f.budget.allocationId)!.attemptCount).toBe(0);
  await work(f.model, f.options.systemPrompt, 'parent', 'Private parent task context.');
  await work(first, one.systemPrompt, 'child-one', 'First independent task.');
  await work(second, two.systemPrompt, 'child-two', 'Second independent task.');
  const evaluation = await f.model.auxiliary!({ purpose: 'skill_evaluation', prompt: 'Evaluate exact skill.', systemPrompt: 'Evaluator.', signal: signal() });
  const review = await f.model.auxiliary!({ purpose: 'skill_review', prompt: 'Review exact skill.', systemPrompt: 'Independent skill reviewer.', signal: signal() });
  expect(evaluation.receipt.contextId).not.toBe(review.receipt.contextId);
  expect(evaluation.receipt.ledgerAttemptId).not.toBe(review.receipt.ledgerAttemptId);
  expect(evaluation.receipt.purpose).toBe('skill_evaluation'); expect(review.receipt.purpose).toBe('skill_review');
  expect(Object.isFrozen(evaluation.receipt)).toBe(true);
  for (let index = 0; index < 7; index++) await work(f.model, f.options.systemPrompt, 'parent-more-' + index);
  expect(first.attempts()).toEqual(f.model.attempts()); expect(second.attempts()).toHaveLength(12);
  await expect(f.model.auxiliary!({ purpose: 'skill_evaluation', prompt: 'Thirteenth work request.', systemPrompt: 'Evaluator.', signal: signal() })).rejects.toThrow('request_limit');
  expect(f.requests).toHaveLength(12);
  await f.model.review({ prompt: 'Review final artifact.', systemPrompt: 'Final independent reviewer.', signal: signal() });
  expect(f.requests).toHaveLength(13);
  expect(f.ledger.status(f.budget.allocationId)).toMatchObject({ attemptCount: 13, chargedMicros: 12 * 19667 + 9822, unknownAttempts: 0 });
  expect(f.journalDb.query('SELECT task_id,session_id FROM engineering_model_owners').all()).toEqual([{ task_id: f.binding.taskId, session_id: f.binding.sessionId }]);
  const origins = f.journalDb.query('SELECT * FROM engineering_model_request_origins ORDER BY rowid').all() as Record<string, unknown>[];
  expect(origins.map(row => row.purpose)).toEqual(['parent_work', 'child_work', 'child_work', 'skill_evaluation', 'skill_review',
    ...Array.from({ length: 7 }, () => 'parent_work'), 'final_review']);
  expect(origins.every(row => row.allocation_id === f.budget.allocationId && row.task_id === f.binding.taskId && row.parent_session_id === f.binding.sessionId)).toBe(true);
  expect(origins[3]).toMatchObject({ request_id: evaluation.receipt.requestId, context_id: evaluation.receipt.contextId });
  expect(f.journalDb.query('SELECT receipt_hash,response_hash,ledger_attempt FROM engineering_model_requests WHERE request_id=?')
    .get(evaluation.receipt.requestId)).toEqual({ receipt_hash: evaluation.receipt.receiptSha256,
      response_hash: evaluation.receipt.responseSha256, ledger_attempt: evaluation.receipt.ledgerAttemptId });
  const bodies = await Promise.all(f.requests.map(request => request.json()));
  for (const index of [3, 4, 12]) expect(bodies[index].tools).toBeUndefined();
  expect(bodies[3].messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Evaluate exact skill.' }] }]);
  expect(bodies[4].messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Review exact skill.' }] }]);
  expect(bodies.map(value => value.max_tokens)).toEqual([...Array.from({ length: 12 }, () => 8192), 4090]);
  expect(first.history()).toEqual([{ role: 'user', content: 'First independent task.' }, { role: 'assistant', content: 'Done.' }]);
  expect(second.history()).toEqual([{ role: 'user', content: 'Second independent task.' }, { role: 'assistant', content: 'Done.' }]);
});

test('family is explicit; child scope cannot broaden ownership, deadline, tools or delegation depth', async () => {
  const ordinary = fixture({ family: false }); expect(ordinary.model.createChild).toBeUndefined(); expect(ordinary.model.auxiliary).toBeUndefined();
  expect(ordinary.journalDb.query("SELECT 1 FROM sqlite_master WHERE name='engineering_model_request_origins'").get()).toBeNull();
  const f = fixture();
  for (const change of [{ taskId: 'foreign' }, { ownerEpoch: 'foreign' }, { deadlineMs: f.binding.deadlineMs + 1 }, { sessionId: f.binding.sessionId }]) {
    const value = f.childOptions(); value.binding = { ...value.binding, ...change }; value.protocol = f.protocol(value.binding);
    expect(() => f.model.createChild!(value)).toThrow('child_binding');
  }
  expect(() => f.model.createChild!({ ...f.childOptions(), tools: [{ ...TOOL, function: { ...TOOL.function, name: 'delegate_task' } }] })).toThrow('child_tools');
  expect(() => f.model.createChild!({ ...f.childOptions(), tools: [{ ...TOOL, function: { ...TOOL.function, description: 'broader' } }] })).toThrow('child_tools');
  const firstOptions = f.childOptions(), first = f.model.createChild!(firstOptions);
  expect(first.createChild).toBeUndefined(); expect(first.auxiliary).toBeUndefined();
  await expect(first.review({ prompt: 'Steal final review.', systemPrompt: 'Reviewer.', signal: signal() })).rejects.toThrow('review_not_parent');
  expect(() => f.model.createChild!(firstOptions)).toThrow('child_binding');
  f.model.createChild!(f.childOptions('second'));
  expect(() => f.model.createChild!(f.childOptions('third'))).toThrow('child_not_ready');
  expect(f.requests).toHaveLength(0); expect(f.ledger.status(f.budget.allocationId)!.attemptCount).toBe(0);
  expect(f.journalDb.query('SELECT count(*) n FROM engineering_model_owners').get()).toEqual({ n: 1 });
});

test('a child physical request holds the same busy slot against parent and auxiliary dispatch', async () => {
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ fetch: async () => { entered(); await done; return Response.json(provider()); } });
  const options = f.childOptions(), child = f.model.createChild!(options);
  f.model.beginTurn({ turnId: 'parent', prompt: 'Parent work.' }); child.beginTurn({ turnId: 'child', prompt: 'Child work.' });
  const pending = child.handle(body(child, options.systemPrompt), signal()); await start;
  await expect(f.model.handle(body(f.model, f.options.systemPrompt), signal())).rejects.toThrow('concurrent_or_inactive_turn');
  await expect(f.model.auxiliary!({ purpose: 'skill_review', prompt: 'Review.', systemPrompt: 'Reviewer.', signal: signal() })).rejects.toThrow('auxiliary_not_ready');
  expect(f.requests).toHaveLength(1); release(); await pending; child.finishTurn(child.history());
  await f.model.handle(body(f.model, f.options.systemPrompt), signal()); f.model.finishTurn(f.model.history());
  expect(f.requests).toHaveLength(2); expect(f.fences).toEqual([]);
});

test('unknown child usage fences the entire family and never creates a retry allocation', async () => {
  const f = fixture({ fetch: async () => Response.json({ ...provider(), usage: { input_tokens: 10 } }) });
  const options = f.childOptions(), child = f.model.createChild!(options);
  await expect(work(child, options.systemPrompt, 'unknown')).rejects.toThrow('request_failed');
  expect(f.ledger.status(f.budget.allocationId)).toMatchObject({ attemptCount: 1, unknownAttempts: 1, chargedMicros: 648807 });
  expect(() => f.model.beginTurn({ turnId: 'retry', prompt: 'Retry.' })).toThrow('inactive');
  await expect(f.model.auxiliary!({ purpose: 'skill_evaluation', prompt: 'Retry.', systemPrompt: 'Evaluator.', signal: signal() })).rejects.toThrow('inactive');
  expect(() => f.model.createChild!(f.childOptions('retry-child'))).toThrow('inactive');
  expect(f.requests).toHaveLength(1); expect(f.fences).toContain('model_request_unresolved');
});

test('auxiliary work preserves the full final review reserve and cannot relabel previous work provenance', async () => {
  const minimum = fixture({ cap: 1_287_769 });
  await minimum.model.auxiliary!({ purpose: 'skill_evaluation', prompt: 'Evaluate.', systemPrompt: 'Evaluator.', signal: signal() });
  await expect(minimum.model.auxiliary!({ purpose: 'skill_review', prompt: 'Review.', systemPrompt: 'Reviewer.', signal: signal() })).rejects.toThrow('headroom');
  expect(minimum.requests).toHaveLength(1);
  await minimum.model.review({ prompt: 'Final artifact.', systemPrompt: 'Final reviewer.', signal: signal() });
  expect(minimum.requests).toHaveLength(2);
  const f = fixture(); await work(f.model, f.options.systemPrompt, 'parent');
  f.journalDb.exec("UPDATE engineering_model_request_origins SET purpose='skill_review'");
  await expect(f.model.auxiliary!({ purpose: 'skill_evaluation', prompt: 'Evaluate.', systemPrompt: 'Evaluator.', signal: signal() })).rejects.toThrow('request_origin_changed');
  expect(f.requests).toHaveLength(1);
});

test('fresh final review waits for every child context, and child ownership is rechecked at reservation time', async () => {
  const f = fixture(), childOptions = f.childOptions(); let active = true;
  childOptions.assertOwner = () => { if (!active) throw Error('child_revoked'); };
  const child = f.model.createChild!(childOptions); child.beginTurn({ turnId: 'pending-child', prompt: 'Work.' });
  await expect(f.model.review({ prompt: 'Premature final.', systemPrompt: 'Reviewer.', signal: signal() })).rejects.toThrow('review_not_ready');
  const reserve = f.ledger.withReservationGuard.bind(f.ledger);
  f.ledger.withReservationGuard = ((guard, operation) => reserve(reservation => { active = false; guard(reservation); }, operation)) as typeof f.ledger.withReservationGuard;
  await expect(child.handle(body(child, childOptions.systemPrompt), signal())).rejects.toThrow('request_failed');
  expect(f.requests).toHaveLength(0); expect(f.ledger.status(f.budget.allocationId)!.attemptCount).toBe(0);
  expect(() => f.model.beginTurn({ turnId: 'parent', prompt: 'Parent.' })).toThrow('inactive');
});
