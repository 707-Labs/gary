/** Dedicated, zero-model alert ledger. This module never opens Gary's state/spend files. */
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ALERT_INTAKE_POLICY as P, decideAlertEnvelope, preflightAlertEnvelope, type AlertProducerBinding } from './alert-contract.ts';
import type { SlackTransport } from './transport.ts';

export interface SlackAlertIntakeOptions {
  /** Caller-owned, private, dedicated database; initialize refuses unrelated schemas. */
  db: Database;
  transport: Pick<SlackTransport, 'channelInfo' | 'sendMessage'>;
  producer: AlertProducerBinding | null;
  mode: 'draft' | 'publish';
  now?: () => number;
  /** May tighten the production ceiling; part of the immutable ledger binding. */
  deadlineMs?: number;
}
export type AlertHandleKind = 'ignored' | 'unavailable' | 'rejected' | 'suppressed' | 'duplicate'
  | 'conflict' | 'limited' | 'busy' | 'drafted' | 'sent' | 'not_sent' | 'halted';
export interface AlertHandleResult { readonly kind: AlertHandleKind }
export interface SlackAlertIntake {
  initialize(): void;
  /** rawBytes must be the transport's measured frame size, not a serialized estimate. */
  handle(envelope: unknown, signal?: AbortSignal, available?: () => boolean, rawBytes?: number): Promise<AlertHandleResult>;
  ready(): boolean;
  close(): { drained: boolean };
  /** Bounded by the current handle deadline; false retains an unresolved operation. */
  drain(): Promise<{ drained: boolean }>;
}

const APPLICATION_ID = 0x47414c54;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_ALIASES = 16;
const COUNTERS = ['rejected', 'suppressed', 'duplicate', 'conflict', 'limited', 'busy', 'validated', 'accepted', 'drafted', 'sent', 'not_sent', 'halted'] as const;
type Counter = typeof COUNTERS[number];
const TABLES = [
  `CREATE TABLE alert_control (id INTEGER PRIMARY KEY CHECK (id = 1), binding TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('idle','active','halted')), owner TEXT, last_clock INTEGER NOT NULL, reason TEXT)`,
  `CREATE TABLE alert_messages (message_ts TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, accepted_at INTEGER NOT NULL, evidence TEXT NOT NULL, advisory TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('draft','pending','sent','not_sent')))`,
  `CREATE TABLE alert_events (event_id TEXT PRIMARY KEY, message_ts TEXT NOT NULL REFERENCES alert_messages(message_ts) ON DELETE CASCADE)`,
  `CREATE TABLE alert_outbox (message_ts TEXT PRIMARY KEY REFERENCES alert_messages(message_ts) ON DELETE CASCADE, status TEXT NOT NULL CHECK (status IN ('unknown','sent','not_sent')), receipt_ts TEXT)`,
  `CREATE TABLE alert_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 2147483647))`,
] as const;
interface Control { binding: string; phase: 'idle' | 'active' | 'halted'; owner: string | null; last_clock: number; reason: string | null }
const outcome = (kind: AlertHandleKind): AlertHandleResult => ({ kind });
const safeClock = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{10}\.\d{6}$/.test(value);
const ownValue = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

/** Used only to exclude unrelated bodies before any read or ledger mutation. */
function candidate(envelope: unknown): boolean {
  const payload = ownValue(envelope, 'payload');
  return ownValue(envelope, 'type') === 'events_api' && ownValue(payload, 'type') === 'event_callback'
    && ownValue(payload, 'team_id') === P.teamId && ownValue(payload, 'api_app_id') === P.appId
    && ownValue(ownValue(payload, 'event'), 'channel') === P.channelId;
}

