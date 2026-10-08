import { afterEach, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { SpendLedger, spendReservationMicros, type PaidRequestGuardPhase } from '../src/spend.ts';
import { openDb } from '../src/state/db.ts';
import { upsertTicket, recordActionStart } from '../src/state/queries.ts';
import { bindCanonicalCodeAction } from '../src/hermes/canonical-admission.ts';
import type { AssignedIssue } from '../src/adapters/linear.ts';

const URL = 'https://api.deepseek.com/anthropic/v1/messages';
const TICKET = 'paid-guard-ticket';
const MAX_TOKENS = 128;
const RESERVED = spendReservationMicros('deepseek', MAX_TOKENS);
const SETTLED = Math.ceil((10 * 132 + MAX_TOKENS * 396) / 100);
const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
function ledgerFixture() {
  const ledger = new SpendLedger(':memory:'); dispose.push(() => ledger.close());
  ledger.createCampaign('offline-guards', 20); ledger.enrollTicket('offline-guards', TICKET, 20);
  return ledger;
}
function body(overrides: Record<string, unknown> = {}) {
  return { model: 'deepseek-v4-pro', max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: 'Offline fixture' }], ...overrides };
}
function request(overrides: Record<string, unknown> = {}) {
  return new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(overrides)) });
}
function receiptBody(overrides: Record<string, unknown> = {}) {
  return { id: 'offline-receipt', type: 'message', role: 'assistant', model: 'deepseek-v4-pro',
    content: [{ type: 'text', text: 'offline answer' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...overrides };
}
function fakeFetch(fn: (request: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => fn(new Request(input, init))) as typeof fetch;
}
function send(ledger: SpendLedger, transport: typeof fetch, req = request()) {
  return ledger.withSpendScope(TICKET, () => transport(req));
}
function canonicalOwner(ledger: SpendLedger) {
  const db = openDb(':memory:'); dispose.push(() => db.close());
  const issue: AssignedIssue = { id: TICKET, identifier: 'ERT-1', title: 'Offline guard fixture', description: 'No external actions',
    url: 'https://linear.invalid/ERT-1', stateName: 'Todo', stateType: 'unstarted', createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z', creatorId: null, creatorName: null, teamId: 'team', teamKey: 'ERT', blockedBy: [] };
  upsertTicket(db, { linearId: TICKET, identifier: issue.identifier });
  const action = { ticketLinearId: TICKET, stateFingerprint: 'first', actionType: 'start_coding' as const, provider: 'deepseek', model: 'deepseek-v4-pro' };
  const actionId = recordActionStart(db, action);
  const binding = bindCanonicalCodeAction({ db, ledger, actionId, fingerprint: 'first', issue, provider: 'deepseek', model: 'deepseek-v4-pro', repo: 'fixture/repo' });
  return { assertActive: () => binding.admission.assertActive(), supersede: () => recordActionStart(db, { ...action, stateFingerprint: 'new-owner' }) };
}

test('paid guards observe pre-reservation, reserved send, and completed settlement in order', async () => {
  const ledger = ledgerFixture(); const observations: unknown[] = [];
  const guard = (phase: PaidRequestGuardPhase) => {
    const status = ledger.status(TICKET)!;
    observations.push({ phase, attempts: status.attemptCount, unknown: status.unknownAttempts, charged: status.chargedMicros });
  };
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => {
    expect(observations).toHaveLength(2); return Response.json(receiptBody());
  }));
  const response = await ledger.withPaidRequestGuard(guard, () => send(ledger, transport));
  expect((await response.json()).content[0].text).toBe('offline answer');
  expect(observations).toEqual([
    { phase: 'before_request', attempts: 0, unknown: 0, charged: 0 },
    { phase: 'before_send', attempts: 1, unknown: 1, charged: RESERVED },
    { phase: 'after_response', attempts: 1, unknown: 0, charged: SETTLED },
  ]);
});

test('canonical owner supersession while request JSON validation awaits prevents reservation and send', async () => {
  const ledger = ledgerFixture(); const owner = canonicalOwner(ledger); let calls = 0;
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => { calls++; return Response.json(receiptBody()); }));
  const pending = ledger.withPaidRequestGuard(owner.assertActive, () => send(ledger, transport));
  owner.supersede();
  await expect(pending).rejects.toThrow();
  expect(calls).toBe(0); expect(ledger.status(TICKET)?.attemptCount).toBe(0);
});

