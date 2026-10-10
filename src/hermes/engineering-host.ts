/** Durable host ingress. The model cannot call admission, choose authority, or restart work. */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { fingerprintJson } from './audit-trace.ts';
import { EngineeringTaskStore, type EngineeringScope, type EngineeringTaskView, type EngineeringTaskSpec } from './engineering-task-store.ts';

import type { EngineeringIngressRequest, EngineeringReceipt } from '../slack/service.ts';
export type HostEngineeringRequest = EngineeringIngressRequest;
export type HostEngineeringReceipt = EngineeringReceipt;
export interface HostEngineeringPrepared {
  spec: EngineeringTaskSpec;
  /** Host private state consumed by the injected executor; never serialized into Slack. */
  runtime: unknown;
}
export interface HostEngineeringCleanupProof { receiptId: string; taskId: string; sessionId: string; ownerEpoch: string; absent: true }
export interface HostEngineeringOptions {
  db: Database; grantId: string; allocationId: string;
  assertGrant(): void;
  assertBudget(): void;
  prepare(request: Readonly<HostEngineeringRequest>, taskId: string, signal: AbortSignal): Promise<HostEngineeringPrepared>;
  execute(task: EngineeringTaskView, prepared: HostEngineeringPrepared, signal: AbortSignal): Promise<{ completed: boolean; artifactReceiptId: string; summary: string }>;
  cleanup(task: EngineeringTaskView): Promise<HostEngineeringCleanupProof>;
  deliver(receipt: HostEngineeringReceipt): Promise<unknown>;
  now?: () => number;
}
interface RequestRow { request_id: string; request_hash: string; task_id: string; stage: string; admitted_json: string | null; final_json: string | null }
function fail(code: string): never { throw new Error('engineering_host:' + code); }
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);

