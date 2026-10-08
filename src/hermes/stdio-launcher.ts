import { snapshotLongTestPolicy } from '../verification-policy.ts';
import { canonicalizeConversation } from './conversation.ts';
/** A task-scoped pipe transport. The caller owns the reviewed OS/container boundary. */
import { spawn } from 'node:child_process';
import type { GaryRuntimeLauncher, NativeRuntimeOutcome } from './gary-loop-adapter.ts';

export interface StdioLaunchOptions {
  /** Fixed, reviewed argv. No shell is used and no task/model text enters argv. */
  command: readonly string[];
  cwd: string;
  /** Explicit environment only; the operator's environment is never inherited. */
  env: Readonly<Record<string, string>>;
  /** Required: stop/remove the exact isolated worker (e.g. docker rm -f name).
   * Called even after successful exit, and awaited before returning an outcome. */
  cleanup(): Promise<void>;
}
const MAX_LINE = 1_048_576;
const MAX_REQUESTS = 256;
const paths = new Set(['/v1/chat/completions', '/tools/execute', '/tools/state']);
const statuses = new Set(['finished','blocked','no_finish','iteration_cap','timeout','error']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const reject = () => new Error('worker_protocol_or_lifetime_rejected');
const finiteJson = (value: unknown): boolean => typeof value === 'number' ? Number.isFinite(value)
  : Array.isArray(value) ? value.every(finiteJson) : object(value) ? Object.values(value).every(finiteJson) : true;

/** Construction is inert. Only an explicitly invoked launcher starts a child.
 * This function does not itself prove filesystem/egress isolation. */
export function createStdioLauncher(options: StdioLaunchOptions): GaryRuntimeLauncher {
  const command = [...options.command], env = { ...options.env }, cwd = options.cwd;
  if (!command.length || !command[0]?.startsWith('/') || command.some(x => !x || x.includes('\0'))
      || !cwd.startsWith('/') || typeof options.cleanup !== 'function') throw new Error('invalid worker launch specification');
  return async (manifest, handle, signal) => {
    if (signal.aborted || Date.now() >= manifest.deadlineMs) throw reject();
    const longTests=manifest.longTestPolicy===undefined ? undefined : snapshotLongTestPolicy(manifest.longTestPolicy);
    const maxPolls=longTests ? longTests.maxPolls*Object.values(longTests.commands).reduce((sum,rule)=>sum+rule.maxStarts,0) : 0;
    const cancellation = new AbortController();
    const active = AbortSignal.any([signal, cancellation.signal]);
    const timer = setTimeout(() => cancellation.abort(), Math.max(0, Math.min(2147483647, manifest.deadlineMs - Date.now())));
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= Promise.resolve().then(() => options.cleanup());
    let child: ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>['stdin']>; stdout: NonNullable<ReturnType<typeof spawn>['stdout']> };
    try { child = spawn(command[0]!, command.slice(1), { cwd, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch {
      clearTimeout(timer);
      try { await cleanup(); } catch { throw new Error('worker_cleanup_failed'); }
      throw reject();
    }
    let stopped = false, exited = false, code: number | null = null, spawnFailed = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      // A container CLI can exit before its container; cleanup() handles that case.
      if (child.pid) {
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      // Do not wait for inherited pipe handles or a hung provider response before
      // removing the isolated worker. The same promise is awaited in finally.
      void cleanup().catch(() => {});
    };
    const completion = new Promise<void>(resolve => {
      child.once('error', () => { spawnFailed = true; exited = true; resolve(); });
      child.once('close', exitCode => { code = exitCode; exited = true; resolve(); });
    });
    // Never print raw child output or errors: a failed worker can echo capabilities.
    child.stdin.on('error', () => { cancellation.abort(); });
    active.addEventListener('abort', stop, { once: true });
    if (active.aborted) stop();
    const guard = () => { if (active.aborted || Date.now() >= manifest.deadlineMs) throw reject(); };
    const write = async (value: unknown) => {
      guard();
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (bytes.length > MAX_LINE || child.stdin.destroyed) throw reject();
      await new Promise<void>((resolve, rejectWrite) => child.stdin.write(bytes, error => error ? rejectWrite(reject()) : resolve()));
      guard();
    };
    let result: NativeRuntimeOutcome | undefined;
    try {
      await write({ type: 'start', payload: { ...manifest, transport: 'stdio' } });
      let pending = Buffer.alloc(0), nextId = 1, ordinaryRequests=0,pollRequests=0;
      for await (const chunk of child.stdout) {
        guard();
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        // At most one unread frame is allowed to accumulate, including its newline.
        if (pending.length > MAX_LINE) throw reject();
        for (;;) {
          const end = pending.indexOf(10);
          if (end < 0) break;
          const bytes = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          if (!object(frame) || !finiteJson(frame) || result) throw reject();
          if (frame.type === 'result') {
            if (!exact(frame, ['type','result']) || !object(frame.result)) throw reject();
            const value = frame.result;
            if (value.taskId !== manifest.taskId || value.requestId !== manifest.requestId
                || value.publicationApproved !== false || typeof value.status !== 'string' || !statuses.has(value.status)) throw reject();
            // Only the bound, typed outcome reaches the host. Prose is never authority.
            result = { taskId: manifest.taskId, requestId: manifest.requestId,
              status: value.status as NativeRuntimeOutcome['status'], publicationApproved: false };
            if (typeof value.text === 'string') {
              const redacted = value.text.replaceAll(manifest.capability, '[REDACTED]');
              // Phase context is untrusted data, bounded independently of frame size.
              result.text = new TextDecoder().decode(Buffer.from(redacted).subarray(0, 65536), { stream: true });
            }
            if (value.history !== undefined) {
              const history = canonicalizeConversation(value.history, { requireResolved: true });
              if (JSON.stringify(history).includes(manifest.capability)) throw reject();
              result.history = history;
            }
            child.stdin.end();
            continue;
          }
          if (!exact(frame, ['type','id','method','path','headers','body']) || frame.type !== 'request'
              || frame.id !== nextId || frame.method !== 'POST'
              || typeof frame.path !== 'string' || (!paths.has(frame.path) && !(longTests && frame.path==='/tools/jobs/poll')) || !object(frame.body)
              || !object(frame.headers) || !exact(frame.headers, ['authorization','content-type'])
              || frame.headers.authorization !== 'Bearer ' + manifest.capability
              || frame.headers['content-type'] !== 'application/json') throw reject();
          if(frame.path==='/tools/jobs/poll') {if(++pollRequests>maxPolls)throw reject();}
          else if(++ordinaryRequests>MAX_REQUESTS)throw reject();
          nextId++;
          const response = await handle(new Request(new URL(frame.path, manifest.modelBaseUrl), {
            method: 'POST', headers: frame.headers as Record<string, string>, body: JSON.stringify(frame.body), signal: active,
          }));
          guard();
          // Bound responses before returning them to the untrusted worker.
          const reader = response.body?.getReader();
          if (!reader) throw reject();
          const chunks: Uint8Array[] = []; let length = 0;
          const abortRead = () => { void reader.cancel().catch(() => {}); };
          active.addEventListener('abort', abortRead, { once: true });
          try {
            for (;;) {
              guard(); const part = await reader.read(); guard();
              if (part.done) break;
              length += part.value.byteLength;
              if (length > MAX_LINE - 128) { void reader.cancel().catch(() => {}); throw reject(); }
              chunks.push(part.value);
            }
          } finally { active.removeEventListener('abort', abortRead); reader.releaseLock(); }
          const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!object(body) || !finiteJson(body)) throw reject();
          await write({ type: 'response', id: frame.id, status: response.status, body });
        }
      }
      await completion;
      guard();
      if (spawnFailed || code !== 0 || !result || pending.length) throw reject();
      return result;
    } catch { throw reject(); }
    finally {
      clearTimeout(timer);
      active.removeEventListener('abort', stop);
      if (!exited) stop();
      await completion;
      child.stdout.destroy();
      child.stdin.destroy();
      try { await cleanup(); } catch { throw new Error('worker_cleanup_failed'); }
    }
  };
}