test('canonical owner supersession during response JSON awaits blocks result after settling its paid receipt', async () => {
  const ledger = ledgerFixture(); const owner = canonicalOwner(ledger);
  let release!: ReadableStreamDefaultController<Uint8Array>; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { release = controller; } });
    entered(); return new Response(stream, { headers: { 'content-type': 'application/json' } });
  }));
  const pending = ledger.withPaidRequestGuard(owner.assertActive, () => send(ledger, transport));
  await ready; owner.supersede();
  release.enqueue(new TextEncoder().encode(JSON.stringify(receiptBody()))); release.close();
  await expect(pending).rejects.toThrow();
  expect(ledger.status(TICKET)).toMatchObject({ attemptCount: 1, unknownAttempts: 0, chargedMicros: SETTLED });
});

test('before_send revocation retains an unknown reservation without sending and still runs after_response', async () => {
  const ledger = ledgerFixture(); let sends = 0; const phases: PaidRequestGuardPhase[] = [];
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => { sends++; return Response.json(receiptBody()); }));
  await expect(ledger.withPaidRequestGuard(phase => {
    phases.push(phase);
    if (phase === 'before_send') throw new Error('owner revoked before send');
    if (phase === 'after_response') expect(ledger.status(TICKET)).toMatchObject({ attemptCount: 1, unknownAttempts: 1, chargedMicros: RESERVED });
  }, () => send(ledger, transport))).rejects.toThrow('owner revoked before send');
  expect(sends).toBe(0); expect(phases).toEqual(['before_request', 'before_send', 'after_response']);
});

for (const scenario of ['http_error', 'invalid_json', 'missing_usage', 'redirect', 'transport_error', 'token_bounds'] as const) {
  test(`after_response sees conservative accounting before ${scenario} completes`, async () => {
    const ledger = ledgerFixture(); let after = 0;
    let observed: ReturnType<SpendLedger['status']> = null;
    const transport = ledger.guardedFetch('deepseek', fakeFetch(() => {
      if (scenario === 'transport_error') throw new Error('offline failure');
      if (scenario === 'http_error') return Response.json({ error: 'offline overload' }, { status: 529 });
      if (scenario === 'invalid_json') return new Response('{broken', { headers: { 'content-type': 'application/json' } });
      if (scenario === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://invalid.example/' } });
      return Response.json(receiptBody({ usage: scenario === 'missing_usage' ? {} : {
        input_tokens: 10, output_tokens: MAX_TOKENS + 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      } }));
    }));
    await ledger.withPaidRequestGuard(phase => {
      if (phase !== 'after_response') return;
      after++; observed = ledger.status(TICKET);
    }, () => send(ledger, transport)).catch(() => undefined);
    expect(after).toBe(1);
    expect(observed).toMatchObject({ attemptCount: 1, unknownAttempts: 1, chargedMicros: RESERVED,
      ...(scenario === 'token_bounds' ? { state: 'closed' } : {}) });
  });
}

test('nested guards cannot bypass outer denial and restore after rejection and awaited success', async () => {
  const ledger = ledgerFixture(); let sends = 0; let outerDenied = true;
  const events: string[] = [];
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => { sends++; return Response.json(receiptBody()); }));
  const outer = (phase: PaidRequestGuardPhase) => { events.push(`outer:${phase}`); if (outerDenied) throw new Error('outer denied'); };
  await ledger.withPaidRequestGuard(outer, async () => {
    await expect(ledger.withPaidRequestGuard(() => {}, () => send(ledger, transport))).rejects.toThrow('outer denied');
    outerDenied = false;
    await expect(ledger.withPaidRequestGuard(() => { throw new Error('inner denied'); }, () => send(ledger, transport))).rejects.toThrow('inner denied');
    events.length = 0;
    await ledger.withPaidRequestGuard(phase => { events.push(`inner:${phase}`); }, async () => {
      await Promise.resolve(); await send(ledger, transport);
    });
    await send(ledger, transport);
  });
  const recorded = [...events]; await send(ledger, transport);
  expect(events).toEqual(recorded); expect(sends).toBe(3);
  expect(events).toEqual([
    'outer:before_request', 'inner:before_request', 'outer:before_send', 'inner:before_send', 'outer:after_response', 'inner:after_response',
    'outer:before_request', 'outer:before_send', 'outer:after_response',
  ]);
  expect(ledger.status(TICKET)).toMatchObject({ attemptCount: 3, unknownAttempts: 0 });
});

