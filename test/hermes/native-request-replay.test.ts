import { afterEach, describe, expect, test } from 'bun:test';
import capture from '../../hermes/python/native-smoke-result.json';
import { createSessionHost } from '../../src/hermes/session-host.ts';
import { SpendLedger, spendReservationMicros } from '../../src/spend.ts';
import type { Executor } from '../../src/executors/index.ts';

// These are unmodified request bodies captured from the actual pinned Hermes
// runtime. Only provider replies and Executor operations below are simulated.
const token = 'native-replay-offline-capability-000000000000';
const resources: Array<() => void> = [];
afterEach(() => { for (const cleanup of resources.splice(0).reverse()) cleanup(); });

function harness(checkExitCode = 0) {
  const ledger = new SpendLedger(':memory:');
  resources.push(() => ledger.close());
  ledger.createCampaign('offline-replay', 10);
  ledger.enrollTicket('offline-replay', 'fixture-ticket', 5, { draftPr: true });
  const commands: string[] = [];
  const upstream: Array<Record<string, any>> = [];
  const reservations: Array<{ attemptCount: number; unknownAttempts: number; chargedMicros: number }> = [];
  const unexpected = async (): Promise<never> => { throw new Error('unexpected fake Executor operation'); };
  const executor: Executor = {
    workspaceRoot: '/offline/native-replay', readFile: unexpected, writeFile: unexpected,
    listFiles: unexpected, grep: unexpected,
    async run(command) {
      commands.push(command);
      return { stdout: 'offline check output', stderr: '', exitCode: checkExitCode, timedOut: false };
    },
  };
  const host = createSessionHost({
    admission: {
      taskId: capture.result.taskId, requestId: capture.result.requestId, ticketId: 'fixture-ticket',
      actionId: 'fixture-action', fingerprint: 'fixture-fingerprint', ownerEpoch: 'fixture-owner',
      deadlineMs: Date.now() + 60_000,
    },
    capabilityToken: token, ledger, provider: 'deepseek', model: 'deepseek-v4-pro',
    providerApiKey: 'offline-provider-key',
    fetch: async request => {
      // This injected function never performs network I/O. The real ledger must
      // reserve before it is called, even though its response is a fixture.
      const status = ledger.status('fixture-ticket')!;
      reservations.push({ attemptCount: status.attemptCount, unknownAttempts: status.unknownAttempts, chargedMicros: status.chargedMicros });
      expect(request.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
      expect(request.headers.get('authorization')).toBe('Bearer offline-provider-key');
      expect(request.headers.get('authorization')).not.toContain(token);
      upstream.push(await request.json());
      const tool = capture.tool_calls[upstream.length - 1];
      return Response.json({
        id: `offline-reply-${upstream.length}`, type: 'message', role: 'assistant', model: 'deepseek-v4-pro',
        content: tool ? [{ type: 'tool_use', id: tool.callId, name: tool.name, input: tool.arguments }]
          : [{ type: 'text', text: capture.result.text }],
        stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
      });
    },
    executor, allowedTools: ['run_bash', 'finish'], finishGateCommand: 'bun run check',
    currentOwnerEpoch: () => 'fixture-owner', assertAdmission: () => {},
  });
  resources.push(() => host.dispose());
  const request = (path: string, body: unknown) => new Request('http://127.0.0.1:1234' + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  async function replay() {
    const executions: Array<{ status: number; body: any }> = [];
    for (let index = 0; index < capture.model_requests.length; index++) {
      const response = await host.handle(request('/v1/chat/completions', capture.model_requests[index]));
      const body = await response.json();
      expect({ index, status: response.status, error: body.error }).toEqual({ index, status: 200, error: undefined });
      const message = body.choices[0].message;
      const expectedTool = capture.tool_calls[index];
      if (expectedTool) {
        expect(message.tool_calls).toHaveLength(1);
        const tool = message.tool_calls[0];
        expect(tool.id).toBe(expectedTool.callId);
        expect(tool.function.name).toBe(expectedTool.name);
        expect(JSON.parse(tool.function.arguments)).toEqual(expectedTool.arguments);
        const execution = await host.handle(request('/tools/execute', {
          taskId: capture.result.taskId, token, ownerEpoch: 'fixture-owner', callId: tool.id,
          name: tool.function.name, arguments: JSON.parse(tool.function.arguments),
        }));
        executions.push({ status: execution.status, body: await execution.json() });
      } else {
        expect(message.content).toBe(capture.result.text);
        expect(message.tool_calls).toBeUndefined();
      }
    }
    return executions;
  }
  return { host, ledger, commands, upstream, reservations, request, replay };
}

describe('actual pinned Hermes request replay through trusted Gary components (offline)', () => {
  test('raw native history completes only through the real check and finish tools with every model call accounted', async () => {
    expect(capture.actual_native_hermes).toBe(true);
    expect(capture.real_provider_calls).toBe(0);
    expect(capture.model_requests).toHaveLength(3);
    const unchanged = JSON.stringify(capture.model_requests);
    const h = harness();
    expect(h.host.result(capture.result).status).toBe('no_finish');
    const executions = await h.replay();
    expect(executions.map(e => e.status)).toEqual([200, 200]);
    expect(executions.map(e => e.body.ok)).toEqual([true, true]);
    expect(h.commands).toEqual(['bun run check']);
    expect(h.host.state.finishGateMet).toBe(true);
    expect(h.host.state.finishSummary).toBe(capture.result.finishSummary);

    expect(h.upstream).toHaveLength(3);
    for (let index = 0; index < h.upstream.length; index++) {
      const sent = h.upstream[index]!;
      expect(sent.max_tokens).toBe(capture.model_requests[index]!.max_tokens);
      expect(sent.temperature).toBe(0.3);
      expect(sent.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['finish', 'run_bash']);
      expect(sent.system).toEqual([{ type: 'text', text: capture.model_requests[index]!.messages[0]!.content }]);
      expect(JSON.stringify(sent)).not.toContain('reasoning_content');
    }
    expect(h.upstream[1]!.messages.at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'fixture_call_1', content: [{ type: 'text', text: 'fixture operation acknowledged' }] },
    ] });
    expect(h.upstream[2]!.messages.at(-1).content[0].tool_use_id).toBe('fixture_call_2');
    const reserved = spendReservationMicros('deepseek', 128);
    expect(h.reservations).toEqual([0, 1, 2].map(index => ({
      attemptCount: index + 1, unknownAttempts: 1, chargedMicros: index * 527 + reserved,
    })));
    // Current tariff: ceil(15 * 1.32 + 128 * 3.96) = 527 micro-USD per
    // fixture receipt. Full requested output stays charged, not just 8 emitted.
    expect(h.ledger.status('fixture-ticket')).toMatchObject({
      state: 'active', attemptCount: 3, unknownAttempts: 0, chargedMicros: 1581, campaignChargedMicros: 1581,
    });
    const result = h.host.result({ status: capture.result.status, iterations: capture.result.modelAttempts });
    expect(result).toMatchObject({ status: 'finished', summary: 'offline fixture verified', iterations: 3,
      publicationApproved: false, requestId: 'fixture-request', usageSource: 'unavailable-use-spend-ledger' });
    expect(result.runLog).toHaveLength(1);
    expect(result.runLog[0]).toMatchObject({ cmd: 'bun run check', exit: 0 });
    const state = await (await h.host.handle(h.request('/tools/state', {
      taskId: capture.result.taskId, ownerEpoch: 'fixture-owner',
    }))).json();
    expect(state).toMatchObject({ state: { finishGateMet: true, finishSummary: 'offline fixture verified' }, runLog: [], runLogCount: 1 });
    expect(JSON.stringify(capture.model_requests)).toBe(unchanged);
  });

  test('captured success and model prose cannot override a failed actual check', async () => {
    const h = harness(1);
    const executions = await h.replay();
    expect(executions[1]).toMatchObject({ status: 400, body: { ok: false, error: 'tool_failed' } });
    expect(h.host.state.finishGateMet).toBe(false);
    expect(h.host.state.finishSummary).toBeNull();
    expect(h.host.result(capture.result)).toMatchObject({ status: 'no_finish', publicationApproved: false });
    expect(h.ledger.status('fixture-ticket')).toMatchObject({ attemptCount: 3, unknownAttempts: 0, chargedMicros: 1581 });
  });

  test('native compatibility rejects meaningful reasoning, wrong tool names and unknown fields before reserving', async () => {
    const h = harness();
    const mutations: Array<(messages: Array<Record<string, any>>) => void> = [
      ...['hidden instructions', null, 3, {}, [' ']].map(value => (messages: Array<Record<string, any>>) => { messages[2]!.reasoning_content = value; }),
      ...['finish', 'send_email', 3, null].map(value => (messages: Array<Record<string, any>>) => { messages[3]!.name = value; }),
      messages => { messages[2]!.reasoning = ' '; },
      messages => { messages[3]!.provider_metadata = {}; },
    ];
    for (const mutate of mutations) {
      const body = structuredClone(capture.model_requests[1]!);
      mutate(body.messages);
      expect((await h.host.handle(h.request('/v1/chat/completions', body))).status).toBe(400);
    }
    expect(h.upstream).toHaveLength(0);
    expect(h.ledger.status('fixture-ticket')!.attemptCount).toBe(0);
  });
});
