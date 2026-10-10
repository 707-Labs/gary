import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpendLedger } from '../../src/spend.ts';
import { createHermesProjectResponder, PROJECT_CONVERSATION_POLICY, ProjectReplyError, type ProjectReplyDependencies, type ProjectTurn } from '../../src/hermes/project-conversation.ts';
import { createStdioLauncher } from '../../src/hermes/stdio-launcher.ts';
import { createSlackConversation, loadSlackConversationConfig } from '../../src/slack/conversation.ts';
import scenario from './fixtures/project-summary-limit-scenario.json';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
const allocation = 'local:hermes-dm-20261008-tanner', campaign = 'hermes-dm-20261008';
const authority = { surface: 'private_dm' as const, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ', channelId: 'D0FIXTURE1', threadTs: '1791621000.000001' };
const worker = fileURLToPath(new URL('./fixtures/project-conversation-worker.py', import.meta.url));
const content = (text: string) => [{ type: 'text', text }];
const tool = (id = 'work', name = 'current_work') => [{ type: 'tool_use', id, name, input: { project: 'fixture' } }];
function provider(blocks: any[], stop?: string, output = 20) {
  return Response.json({ id: 'offline', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content: blocks,
    stop_reason: stop ?? (blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    usage: { input_tokens: 50, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
}
function fixture(cleanupFails = false) {
  const ledger = new SpendLedger(':memory:'); disposers.push(() => ledger.close());
  ledger.createCampaign(campaign, 5); ledger.enrollTicket(campaign, allocation, 5);
  const executed: string[] = [], requests: any[] = [];
  let launches = 0, cleanups = 0;
  const launch = createStdioLauncher({ command: ['/usr/bin/python3', '-I', '-B', worker], cwd: '/', env: { PATH: '/usr/bin:/bin' },
    async cleanup() { cleanups++; if (cleanupFails) throw Error('not-for-diagnostics'); } });
  const projects: ProjectReplyDependencies['projects'] = {
    toolsFor: () => ['current_work', 'remember_fact'].map(name => ({ type: 'function', function: { name,
      description: 'Synthetic bounded project tool', parameters: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false } } })),
    context: async () => 'Synthetic project reference only.',
    execute: async request => { executed.push(request.toolName + ':' + request.requestId); return { ok: true, dataOnly: true, data: { ticket: 'SYNTH-1', status: 'recorded' } }; },
  };
  return { ledger, executed, requests, projects, get launches() { return launches; }, get cleanups() { return cleanups; },
    responder(fetch: (body: any, index: number) => Promise<Response> | Response) {
      return createHermesProjectResponder({ ledger, projects, providerApiKey: 'fake-secret',
        launch: (...args) => { launches++; return launch(...args); },
        fetch: async request => { const body = await request.json(); requests.push(body); return fetch(body, requests.length); } });
    } };
}
const turn = (extra: Partial<ProjectTurn> = {}): ProjectTurn => ({ requestId: 'synthetic-request', ownerId: 'synthetic-owner',
  allocationId: allocation, campaignId: campaign, authority, history: [], text: scenario.prompt,
  signal: new AbortController().signal, assertActive() {}, recordWorker() {}, ...extra });

test('reconstructed October10 limit hypothesis still recovers inside expanded cap with same evidence, no tool replay', async () => {
  const f = fixture();
  const reply = f.responder((_body, n) => n === 1 ? provider(tool()) : n === 2
    ? provider(content(scenario.partialText), scenario.hypothesis.finalProviderStopReason, scenario.observed.finalOutputTokens)
    : provider(content(scenario.replacementText)));
  expect(await reply(turn())).toBe(scenario.replacementText);
  expect(f.requests).toHaveLength(3); expect(f.launches).toBe(1); expect(f.cleanups).toBe(1); expect(f.executed).toHaveLength(1);
  expect(f.requests[2].messages).toEqual(f.requests[1].messages);
  expect(f.requests[2].tools).toBeUndefined(); expect(f.requests[2].max_tokens).toBe(4096);
  expect(f.requests[2].system[0].text).toContain('shorter replacement answer');
  expect(JSON.stringify(f.requests[2])).not.toContain(scenario.partialText);
  expect(f.ledger.status(allocation)).toMatchObject({ attemptCount: 3, unknownAttempts: 0 });
});

test('replacement truncates once: explicitly partial UTF8 answer fits final byte cap without another request', async () => {
  const f = fixture(), text = '🦜'.repeat(16_360);
  const reply = f.responder(() => provider(content(text), 'max_tokens', 1024));
  const answer = await reply(turn());
  expect(answer).toEndWith('[Partial answer: response limit reached.]');
  expect(answer).not.toContain('\uFFFD'); expect(answer).toStartWith('🦜');
  expect(Buffer.byteLength(JSON.stringify({ role: 'assistant', content: answer }))).toBeLessThanOrEqual(PROJECT_CONVERSATION_POLICY.maxReplyBytes);
  expect(f.requests).toHaveLength(2); expect(f.requests[1].tools).toBeUndefined(); expect(f.executed).toHaveLength(0);
  expect(f.cleanups).toBe(1); expect(f.ledger.status(allocation)?.unknownAttempts).toBe(0);
});

test('sixth physical response truncates: bounded partial answer without seventh call or repeated mutation', async () => {
  const f = fixture();
  const reply = f.responder((_body, n) => n < 6 ? provider(tool('learn-' + n, n === 1 ? 'remember_fact' : 'current_work'))
    : provider(content(scenario.partialText), 'max_tokens', 1024));
  const answer = await reply(turn());
  expect(answer).toContain(scenario.partialText); expect(answer).toContain('[Partial answer:');
  expect(f.requests).toHaveLength(6); expect(f.requests[5].tools).toBeUndefined();
  expect(f.executed).toHaveLength(5); expect(new Set(f.executed).size).toBe(5); expect(f.launches).toBe(1);
});

test('ambiguous replacement keeps unknown spend and never publishes retained partial or retries again', async () => {
  const f = fixture();
  const reply = f.responder((_body, n) => { if (n === 2) throw Error('synthetic network ambiguity'); return provider(content(scenario.partialText), 'max_tokens', 1024); });
  await expect(reply(turn())).rejects.toMatchObject({ cleanupConfirmed: true });
  expect(f.requests).toHaveLength(2); expect(f.cleanups).toBe(1);
  expect(f.ledger.status(allocation)).toMatchObject({ attemptCount: 2, unknownAttempts: 1 });
  await expect(reply(turn({ requestId: 'later' }))).rejects.toMatchObject({ code: 'project_budget_unavailable' });
  expect(f.requests).toHaveLength(2); expect(f.launches).toBe(1);
});

test('replacement cannot call a tool even when its name was offered earlier', async () => {
  const f = fixture();
  const reply = f.responder((_body, n) => n === 1 ? provider(content(scenario.partialText), 'max_tokens', 1024) : provider(tool('injected', 'remember_fact')));
  await expect(reply(turn())).rejects.toMatchObject({ code: 'project_model_unsupported_provider_response', cleanupConfirmed: true });
  expect(f.requests).toHaveLength(2); expect(f.executed).toHaveLength(0); expect(f.cleanups).toBe(1);
});

for (const cleanupFails of [false, true]) test('real stdio keeps finite host cause and separate cleanup certainty: ' + cleanupFails, async () => {
  const f = fixture(cleanupFails), reply = f.responder(() => provider(content('fake-secret'), 'max_tokens', 1024));
  const error = await reply(turn()).then(() => null, error => error);
  expect(error).toMatchObject({ code: 'project_content_rejected', cleanupConfirmed: !cleanupFails });
  expect(JSON.stringify(error)).not.toContain('fake-secret'); expect(JSON.stringify(error)).not.toContain('not-for-diagnostics');
  expect(f.requests).toHaveLength(1); expect(f.cleanups).toBe(1);
});

test('known worker cleanup cannot clear a host tool operation with uncertain cleanup', async () => {
  const f = fixture();
  f.projects.execute = async () => { throw new ProjectReplyError('project_tool_result_rejected', false); };
  const reply = f.responder(() => provider(tool('uncertain-mutation', 'remember_fact')));
  await expect(reply(turn())).rejects.toMatchObject({ code: 'project_tool_result_rejected', cleanupConfirmed: false });
  expect(f.requests).toHaveLength(1); expect(f.cleanups).toBe(1);
  expect(f.ledger.status(allocation)?.unknownAttempts).toBe(0);
});

test('cancelled owner after first response cannot spend a replacement slot', async () => {
  const f = fixture(), controller = new AbortController();
  const reply = f.responder(() => { controller.abort(); return provider(content(scenario.partialText), 'max_tokens', 1024); });
  await expect(reply(turn({ signal: controller.signal }))).rejects.toMatchObject({ cleanupConfirmed: true });
  expect(f.requests).toHaveLength(1); expect(f.cleanups).toBe(1);
});

test('recovered DM answer commits once, duplicate delivery does not repeat tools, and fresh follow-up remains usable', async () => {
  const f = fixture(), directory = realpathSync(mkdtempSync(join(tmpdir(), 'gary-recovered-dm-')));
  chmodSync(directory, 0o700); disposers.push(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'conversation.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, runId: campaign, campaignId: campaign, allocationId: allocation }), { mode: 0o600 });
  const config = loadSlackConversationConfig(configPath);
  const responder = f.responder((_body, n) => n === 1 ? provider(tool('remember-once', 'remember_fact')) : n === 2
    ? provider(content(scenario.partialText), 'max_tokens', 1024) : provider(content(n === 3 ? scenario.replacementText : 'A fresh follow-up answer.')));
  const service = createSlackConversation({ config, ledger: f.ledger, reply: input => responder({ ...input, authority: input.authority! }) });
  disposers.push(() => { service.close(); });
  const input = { eventId: 'EvSyntheticRecovery', channel: authority.channelId, ts: authority.threadTs, threadTs: authority.threadTs, text: scenario.prompt };
  const delivered: string[] = [], deliver = async (text: string) => { delivered.push(text); return 'sent' as const; };
  await service.respond(input, deliver, new AbortController().signal);
  await service.respond(input, deliver, new AbortController().signal);
  await service.respond({ ...input, eventId: 'EvSyntheticFollowup', ts: '1791621000.000002', text: 'Which evidence was missing?' }, deliver, new AbortController().signal);
  expect(delivered).toEqual([scenario.replacementText, 'A fresh follow-up answer.']);
  expect(f.requests).toHaveLength(4); expect(f.executed).toHaveLength(1); expect(f.launches).toBe(2); expect(f.cleanups).toBe(2);
  const db = new Database(join(directory, 'context.sqlite'), { readonly: true });
  try {
    const saved = db.query('SELECT history,turns,blocked FROM sessions').get() as any;
    expect(saved.turns).toBe(2); expect(saved.blocked).toBe(0);
    expect(JSON.parse(saved.history).filter((m: any) => m.role === 'assistant').map((m: any) => m.content)).toEqual(delivered);
    expect((db.query("SELECT count(*) n FROM events WHERE state='sent' AND cleanup=1").get() as any).n).toBe(2);
  } finally { db.close(); }
});

test('exhaustive current request gets 8192 output tokens and long answers pass real stdio without a second model call', async () => {
  const f = fixture(), answer = 'Detailed evidence line.\n'.repeat(2200);
  const reply = f.responder(body => {
    expect(body.max_tokens).toBe(8192);
    return provider(content(answer), 'end_turn', 8000);
  });
  expect(await reply(turn({ text: 'Give an exhaustive summary of every ticket, with the observed evidence and gaps.' }))).toBe(answer);
  expect(f.requests).toHaveLength(1); expect(f.cleanups).toBe(1);
  expect(Buffer.byteLength(answer)).toBeGreaterThan(8000);
});

test('a native request over 64KiB keeps exact original history within the coherent 1MiB RPC limit', async () => {
  const f = fixture(), history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: String(i) + 'x'.repeat(13_000) }));
  const reply = f.responder(body => {
    expect(JSON.stringify(body).length).toBeGreaterThan(65_536);
    return provider(content('History preserved without compression.'));
  });
  expect(await reply(turn({ history }))).toBe('History preserved without compression.');
  expect(f.requests).toHaveLength(1); expect(f.cleanups).toBe(1);
});

function longHistory() {
  return Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const,
    content: i === 15 ? 'Latest answer stays verbatim.' : 'Historical message ' + i + ': ' + 'x'.repeat(7500) }));
}