test('guard contexts are isolated between concurrent branches and ledger instances', async () => {
  const a = ledgerFixture(), b = ledgerFixture(); const seen: string[] = [];
  const transportA = a.guardedFetch('deepseek', fakeFetch(() => Response.json(receiptBody())));
  const transportB = b.guardedFetch('deepseek', fakeFetch(() => Response.json(receiptBody())));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const blockedBranch = a.withPaidRequestGuard(() => { throw new Error('branch A denied'); }, async () => {
    await gate;
    await send(b, transportB); // A ledger's guard cannot leak into B's transport.
    await expect(send(a, transportA)).rejects.toThrow('branch A denied');
  });
  await a.withPaidRequestGuard(phase => { seen.push(phase); }, async () => {
    await Promise.resolve(); await send(a, transportA);
  });
  release(); await blockedBranch;
  expect(seen).toEqual(['before_request', 'before_send', 'after_response']);
  expect(a.status(TICKET)?.attemptCount).toBe(1); expect(b.status(TICKET)?.attemptCount).toBe(1);
});

for (const returned of [true, null, 'accepted', Promise.resolve()] as const) {
  test(`non-void guard return ${String(returned)} fails before paid work`, async () => {
    const ledger = ledgerFixture(); let sends = 0;
    const transport = ledger.guardedFetch('deepseek', fakeFetch(() => { sends++; return Response.json(receiptBody()); }));
    await expect(ledger.withPaidRequestGuard(() => returned, () => send(ledger, transport))).rejects.toThrow();
    expect(sends).toBe(0); expect(ledger.status(TICKET)?.attemptCount).toBe(0);
  });
}

for (const first of ['http_error', 'missing_usage'] as const) {
  test(`real SDK retries after ${first} cannot bypass the unknown-attempt guard`, async () => {
    const ledger = ledgerFixture(); let sends = 0, admissions = 0;
    const transport = ledger.guardedFetch('deepseek', fakeFetch(() => {
      sends++;
      return first === 'http_error' ? Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'offline' } }, { status: 529 })
        : Response.json(receiptBody({ usage: {} }));
    }));
    const client = new Anthropic({ authToken: 'offline-only', baseURL: 'https://api.deepseek.com/anthropic', maxRetries: 1, fetch: transport });
    await expect(ledger.withPaidRequestGuard(phase => {
      if (phase === 'before_request') admissions++;
      // The just-reserved send may have one pending attempt; every other edge requires settled usage.
      if (ledger.status(TICKET)!.unknownAttempts > (phase === 'before_send' ? 1 : 0)) throw new Error('unknown paid attempt');
    }, () => ledger.withSpendScope(TICKET, async () => await client.messages.create({ model: 'deepseek-v4-pro', max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: 'offline fixture' }] })))).rejects.toThrow();
    expect(admissions).toBe(2); expect(sends).toBe(1);
    expect(ledger.status(TICKET)).toMatchObject({ attemptCount: 1, unknownAttempts: 1, chargedMicros: RESERVED });
  });
}

test('no installed guard preserves legacy unknown receipts and subsequent eligible requests', async () => {
  const ledger = ledgerFixture(); let sends = 0;
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => {
    sends++; return Response.json(receiptBody(sends === 1 ? { usage: {} } : {}));
  }));
  expect((await send(ledger, transport)).ok).toBe(true);
  expect((await send(ledger, transport)).ok).toBe(true);
  expect(sends).toBe(2);
  expect(ledger.status(TICKET)).toMatchObject({ attemptCount: 2, unknownAttempts: 1, chargedMicros: RESERVED + SETTLED });
});


test('after_response denial awaits cancellation of an unread HTTP error body', async () => {
  const ledger = ledgerFixture(); let cancelled = false;
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":"offline overload"}')); },
    async cancel() { await Promise.resolve(); cancelled = true; },
  }), { status: 529, headers: { 'content-type': 'application/json' } })));
  await expect(ledger.withPaidRequestGuard(phase => {
    if (phase === 'after_response') throw new Error('discard unknown response');
  }, () => send(ledger, transport))).rejects.toThrow('discard unknown response');
  expect(cancelled).toBe(true);
  expect(ledger.status(TICKET)).toMatchObject({ attemptCount: 1, unknownAttempts: 1, chargedMicros: RESERVED });
});

test('a rejecting Promise returned by a guard is consumed and fails closed before send', async () => {
  const ledger = ledgerFixture(); let sends = 0;
  const transport = ledger.guardedFetch('deepseek', fakeFetch(() => { sends++; return Response.json(receiptBody()); }));
  await expect(ledger.withPaidRequestGuard(() => Promise.reject(new Error('async guards are forbidden')),
    () => send(ledger, transport))).rejects.toThrow();
  await Promise.resolve();
  expect(sends).toBe(0); expect(ledger.status(TICKET)?.attemptCount).toBe(0);
});