export function createEngineeringHost(options: HostEngineeringOptions) {
  const { db } = options, store = new EngineeringTaskStore(db, options.now);
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_ingress_requests(
    request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, message_key TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL UNIQUE, allocation_id TEXT NOT NULL UNIQUE, stage TEXT NOT NULL,
    admitted_json TEXT, final_json TEXT);`);
  let serial: Promise<unknown> = Promise.resolve();
  const running = new Set<Promise<void>>(), controller = new AbortController();
  let available = true;
  const pendingStarts = new Map<string, { start(): void; cancel(): void }>();
  const read = (requestId: string) => db.query<RequestRow, [string]>('SELECT * FROM engineering_ingress_requests WHERE request_id=?').get(requestId);
  const receipt = (requestId: string, taskId: string, phase: HostEngineeringReceipt['phase'], status: HostEngineeringReceipt['status'], text: string): HostEngineeringReceipt => {
    if (Buffer.byteLength(text) > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('invalid_receipt');
    const value = Object.freeze({ requestId, taskId, phase, status, text, receiptId: randomUUID() });
    const column = phase === 'admitted' ? 'admitted_json' : 'final_json';
    const row = read(requestId); if (!row || row.task_id !== taskId) fail('request_missing');
    if (phase === 'admitted' ? row.admitted_json : row.final_json) fail('receipt_immutable');
    db.query(`UPDATE engineering_ingress_requests SET ${column}=?,stage=? WHERE request_id=?`).run(JSON.stringify(value), status, requestId);
    return value;
  };
  const scopeFor = (request: HostEngineeringRequest): EngineeringScope => ({ teamId: request.authority.teamId,
    surface: request.authority.surface, audienceId: request.authority.surface === 'private_dm' ? request.authority.requesterId : request.authority.channelId,
    projectId: request.repository.toLowerCase().replace('/', ':') });
  async function run(request: HostEngineeringRequest, prepared: HostEngineeringPrepared, task: EngineeringTaskView, executeAllowed = true): Promise<void> {
    let result: { completed: boolean; artifactReceiptId: string; summary: string } | undefined;
    let cleanup: HostEngineeringCleanupProof | undefined;
    try {
      if (!executeAllowed || !available || controller.signal.aborted) fail('stopped');
      store.assertOwner(task.taskId, task.ownerEpoch!); options.assertGrant(); options.assertBudget();
      const candidate = await options.execute(task, prepared, controller.signal);
      if (!candidate || typeof candidate.completed !== 'boolean' || !id(candidate.artifactReceiptId)
          || typeof candidate.summary !== 'string' || Buffer.byteLength(candidate.summary) > 12_000
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(candidate.summary)) fail('invalid_artifact');
      result = candidate;
    } catch { result = undefined; /* Never manufacture approval, retry, or a paid summary request. */ }
    try { cleanup = await options.cleanup(task); }
    catch {
      store.cleanupUnknown(task.taskId, task.ownerEpoch!, { reason: 'physical_cleanup_unconfirmed' });
    }
    let final: HostEngineeringReceipt;
    if (!cleanup) final = receipt(request.requestId, task.taskId, 'final', 'cleanup_unknown', 'Engineering stopped because sandbox cleanup could not be verified. The task remains locked; no automatic retry was scheduled.');
    else {
      try {
        const state = result?.completed ? 'completed' : 'blocked';
        final = db.transaction(() => {
          store.finish(task.taskId, task.ownerEpoch!, state, () => cleanup!);
          return receipt(request.requestId, task.taskId, 'final', state,
            result?.completed ? result.summary : 'Engineering stopped before verified completion. The isolated work and receipts are preserved; no automatic retry was scheduled.');
        }).immediate();
      } catch {
        store.cleanupUnknown(task.taskId, task.ownerEpoch!, { reason: 'cleanup_receipt_rejected' });
        final = receipt(request.requestId, task.taskId, 'final', 'cleanup_unknown', 'Engineering stopped because its cleanup receipt could not be verified. The task remains locked.');
      }
    }
    // Delivery uncertainty does not reopen execution; the Slack outbox owns retries.
    try { await options.deliver(final); } catch { /* Immutable final remains available to a later scoped read. */ }
  }
  async function admit(requestInput: HostEngineeringRequest, signal: AbortSignal, isAvailable: () => boolean = () => true) {
    const request = structuredClone(requestInput);
    const requestHash = fingerprintJson({ authority: request.authority, messageKey: request.messageKey, repository: request.repository, task: request.task }).sha256;
    const work = serial.then(async (): Promise<HostEngineeringReceipt | { kind: 'rejected'; code: 'unavailable' | 'unauthorized' | 'repository_unavailable' | 'budget_unavailable' | 'busy' | 'invalid_request' }> => {
      if (!available || controller.signal.aborted || signal.aborted || !isAvailable()) return { kind: 'rejected', code: 'unavailable' };
      options.assertGrant();
      if (!id(request.requestId) || !id(request.eventId) || typeof request.messageKey !== 'string'
        || request.authority?.authenticated !== true || request.authority.requesterId !== 'U0A9M5W16F8'
        || request.authority.teamId !== 'T0AA24R7VUZ' || request.authority.surface !== 'private_dm'
        || !/^D[A-Z0-9]{8,20}$/.test(request.authority.channelId) || !/^\d+\.\d+$/.test(request.authority.threadTs)
        || !/^707-Labs\/[A-Za-z0-9._-]+$/.test(request.repository) || typeof request.task !== 'string'
        || !request.task.trim() || Buffer.byteLength(request.task) > 16_384) return { kind: 'rejected', code: 'invalid_request' };
      const old = read(request.requestId);
      if (old) {
        if (old.request_hash !== requestHash) return { kind: 'rejected', code: 'invalid_request' };
        return old.admitted_json ? JSON.parse(old.admitted_json) as HostEngineeringReceipt : { kind: 'rejected', code: 'unavailable' };
      }
      options.assertBudget();
      const taskId = 'engineering-' + randomUUID();
      try { db.query('INSERT INTO engineering_ingress_requests VALUES(?,?,?,?,?,\'preparing\',NULL,NULL)')
        .run(request.requestId, requestHash, request.messageKey, taskId, options.allocationId); }
      catch { return { kind: 'rejected', code: 'busy' }; }
      // Persist intent first. Failure or process death leaves a latched stop, not replay.
      let prepared: HostEngineeringPrepared;
      try {
        prepared = await options.prepare(Object.freeze(request), taskId, AbortSignal.any([signal, controller.signal]));
        const expectedScope = scopeFor(request), spec = prepared.spec;
        if (spec.taskId !== taskId || spec.requestId !== request.requestId || spec.grantId !== options.grantId
            || spec.allocationId !== options.allocationId || spec.repository !== request.repository
            || fingerprintJson(spec.scope).sha256 !== fingerprintJson(expectedScope).sha256) fail('prepared_binding');
        if (signal.aborted || controller.signal.aborted || !isAvailable()) fail('unavailable');
        const { owned, ack } = db.transaction(() => {
          const task = store.admit(spec, () => { options.assertGrant(); options.assertBudget(); });
          const owned = store.claim(task.taskId, () => { options.assertGrant(); options.assertBudget(); });
          const ack = receipt(request.requestId, taskId, 'admitted', 'running', 'Engineering task admitted in an isolated workspace. I will report the patch, checks and independent review when execution finishes.');
          return { owned, ack };
        }).immediate();
        const launch = (executeAllowed: boolean) => {
          const pending = Promise.resolve().then(() => run(request, prepared, owned, executeAllowed));
          running.add(pending); void pending.finally(() => running.delete(pending)).catch(() => { available = false; });
        };
        pendingStarts.set(taskId, { start: () => launch(true), cancel: () => launch(false) });
        return ack;
      } catch {
        db.query('UPDATE engineering_ingress_requests SET stage=\'blocked\' WHERE request_id=?').run(request.requestId);
        return { kind: 'rejected', code: 'unavailable' };
      }
    });
    serial = work.then(() => {}, () => {}); return work;
  }
  return {
    admit,
    start(value: HostEngineeringReceipt): void {
      const row = read(value.requestId);
      if (!row?.admitted_json || fingerprintJson(JSON.parse(row.admitted_json)).sha256 !== fingerprintJson(value).sha256) fail('start_receipt');
      const start = pendingStarts.get(value.taskId);
      if (!start) return; // Persisted old admissions never create a new owner or retry.
      pendingStarts.delete(value.taskId);
      try {
        if (!available || controller.signal.aborted) fail('stopped');
        options.assertGrant(); options.assertBudget();
        const row = db.query<{ owner_epoch: string }, [string]>('SELECT owner_epoch FROM engineering_tasks WHERE task_id=?').get(value.taskId);
        if (!row) fail('task_missing'); store.assertOwner(value.taskId, row.owner_epoch);
        start.start();
      } catch { start.cancel(); }
    },
    verifyReceipt(value: HostEngineeringReceipt): boolean {
      if (!value || !id(value.requestId)) return false;
      const row = read(value.requestId), saved = value.phase === 'admitted' ? row?.admitted_json : value.phase === 'final' ? row?.final_json : null;
      return !!saved && fingerprintJson(JSON.parse(saved)).sha256 === fingerprintJson(value).sha256;
    },
    readReceipt(input: Readonly<{ requestId: string; taskId: string }>): HostEngineeringReceipt | null {
      if (!id(input.requestId) || !id(input.taskId)) return null;
      const row = read(input.requestId);
      if (!row || row.task_id !== input.taskId) return null;
      const saved = row.final_json ?? row.admitted_json;
      return saved ? Object.freeze(JSON.parse(saved)) as HostEngineeringReceipt : null;
    },
    ready() { return available && !controller.signal.aborted; },
    async stop() { available = false; controller.abort(); await serial; const waiting = [...pendingStarts.values()]; pendingStarts.clear(); waiting.forEach(p => p.cancel()); await Promise.allSettled([...running]); },
    store,
  };
}