test('prelaunch compression uses one of six physical calls, preserves latest exchange, and commits provenance only after cleanup', async () => {
  const f = fixture(), history = longHistory(), saved: any[] = [];
  const reply = f.responder((body, n) => {
    if (n === 1) {
      expect(body.tools).toBeUndefined(); expect(body.max_tokens).toBe(4096);
      expect(body.system[0].text).toContain('untrusted historical data');
      expect(body.messages[0].content[0].text).not.toContain('Latest answer stays verbatim.');
      return provider(content('The user requested ticket evidence. Historical ticket status remains unverified.'));
    }
    const text = JSON.stringify(body.messages);
    expect(text).toContain('conversation_continuity'); expect(text).toContain('sourceSha256');
    expect(text).toContain('Latest answer stays verbatim.'); expect(text).not.toContain('Historical message 0:');
    return n < 6 ? provider(tool('evidence-' + n)) : provider(content('A complete current answer.'));
  });
  expect(await reply(turn({ history, compactHistory(candidate) { expect(f.cleanups).toBe(1); saved.push(candidate); } }))).toBe('A complete current answer.');
  expect(f.requests).toHaveLength(6); expect(f.requests[5].tools).toBeUndefined();
  expect(f.executed).toHaveLength(4); expect(f.ledger.status(allocation)).toMatchObject({ attemptCount: 6, unknownAttempts: 0 });
  expect(saved).toHaveLength(1); expect(saved[0].map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(saved[0].slice(-2)).toEqual(history.slice(-2));
  expect(JSON.parse(saved[0][0].content)).toMatchObject({ dataOnly: true, historical: true, sourceMessageCount: 14 });
  expect(JSON.parse(saved[0][1].content)).toMatchObject({ dataOnly: true, historical: true, complete: true });
  expect(history).toEqual(longHistory());
});

test('unknown compression spend halts before worker launch without persisting or replaying context', async () => {
  const f = fixture(), saved: any[] = [];
  const reply = f.responder(() => { throw Error('synthetic ambiguous summary response'); });
  await expect(reply(turn({ history: longHistory(), compactHistory: h => saved.push(h) }))).rejects.toBeInstanceOf(ProjectReplyError);
  expect(f.requests).toHaveLength(1); expect(f.launches).toBe(0); expect(saved).toEqual([]);
  expect(f.ledger.status(allocation)).toMatchObject({ attemptCount: 1, unknownAttempts: 1 });
});

test('verified compression is not committed when later worker cleanup is unconfirmed', async () => {
  const f = fixture(true), saved: any[] = [];
  const reply = f.responder((_body, n) => provider(content(n === 1 ? 'Historical continuity summary.' : 'Current answer.')));
  await expect(reply(turn({ history: longHistory(), compactHistory: h => saved.push(h) }))).rejects.toMatchObject({ cleanupConfirmed: false });
  expect(f.requests).toHaveLength(2); expect(saved).toEqual([]); expect(f.cleanups).toBe(1);
});

test('compression cannot call an offered tool or increase the selected response allowance', async () => {
  const f = fixture(), saved: any[] = [];
  const reply = f.responder(() => provider(tool('bad-summary', 'remember_fact')));
  await expect(reply(turn({ history: longHistory(), compactHistory: h => saved.push(h) }))).rejects.toBeInstanceOf(ProjectReplyError);
  expect(f.requests).toHaveLength(1); expect(f.executed).toEqual([]); expect(saved).toEqual([]); expect(f.launches).toBe(0);
});

test('six-request policy cannot borrow beyond the existing five-dollar allocation', async () => {
  const f = fixture();
  const reply = f.responder((_body, n) => {
    return Response.json({ id: 'large-offline-usage', type: 'message', role: 'assistant', model: 'deepseek-v4-pro',
      content: tool('expensive-' + n), stop_reason: 'tool_use',
      usage: { input_tokens: 1_000_000, output_tokens: 8192, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  });
  await expect(reply(turn({ text: 'Give an exhaustive ticket review.' }))).rejects.toBeInstanceOf(ProjectReplyError);
  expect(f.requests).toHaveLength(3); expect(f.executed).toHaveLength(3);
  const status = f.ledger.status(allocation)!;
  expect(status.attemptCount).toBe(3); expect(status.unknownAttempts).toBe(0);
  expect(status.capMicros).toBe(5_000_000); expect(status.chargedMicros).toBeLessThanOrEqual(5_000_000);
});

test('large read batches return source-bound partial receipts and a useful answer without overflowing native context', async () => {
  const f = fixture(), evidence: any[] = [];
  f.projects.execute = async () => ({ ok: true, dataOnly: true, data: { text: 'Evidence '.repeat(5000) } });
  f.projects.recordEvidence = async input => { evidence.push(input); };
  const reply = f.responder((body, n) => {
    if (n === 1) return provider(Array.from({ length: 6 }, (_, i) => tool('large-' + i)[0]));
    const results = body.messages.flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool_result'));
    expect(results).toHaveLength(6);
    expect(results.some((r: any) => r.content[0].text.includes('truncated_tool_result'))).toBeTrue();
    expect(body.tools).toBeUndefined();
    return provider(content('The observed evidence is extensive; some receipt previews were truncated, so omitted details are unverified.'));
  });
  expect(await reply(turn())).toContain('omitted details are unverified');
  expect(f.requests).toHaveLength(2); expect(evidence).toHaveLength(6);
  expect(evidence.every(e => e.result.data.text.length === 45_000)).toBeTrue();
});

test('a full final answer does not fail merely because its completed transcript exceeds the model input context cap', async () => {
  const f = fixture(), history = [{ role: 'user' as const, content: 'h'.repeat(15_000) }, { role: 'assistant' as const, content: 'h'.repeat(63_000) }];
  const answer = 'Complete result. '.repeat(3500);
  f.projects.context = async () => 'r'.repeat(60_000);
  const reply = f.responder(() => provider(content(answer)));
  expect(await reply(turn({ history }))).toBe(answer);
  expect(f.requests).toHaveLength(1); expect(f.cleanups).toBe(1);
});


test('an untruncated read near the context limit forces a useful final answer instead of admitting a failing tool continuation', async () => {
  const f = fixture(), history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: String(i) + 'h'.repeat(13_000) }));
  f.projects.context = async () => 'r'.repeat(10_000);
  f.projects.execute = async () => ({ ok: true, dataOnly: true, data: { text: 'd'.repeat(45_950) } });
  const reply = f.responder((body, n) => {
    if (n === 1) { expect(body.tools).toBeDefined(); return provider(tool()); }
    expect(body.tools).toBeUndefined();
    const results = body.messages.flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool_result'));
    expect(results).toHaveLength(1); expect(results[0].content[0].text).not.toContain('truncated_tool_result');
    return provider(content('The full observed result is available; this turn now concludes with its evidence.'));
  });
  expect(await reply(turn({ history }))).toContain('full observed result');
  expect(f.requests).toHaveLength(2);
});
