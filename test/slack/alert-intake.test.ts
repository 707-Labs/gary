import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSlackAlertIntake, type SlackAlertIntakeOptions } from '../../src/slack/alert-intake.ts';
import { ALERT_INTAKE_POLICY as P } from '../../src/slack/alert-contract.ts';
import type { SlackChannelMetadata, SlackTransport } from '../../src/slack/transport.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const CLOCK = 1_791_504_000_000;
const producer = { botId: 'B0AJNH6K4LF', appId: 'A0AK0JCN5PF' };
function event(id = 'EvFIXTURE001', ts = `${CLOCK / 1000}.000001`, eventChanges: Record<string, unknown> = {}, payloadChanges: Record<string, unknown> = {}) {
  return { type: 'events_api', envelope_id: 'fixture-envelope', payload: { type: 'event_callback',
    team_id: P.teamId, api_app_id: P.appId, event_id: id, event_time: Math.floor(Number(ts)), is_ext_shared_channel: false,
    event: { type: 'message', channel: P.channelId, channel_type: 'channel', subtype: 'bot_message',
      bot_id: producer.botId, app_id: producer.appId, ts, event_ts: ts,
      text: 'UNTRUSTED_PRIVATE_PAYLOAD <@U0SOMEONE> https://untrusted.example',
      attachments: [{ title: '🚨 Error Alert', fields: [
        { title: 'Event', value: 'runtime_failure' }, { title: 'Worker', value: 'frontend' },
        { title: 'Error', value: 'Workers runtime outcome: exceededCpu' },
        { title: 'Stack Trace', value: 'PRIVATE_STACK_OR_INSTRUCTIONS' },
      ] }], ...eventChanges }, ...payloadChanges } };
}
function metadata(at = CLOCK): SlackChannelMetadata {
  return { id: P.channelId, teamId: P.teamId, isMember: true, isArchived: false, isPrivate: false,
    isShared: false, isExtShared: false, isOrgShared: false, isPendingExtShared: false, observedAt: at };
}
function fixture(extra: Partial<SlackAlertIntakeOptions> = {}) {
  const db = extra.db ?? new Database(':memory:', { strict: true });
  if (!extra.db) cleanups.push(() => db.close());
  let clock = CLOCK, reads = 0;
  const sends: Array<{ channel: string; text: string; threadTs?: string }> = [];
  let read: NonNullable<SlackTransport['channelInfo']> = async () => metadata(clock);
  let send: SlackTransport['sendMessage'] = async args => ({ ok: true, channel: args.channel, ts: `${Math.floor(clock / 1000)}.999999` });
  const transport = { channelInfo: async (channel: string, signal?: AbortSignal) => { reads++; expect(channel).toBe(P.channelId); return read(channel, signal); },
    sendMessage: async (args: Parameters<SlackTransport['sendMessage']>[0], signal?: AbortSignal) => { sends.push(args); return send(args, signal); } };
  const intake = createSlackAlertIntake({ db, transport, producer, mode: 'draft', now: () => clock, ...extra });
  const handle = (value: unknown = event(), signal?: AbortSignal, available?: () => boolean, size: number | undefined = 1024) => intake.handle(value, signal, available, size);
  return { db, intake, handle, sends, transport, get reads() { return reads; },
    set read(value: NonNullable<SlackTransport['channelInfo']>) { read = value; },
    set send(value: SlackTransport['sendMessage']) { send = value; },
    get clock() { return clock; }, set clock(value: number) { clock = value; } };
}
const rows = (db: Database) => db.query('SELECT * FROM alert_messages ORDER BY message_ts').all() as any[];
const state = (db: Database) => db.query('SELECT * FROM alert_control').get() as any;
const outbox = (db: Database) => db.query('SELECT * FROM alert_outbox ORDER BY message_ts').all() as any[];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('construction is inert; exact scope and raw-frame evidence are required before metadata or storage', async () => {
  const f = fixture();
  expect(f.db.query('SELECT * FROM sqlite_master').all()).toEqual([]);
  expect(await f.handle()).toEqual({ kind: 'unavailable' });
  f.intake.initialize(); const before = JSON.stringify(f.db.query('SELECT * FROM alert_counters').all());
  for (const candidate of [null, {}, event(undefined, undefined, { channel: 'C0OTHER000' }), event(undefined, undefined, {}, { team_id: 'TFOREIGN' }),
    event(undefined, undefined, { channel: 'D0PRIVATE00' }), event(undefined, undefined, {}, { api_app_id: 'AFOREIGN' })]) {
    expect(await f.handle(candidate)).toEqual({ kind: 'ignored' });
  }
  for (const size of [0, -1, NaN, 65537, 1.5]) expect(await f.handle(event(), undefined, undefined, size)).toEqual({ kind: 'rejected' });
  expect(await f.intake.handle(event())).toEqual({ kind: 'rejected' });
  expect(f.reads).toBe(0); expect(f.sends).toEqual([]); expect(rows(f.db)).toEqual([]);
  expect(JSON.stringify(f.db.query('SELECT * FROM alert_counters').all())).toBe(before);
});
test('draft saves only fixed normalized evidence/advisory and no outbox or raw content', async () => {
  const f = fixture(); f.intake.initialize(); expect(await f.handle()).toEqual({ kind: 'drafted' });
  expect(rows(f.db)).toHaveLength(1); expect(rows(f.db)[0].state).toBe('draft');
  expect(rows(f.db)[0].advisory).toContain('User impact and cause are unconfirmed');
  expect(JSON.stringify(rows(f.db))).not.toMatch(/UNTRUSTED|PRIVATE_STACK|untrusted\.example/);
  expect(outbox(f.db)).toEqual([]); expect(f.sends).toEqual([]); expect(f.intake.ready()).toBe(true);
});
test('publish commits unknown delivery before one same-thread send and persists verified receipt', async () => {
  const f = fixture({ mode: 'publish' }); f.intake.initialize();
  f.send = async args => {
    expect(outbox(f.db)).toEqual([{ message_ts: `${CLOCK / 1000}.000001`, status: 'unknown', receipt_ts: null }]);
    expect(rows(f.db)[0].state).toBe('pending'); expect(state(f.db).phase).toBe('active');
    expect(f.db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(args.channel).toBe(P.channelId); expect(args.threadTs).toBe(`${CLOCK / 1000}.000001`);
    return { ok: true, channel: P.channelId, ts: `${CLOCK / 1000}.999999` };
  };
  expect(await f.handle()).toEqual({ kind: 'sent' }); expect(f.sends).toHaveLength(1);
  expect(outbox(f.db)[0]).toMatchObject({ status: 'sent', receipt_ts: `${CLOCK / 1000}.999999` });
  expect(await f.handle()).toEqual({ kind: 'duplicate' }); expect(f.sends).toHaveLength(1);
});
test('event/message associations reject conflicts and remember alternate event IDs without new work', async () => {
  const f = fixture(); f.intake.initialize(); await f.handle();
  expect(await f.handle(event('EvALIAS0001'))).toEqual({ kind: 'duplicate' });
  expect(await f.handle(event('EvALIAS0001', `${CLOCK / 1000}.000002`))).toEqual({ kind: 'conflict' });
  expect(await f.handle(event('EvFIXTURE001', `${CLOCK / 1000}.000003`))).toEqual({ kind: 'conflict' });
  expect(rows(f.db)).toHaveLength(1); expect(f.db.query('SELECT * FROM alert_events').all()).toHaveLength(2);
});
test('bounded alias storage halts instead of dropping identity associations', async () => {
  const f = fixture(); f.intake.initialize(); await f.handle();
  for (let i = 0; i < 15; i++) expect(await f.handle(event(`EvALIAS000${i}`))).toEqual({ kind: 'duplicate' });
  expect(await f.handle(event('EvOVERFLOW000'))).toEqual({ kind: 'halted' });
  expect(state(f.db).reason).toBe('alias_limit'); expect(f.db.query('SELECT * FROM alert_events').all()).toHaveLength(16);
});
test('five-per-rolling-hour bound survives new intake instances and expires only past the boundary', async () => {
  const f = fixture(); f.intake.initialize();
  for (let i = 1; i <= 5; i++) expect(await f.handle(event(`EvSLOT000${i}`, `${CLOCK / 1000}.00000${i}`))).toEqual({ kind: 'drafted' });
  const restart = fixture({ db: f.db }); restart.intake.initialize();
  expect(await restart.handle(event('EvSLOT0006', `${CLOCK / 1000}.000006`))).toEqual({ kind: 'limited' });
  restart.clock += 60 * 60_000;
  expect(await restart.handle(event('EvNEXT0001', `${restart.clock / 1000}.000001`))).toEqual({ kind: 'limited' });
  restart.clock += 1000;
  expect(await restart.handle(event('EvNEXT0001', `${restart.clock / 1000}.000001`))).toEqual({ kind: 'drafted' });
});
test('seven-day collection removes terminal keys but freshness independently rejects old replay', async () => {
  const f = fixture(); f.intake.initialize(); await f.handle(); f.clock += 7 * 24 * 60 * 60_000 + 1000;
  expect(await f.handle()).toEqual({ kind: 'rejected' });
  // Stale input cannot trigger any retention mutation. A fresh eligible event
  // performs bounded collection, and the old message still cannot reenter.
  expect(await f.handle(event('EvFRESH0001', `${f.clock / 1000}.000001`))).toEqual({ kind: 'drafted' });
  expect(rows(f.db)).toHaveLength(1); expect(rows(f.db)[0].event_id).toBe('EvFRESH0001');
  expect(await f.handle()).toEqual({ kind: 'rejected' });
});
test('unknown send blocks all later work and remains latched after restart and retention age', async () => {
  const f = fixture({ mode: 'publish' }); f.intake.initialize(); f.send = async () => ({ ok: false, outcome: 'unknown', code: 'private details' });
  expect(await f.handle()).toEqual({ kind: 'halted' }); expect(outbox(f.db)[0].status).toBe('unknown');
  const next = fixture({ db: f.db, mode: 'publish' }); next.clock += 8 * 24 * 60 * 60_000; next.intake.initialize();
  expect(await next.handle(event('EvNEXT0001', `${next.clock / 1000}.000001`))).toEqual({ kind: 'halted' });
  expect(next.reads).toBe(0); expect(next.sends).toEqual([]); expect(rows(f.db)).toHaveLength(1);
  expect(JSON.stringify(state(f.db))).not.toContain('private details');
});
test('definite rejection is terminal without automatic resend, and permits other fresh messages', async () => {
  const f = fixture({ mode: 'publish' }); f.intake.initialize(); f.send = async () => ({ ok: false, outcome: 'definitely_not_sent', code: 'rate_limited' });
  expect(await f.handle()).toEqual({ kind: 'not_sent' }); expect(await f.handle()).toEqual({ kind: 'duplicate' });
  expect(await f.handle(event('EvSECOND001', `${CLOCK / 1000}.000002`))).toEqual({ kind: 'not_sent' });
  expect(f.sends).toHaveLength(2); expect(f.intake.ready()).toBe(true);
});
test('mismatched success receipt or thrown send stays unknown without leaking errors', async () => {
  for (const send of [async () => ({ ok: true as const, channel: 'C0OTHER000', ts: `${CLOCK / 1000}.999999` }),
    async () => ({ ok: true as const, channel: P.channelId, ts: 'invalid' }), async () => { throw new Error('PRIVATE_ERROR'); }]) {
    const f = fixture({ mode: 'publish' }); f.intake.initialize(); f.send = send;
    expect(await f.handle()).toEqual({ kind: 'halted' }); expect(outbox(f.db)[0].status).toBe('unknown');
    expect(JSON.stringify(state(f.db))).not.toContain('PRIVATE_ERROR');
  }
});
test('only one metadata operation can run; durable active lease excludes a second instance', async () => {
  const wait = deferred<SlackChannelMetadata>(), f = fixture(); f.intake.initialize(); f.read = () => wait.promise;
  const running = f.handle(); await tick();
  expect(await f.handle(event('EvSECOND001', `${CLOCK / 1000}.000002`))).toEqual({ kind: 'busy' });
  const other = fixture({ db: f.db }); other.intake.initialize(); expect(other.intake.ready()).toBe(false);
  expect(await other.handle()).toEqual({ kind: 'halted' }); expect(other.reads).toBe(0);
  wait.resolve(metadata()); expect(await running).toEqual({ kind: 'drafted' }); expect(f.reads).toBe(1);
});
test('metadata deadline returns promptly, cancellation propagates and unresolved operation keeps drain false', async () => {
  const wait = deferred<SlackChannelMetadata>(), f = fixture({ deadlineMs: 5 }); f.intake.initialize(); let signal: AbortSignal | undefined;
  f.read = (_channel, received) => { signal = received; return wait.promise; };
  expect(await f.handle()).toEqual({ kind: 'halted' }); expect(signal?.aborted).toBe(true);
  expect(await f.intake.drain()).toEqual({ drained: false }); expect(f.intake.close()).toEqual({ drained: false });
  wait.resolve(metadata()); await tick(); expect(await f.intake.drain()).toEqual({ drained: true });
  expect(state(f.db).phase).toBe('halted'); expect(rows(f.db)).toEqual([]); expect(f.sends).toEqual([]);
});
test('send deadline leaves unknown outbox even if transport later reports success', async () => {
  const wait = deferred<Awaited<ReturnType<SlackTransport['sendMessage']>>>(), f = fixture({ deadlineMs: 5, mode: 'publish' }); f.intake.initialize();
  f.send = () => wait.promise; expect(await f.handle()).toEqual({ kind: 'halted' });
  expect(outbox(f.db)[0].status).toBe('unknown'); wait.resolve({ ok: true, channel: P.channelId, ts: `${CLOCK / 1000}.999999` }); await tick();
  expect(outbox(f.db)[0].status).toBe('unknown'); expect(f.intake.ready()).toBe(false);
});
test('shutdown aborts read and never permits late work, and pre-aborted input has no effects', async () => {
  const f = fixture(); f.intake.initialize(); const aborted = new AbortController(); aborted.abort();
  expect(await f.handle(event(), aborted.signal)).toEqual({ kind: 'unavailable' }); expect(f.reads).toBe(0);
  const wait = deferred<SlackChannelMetadata>(); f.read = () => wait.promise; const running = f.handle(); await tick();
  expect(f.intake.close()).toEqual({ drained: false }); expect(await running).toEqual({ kind: 'halted' });
  wait.resolve(metadata()); await tick(); expect(rows(f.db)).toEqual([]); expect(f.sends).toEqual([]);
  expect(await f.handle()).toEqual({ kind: 'unavailable' });
});
test('unavailable health before or after metadata prevents claims and sends', async () => {
  const f = fixture({ mode: 'publish' }); f.intake.initialize(); let available = false;
  expect(await f.handle(event(), undefined, () => available)).toEqual({ kind: 'unavailable' }); expect(f.reads).toBe(0);
  available = true; f.read = async () => { available = false; return metadata(); };
  expect(await f.handle(event(), undefined, () => available)).toEqual({ kind: 'unavailable' }); expect(f.sends).toEqual([]); expect(rows(f.db)).toEqual([]);
});
test('foreign or stale channel metadata, warnings and replay are rejected/suppressed without content persistence', async () => {
  for (const change of [{ isShared: true }, { isMember: false }, { teamId: 'TFOREIGN' }, { observedAt: CLOCK - 60_001 }]) {
    const f = fixture(); f.intake.initialize(); f.read = async () => ({ ...metadata(), ...change });
    expect(await f.handle()).toEqual({ kind: 'rejected' }); expect(rows(f.db)).toEqual([]);
  }
  const f = fixture(); f.intake.initialize(); expect(await f.handle(event(undefined, undefined, { attachments: [] }))).toEqual({ kind: 'suppressed' });
  expect(await f.handle(event(undefined, `${CLOCK / 1000 - 901}.000001`))).toEqual({ kind: 'rejected' });
  expect(rows(f.db)).toEqual([]); expect(f.sends).toEqual([]);
});
test('storage failures, metadata exceptions and backwards trusted clock halt safely', async () => {
  const f = fixture(); f.intake.initialize(); f.read = async () => { throw new Error('PRIVATE_SECRET'); };
  expect(await f.handle()).toEqual({ kind: 'halted' }); expect(state(f.db).reason).toBe('uncertain');
  const clock = fixture(); clock.intake.initialize(); await clock.handle(); clock.clock--;
  expect(await clock.handle()).toEqual({ kind: 'halted' }); expect(state(clock.db).reason).toBe('clock');
  const bad = fixture(); bad.intake.initialize(); bad.db.exec('DROP TABLE alert_counters');
  expect(await bad.handle()).toEqual({ kind: 'halted' }); expect(bad.sends).toEqual([]);
});
test('initialization verifies FULL sync and rejects unrelated/canonical schemas before mutations', () => {
  const f = fixture(); f.db.exec('PRAGMA synchronous=NORMAL'); f.intake.initialize();
  expect(f.db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
  const unrelated = fixture(); unrelated.db.exec('CREATE TABLE actions (id TEXT)');
  expect(() => unrelated.intake.initialize()).toThrow('alert_database_not_dedicated');
  expect(unrelated.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'alert_%'").all()).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), 'alert-intake-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new Database(join(root, 'gary.db')); cleanups.push(() => db.close());
  const canonical = fixture({ db }); expect(() => canonical.intake.initialize()).toThrow('alert_database_not_dedicated');
});
test('ledger policy binding refuses changed producer, mode or deadline and preserves prior rows', async () => {
  const f = fixture(); f.intake.initialize(); await f.handle();
  for (const changed of [{ mode: 'publish' as const }, { producer: { ...producer, appId: 'A0CHANGED00' } }, { deadlineMs: 999 }]) {
    const other = fixture({ db: f.db, ...changed }); expect(() => other.intake.initialize()).toThrow('alert_binding_rejected');
  }
  expect(rows(f.db)).toHaveLength(1); expect(outbox(f.db)).toEqual([]);
});
test('restart over real SQLite file preserves unknown send and never retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alert-intake-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'alerts.sqlite'); const db = new Database(path, { strict: true });
  const f = fixture({ db, mode: 'publish' }); f.intake.initialize(); f.send = async () => ({ ok: false, outcome: 'unknown', code: 'fixture' }); await f.handle(); db.close();
  const reopened = new Database(path, { strict: true }); cleanups.push(() => reopened.close());
  const next = fixture({ db: reopened, mode: 'publish' }); next.intake.initialize();
  expect(await next.handle()).toEqual({ kind: 'halted' }); expect(next.reads).toBe(0); expect(next.sends).toEqual([]);
});
test('counters saturate without a per-rejection or overflow queue', async () => {
  const f = fixture(); f.intake.initialize(); f.db.query("UPDATE alert_counters SET value=2147483647 WHERE name='suppressed'").run();
  for (let i = 0; i < 3; i++) await f.handle(event(undefined, undefined, { attachments: [] }));
  expect(f.db.query("SELECT value FROM alert_counters WHERE name='suppressed'").get()).toEqual({ value: 2147483647 });
  expect(f.db.query('SELECT count(*) AS n FROM alert_counters').get()).toEqual({ n: 12 }); expect(rows(f.db)).toEqual([]);
});
test('each durable transition rechecks FULL sync before a send', async () => {
  const f = fixture({ mode: 'publish' }); f.intake.initialize();
  f.read = async () => { f.db.exec('PRAGMA synchronous=NORMAL'); return metadata(); };
  expect(await f.handle()).toEqual({ kind: 'halted' }); expect(f.sends).toEqual([]);
  // Failure to persist a halt still leaves the earlier active lease durable.
  expect(state(f.db).phase).toBe('active'); expect(rows(f.db)).toEqual([]);
});
test('positive content-free validation counter distinguishes a scoped warning from failed metadata', async () => {
  const f = fixture(); f.intake.initialize();
  expect(await f.handle(event(undefined, undefined, { attachments: [] }))).toEqual({ kind: 'suppressed' });
  expect(f.db.query("SELECT value FROM alert_counters WHERE name='validated'").get()).toEqual({ value: 1 });
  f.read = async () => ({ ...metadata(), isShared: true });
  expect(await f.handle()).toEqual({ kind: 'rejected' });
  expect(f.db.query("SELECT value FROM alert_counters WHERE name='validated'").get()).toEqual({ value: 1 });
  expect(rows(f.db)).toEqual([]);
});
test('independent initialized SQLite connections cannot overlap metadata or send', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alert-intake-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'alerts.sqlite');
  const firstDb = new Database(path, { strict: true }), secondDb = new Database(path, { strict: true });
  cleanups.push(() => { firstDb.close(); secondDb.close(); });
  const first = fixture({ db: firstDb }), second = fixture({ db: secondDb }); first.intake.initialize(); second.intake.initialize();
  const wait = deferred<SlackChannelMetadata>(); first.read = () => wait.promise;
  const active = first.handle(); await tick();
  expect(await second.handle(event('EvSECOND001', `${CLOCK / 1000}.000002`))).toEqual({ kind: 'busy' });
  expect(second.reads).toBe(0); expect(second.sends).toEqual([]);
  wait.resolve(metadata()); expect(await active).toEqual({ kind: 'drafted' });
  expect(await second.handle(event('EvSECOND001', `${CLOCK / 1000}.000002`))).toEqual({ kind: 'drafted' });
  expect(rows(firstDb)).toHaveLength(2);
});
test('untrusted producer, timestamps, subtype, scope and malformed content cannot initiate a metadata read or lease', async () => {
  const f = fixture(); f.intake.initialize();
  for (const value of [event(undefined, undefined, { bot_id: 'B0FOREIGN00' }), event(undefined, undefined, { app_id: 'A0FOREIGN00' }),
    event(undefined, undefined, { subtype: 'message_changed' }), event(undefined, `${CLOCK / 1000 - 901}.000001`),
    event(undefined, undefined, {}, { is_ext_shared_channel: true }), event(undefined, undefined, { attachments: 'bad' }),
    event(undefined, undefined, { text: 'x'.repeat(8193) })]) expect(await f.handle(value)).toEqual({ kind: 'rejected' });
  expect(f.reads).toBe(0); expect(rows(f.db)).toEqual([]); expect(state(f.db)).toMatchObject({ phase: 'idle', owner: null, last_clock: 0 });
  expect(f.db.query("SELECT value FROM alert_counters WHERE name='validated'").get()).toEqual({ value: 0 });
  const unbound = fixture({ producer: null }); unbound.intake.initialize(); expect(await unbound.handle()).toEqual({ kind: 'rejected' }); expect(unbound.reads).toBe(0);
});