export function createSlackAlertIntake(options: SlackAlertIntakeOptions): SlackAlertIntake {
  const { db, transport, mode } = options;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? 60_000;
  if ((mode !== 'draft' && mode !== 'publish') || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000
    || typeof transport.channelInfo !== 'function' || typeof transport.sendMessage !== 'function') throw new Error('alert_configuration_rejected');
  const producer = options.producer === null ? null : Object.freeze({ ...options.producer });
  if (producer && (!/^B[A-Z0-9]{5,63}$/.test(producer.botId) || !/^A[A-Z0-9]{5,63}$/.test(producer.appId)
    || producer.botId === P.botId || producer.appId === P.appId)) throw new Error('alert_configuration_rejected');
  const binding = createHash('sha256').update(JSON.stringify({ version: 1, policy: P, producer, mode,
    deadlineMs, perHour: 5, retentionMs: RETENTION_MS, maxAliases: MAX_ALIASES })).digest('hex');
  let initialized = false, closed = false, localHalt = false;
  let active: { cancel(): void; result: Promise<AlertHandleResult>; settled: boolean } | undefined;

  function control(): Control {
    const row = db.query<Control, []>('SELECT binding,phase,owner,last_clock,reason FROM alert_control WHERE id=1').get();
    if (!row || row.binding !== binding) throw new Error('alert_binding_rejected');
    return row;
  }
  function count(name: Counter): void {
    db.query('UPDATE alert_counters SET value = min(value + 1, 2147483647) WHERE name=?').run(name);
  }
  function transaction<T>(operation: () => T): T {
    if (db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous !== 2
      || db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('alert_durability_unverified');
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
  }
  function halt(owner: string, reason: 'uncertain' | 'clock' | 'storage' | 'alias_limit'): void {
    localHalt = true;
    try {
      transaction(() => {
        const row = control();
        if (row.phase === 'active' && row.owner === owner) {
          db.query("UPDATE alert_control SET phase='halted',reason=? WHERE id=1").run(reason);
          count('halted');
        }
      });
    } catch { /* The durable active claim already blocks restart; never continue locally. */ }
  }
  function initialize(): void {
    if (closed) throw new Error('alert_closed');
    if (initialized) return;
    // Validate before changing any PRAGMA. A caller passing Gary/spend state is rejected.
    const files = db.query<{ file: string }, []>('PRAGMA database_list').all();
    if (files.length !== 1 || files.some(value => /^(gary|spend)([.-]|$)/i.test(basename(value.file)))) throw new Error('alert_database_not_dedicated');
    const schema = db.query<{ name: string; type: string; sql: string | null }, []>(
      "SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
    const expected = TABLES.map(sql => ({ name: sql.split(' ')[2]!, type: 'table', sql })).sort((a, b) => a.name.localeCompare(b.name));
    if (schema.length && JSON.stringify(schema) !== JSON.stringify(expected)) throw new Error('alert_database_not_dedicated');
    const application = db.query<{ application_id: number }, []>('PRAGMA application_id').get()!.application_id;
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    if (schema.length ? application !== APPLICATION_ID || version !== 1 : application !== 0 || version !== 0) throw new Error('alert_database_not_dedicated');
    if (schema.length && control().binding !== binding) throw new Error('alert_binding_rejected');
    try {
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      if (db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous !== 2
        || db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error();
    } catch { throw new Error('alert_durability_unverified'); }
    if (!schema.length) transaction(() => {
      for (const sql of TABLES) db.exec(sql);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      db.exec('PRAGMA user_version = 1');
      db.query("INSERT INTO alert_control VALUES (1,?,'idle',NULL,0,NULL)").run(binding);
      for (const name of COUNTERS) db.query('INSERT INTO alert_counters VALUES (?,0)').run(name);
    });
    const counters = db.query<{ name: string }, []>('SELECT name FROM alert_counters ORDER BY name').all().map(row => row.name);
    if (JSON.stringify(counters) !== JSON.stringify([...COUNTERS].sort())) throw new Error('alert_ledger_rejected');
    const state = control();
    // A crash during metadata or send is never interpreted as permission to retry.
    localHalt = state.phase !== 'idle'
      || !!db.query("SELECT 1 FROM alert_messages WHERE state='pending' LIMIT 1").get()
      || !!db.query("SELECT 1 FROM alert_outbox WHERE status='unknown' LIMIT 1").get();
    initialized = true;
  }
  function ready(): boolean {
    if (!initialized || closed || localHalt || active) return false;
    try { return control().phase === 'idle'; } catch { localHalt = true; return false; }
  }
  async function handle(envelope: unknown, signal?: AbortSignal, available: () => boolean = () => true, rawBytes?: number): Promise<AlertHandleResult> {
    if (!candidate(envelope)) return outcome('ignored');
    if (!Number.isSafeInteger(rawBytes) || rawBytes! <= 0 || rawBytes! > P.rawBytes) return outcome('rejected');
    if (!initialized || closed || signal?.aborted) return outcome('unavailable');
    if (localHalt) return outcome('halted');
    try { if (!available()) return outcome('unavailable'); } catch { return outcome('unavailable'); }
    const deadlineAt = performance.now() + deadlineMs;
    // All untrusted producer, timestamp, scope and content checks precede a read
    // or durable operation claim. Final dispatch reruns the complete contract.
    try {
      if (preflightAlertEnvelope(envelope, { nowMs: now(), producer }).kind === 'rejected') {
        count('rejected'); return outcome('rejected');
      }
    } catch { localHalt = true; return outcome('halted'); }
    if (active) { try { count('busy'); } catch { localHalt = true; } return outcome(localHalt ? 'halted' : 'busy'); }
    const owner = randomUUID();
    let admitted: AlertHandleResult | undefined;
    try {
      admitted = transaction(() => {
        const row = control(), at = now();
        if (row.phase !== 'idle') { count('busy'); return outcome(row.phase === 'halted' ? 'halted' : 'busy'); }
        if (!safeClock(at) || at < row.last_clock) {
          db.query("UPDATE alert_control SET phase='halted',reason='clock' WHERE id=1").run();
          count('halted'); localHalt = true; return outcome('halted');
        }
        // Unknown/pending never expire; only completed records are collected.
        db.query("DELETE FROM alert_messages WHERE accepted_at < ? AND state != 'pending' AND NOT EXISTS (SELECT 1 FROM alert_outbox o WHERE o.message_ts=alert_messages.message_ts AND o.status='unknown')").run(at - RETENTION_MS);
        db.query("UPDATE alert_control SET phase='active',owner=?,last_clock=?,reason=NULL WHERE id=1").run(owner, at);
        return undefined;
      });
    } catch { localHalt = true; return outcome('halted'); }
    if (admitted) return admitted;

    const controller = new AbortController();
    let resolveStop!: (result: AlertHandleResult) => void;
    const stopped = new Promise<AlertHandleResult>(resolve => { resolveStop = resolve; });
    const cancel = () => { controller.abort(); halt(owner, 'uncertain'); resolveStop(outcome('halted')); };
    const timer = setTimeout(cancel, Math.max(0, deadlineAt - performance.now()));
    signal?.addEventListener('abort', cancel, { once: true });
    // A blocked event loop must not defer the timer and permit a late publication.
    const live = (): boolean => !closed && !controller.signal.aborted && performance.now() < deadlineAt && available();
    function finish(kind: 'rejected' | 'suppressed' | 'duplicate' | 'conflict' | 'limited' | 'drafted' | 'sent' | 'not_sent' | 'unavailable', messageTs?: string, receiptTs?: string): AlertHandleResult {
      return transaction(() => {
        const row = control();
        if (row.phase !== 'active' || row.owner !== owner || controller.signal.aborted) return outcome('halted');
        if (messageTs && (kind === 'sent' || kind === 'not_sent')) {
          db.query('UPDATE alert_outbox SET status=?,receipt_ts=? WHERE message_ts=? AND status=\'unknown\'').run(kind, receiptTs ?? null, messageTs);
          db.query('UPDATE alert_messages SET state=? WHERE message_ts=? AND state=\'pending\'').run(kind, messageTs);
        }
        if (kind !== 'unavailable') count(kind);
        db.query("UPDATE alert_control SET phase='idle',owner=NULL WHERE id=1").run();
        return outcome(kind);
      });
    }
    async function run(): Promise<AlertHandleResult> {
      if (!live()) return finish('unavailable');
      // The only read is exact public #alerts metadata; no history, tools or model.
      const channel = await transport.channelInfo!(P.channelId, controller.signal);
      if (!live()) return controller.signal.aborted ? outcome('halted') : finish('unavailable');
      const at = now();
      if (!safeClock(at) || at < control().last_clock) { halt(owner, 'clock'); return outcome('halted'); }
      const decision = decideAlertEnvelope(envelope, { nowMs: at, producer, channel });
      if (decision.kind !== 'rejected') count('validated');
      if (decision.kind !== 'accepted') return finish(decision.kind);
      const { evidence, advisory } = decision;
      const reserve = transaction((): 'reserved' | 'duplicate' | 'conflict' | 'limited' | 'alias_limit' => {
        const row = control();
        if (row.phase !== 'active' || row.owner !== owner || !live()) throw new Error('alert_claim_lost');
        db.query('UPDATE alert_control SET last_clock=? WHERE id=1').run(at);
        const event = db.query<{ message_ts: string }, [string]>('SELECT message_ts FROM alert_events WHERE event_id=?').get(evidence.eventId);
        if (event) return event.message_ts === evidence.messageTs ? 'duplicate' : 'conflict';
        if (db.query('SELECT 1 FROM alert_messages WHERE message_ts=?').get(evidence.messageTs)) {
          const aliases = db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM alert_events WHERE message_ts=?').get(evidence.messageTs)!.n;
          if (aliases >= MAX_ALIASES) return 'alias_limit';
          db.query('INSERT INTO alert_events VALUES (?,?)').run(evidence.eventId, evidence.messageTs);
          return 'duplicate';
        }
        if (db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM alert_messages WHERE accepted_at >= ?').get(at - HOUR_MS)!.n >= 5) return 'limited';
        db.query('INSERT INTO alert_messages VALUES (?,?,?,?,?,?)').run(evidence.messageTs, evidence.eventId, at,
          JSON.stringify(evidence), advisory, mode === 'draft' ? 'draft' : 'pending');
        db.query('INSERT INTO alert_events VALUES (?,?)').run(evidence.eventId, evidence.messageTs);
        if (mode === 'publish') db.query("INSERT INTO alert_outbox VALUES (?,'unknown',NULL)").run(evidence.messageTs);
        count('accepted');
        return 'reserved';
      });
      if (reserve === 'alias_limit') { halt(owner, 'alias_limit'); return outcome('halted'); }
      if (reserve !== 'reserved') return finish(reserve);
      if (mode === 'draft') return finish('drafted');
      if (!live()) return controller.signal.aborted ? outcome('halted') : finish('not_sent', evidence.messageTs);
      // Unknown outbox is committed with FULL synchronous before this sole send.
      const result = await transport.sendMessage({ channel: P.channelId, threadTs: evidence.messageTs, text: advisory }, controller.signal);
      if (controller.signal.aborted) return outcome('halted');
      if (result.ok && result.channel === P.channelId && timestamp(result.ts)) return finish('sent', evidence.messageTs, result.ts);
      if (!result.ok && result.outcome === 'definitely_not_sent') return finish('not_sent', evidence.messageTs);
      halt(owner, 'uncertain'); return outcome('halted');
    }
    const entry = { cancel, result: Promise.resolve(outcome('busy')), settled: false };
    active = entry;
    const work = Promise.resolve().then(run).catch(() => { halt(owner, 'uncertain'); return outcome('halted'); }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); entry.settled = true;
      if (active === entry) active = undefined;
    });
    entry.result = Promise.race([work, stopped]);
    if (signal?.aborted) cancel();
    return entry.result;
  }
  return { initialize, handle, ready,
    close() { closed = true; active?.cancel(); return { drained: !active }; },
    async drain() { const current = active; if (current) await current.result; return { drained: !active }; },
  };
}
