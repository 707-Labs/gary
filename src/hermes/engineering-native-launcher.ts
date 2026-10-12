/** Explicit opt-in native engineering worker; no live service import or default activation. */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { EngineeringProtocol, type EngineeringProtocolBinding } from './engineering-protocol.ts';
import type { EngineeringModelAdapter } from './engineering-model.ts';
import { fingerprintJson } from './audit-trace.ts';
import { engineeringFailure, parseEngineeringWorkerReported, type EngineeringHostObserved, type EngineeringWorkerReported } from './engineering-diagnostics.ts';
import type { ConversationMessage } from './conversation.ts';
import { createEngineeringSessionGuardianFactory, type EngineeringSessionGuardian,
  type EngineeringSessionGuardianFactory } from '../executors/engineering-session-guardian.ts';

export const ENGINEERING_WORKER_IMAGE = 'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab';
const RUNTIME = '/opt/gary-hermes-runtime', OVERLAY = '/opt/gary-engineering';
const FILES = ['gary_engineering_environment.py', 'gary_engineering_runtime.py'];
const TASK_TOOLS_FILE = 'gary_engineering_task_tools.py';
const CORE_TOOLS = new Set(['terminal','read_file','write_file','patch','search_files']);
const CONTEXT_TOOLS = new Set(['process','todo','memory','session_search','skills_list','skill_view','skill_manage','delegate_task','execute_code']);
const MAX_FRAME = 2 * 1024 * 1024;
type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Json, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function fail(reason: string): never { throw new Error('engineering_worker:' + reason); }
const hash = (v: unknown) => fingerprintJson(v).sha256;
async function nativeProcessIdentity(pid: number | undefined): Promise<{ processId: number; processGroupId: number | null; processBirth: string | null }> {
  if (!Number.isSafeInteger(pid) || pid! <= 1) fail('spawn_failed');
  // Windows has no detached POSIX process group. Production here is macOS;
  // never imply that a Windows PID establishes a process-group identity.
  if (process.platform === 'win32') return { processId: pid!, processGroupId: null, processBirth: null };
  const observed = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart=,pgid='], {
      cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000,
      encoding: 'utf8', maxBuffer: 1024, killSignal: 'SIGKILL',
    }, (error, stdout) => error ? reject(new Error('engineering_worker:spawn_failed')) : resolve(stdout.trim()));
  });
  const match = /^([A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(\d+)$/.exec(observed);
  if (!match || Number(match[2]) !== pid) fail('spawn_failed');
  return { processId: pid!, processGroupId: pid!, processBirth: match[1]! };
}
export interface EngineeringNativeInput {
  binding: EngineeringProtocolBinding;
  systemPrompt: string;
  tools: readonly Json[];
  model: EngineeringModelAdapter;
  protocol: EngineeringProtocol;
  transportCapability: string;
  assertOwner(): void;
  fence(reason: string): void;
  /** Durable host evidence; append completes before launching any worker. */
  append(receipt: Readonly<Json>): void;
  /** Host-materialized task paths, never model fields or canonical stores. */
  nativeContext?: EngineeringNativeContext;
  /** Same fixed original task window for parent and all children. */
  standingSession?: { startedAtMs: number; deadlineMs: number };
}
export interface EngineeringNativeContext {
  scopeKey: string;
  /** Host profile may include core tools; only added state capabilities cross this wire. */
  tools: readonly string[];
  delegationDepth: 0 | 1;
  homeDirectory: string;
  approvedSkillsDirectory: string;
  draftSkillsDirectory: string;
  assertCurrent(): void;
}
function contextWire(context: EngineeringNativeContext, confinedCode=false) {
  context.assertCurrent();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(context.scopeKey) || context.scopeKey.trim()!==context.scopeKey
      || ![0,1].includes(context.delegationDepth) || new Set(context.tools).size!==context.tools.length
      || context.tools.some(t=>!CONTEXT_TOOLS.has(t)&&!CORE_TOOLS.has(t)) || context.delegationDepth===1&&context.tools.includes('delegate_task')) fail('native_context');
  if (context.tools.includes('execute_code')&&!confinedCode) fail('code_requires_isolated_native_worker');
  return Object.freeze({version:1,scopeKey:context.scopeKey,tools:context.tools.filter(t=>CONTEXT_TOOLS.has(t)).sort(),delegationDepth:context.delegationDepth,confinedCode});
}
export interface EngineeringNativeTurn {
  turnId: string;
  messages: readonly ConversationMessage[];
  finalResponse: string;
  /** Worker report only. Tests/review/publication remain separate host decisions. */
  nativeCompleted: boolean;
  workerReported?: EngineeringWorkerReported;
}
export interface EngineeringNativeSession {
  turn(input: { turnId: string; prompt: string }): Promise<EngineeringNativeTurn>;
  close(): Promise<{ cleanupConfirmed: true }>;
}
export type EngineeringNativeLauncher = (input: EngineeringNativeInput, signal: AbortSignal) => Promise<EngineeringNativeSession>;
export interface EngineeringStdioOptions {
  command: readonly string[]; cwd: string; env: Readonly<Record<string, string>>;
  /** Trusted offline fixture paths only. The Docker composition never supplies this seam. */
  fixturePaths?: { nativeSource: string; scopedHome: string };
  /** Set only by the reviewed Docker composition after container binding. */
  isolatedNativeWorker?: true;
  /** Must prove exact worker absence, even if its attached CLI already exited. */
  cleanup(): Promise<void>;
}

/** Trusted process fixture seam. This function itself does not establish isolation. */
export function createEngineeringStdioLauncher(config: EngineeringStdioOptions): EngineeringNativeLauncher {
  const command = [...config.command], env = { ...config.env }, cwd = config.cwd;
  const paths = { nativeSource: RUNTIME + '/vendor/hermes', scopedHome: '/tmp/gary-engineering-scope', ...config.fixturePaths };
  if (!command[0]?.startsWith('/') || command.some(s => !s || s.includes('\0')) || !isAbsolute(cwd)) fail('configuration');
  if (!isAbsolute(paths.nativeSource) || !isAbsolute(paths.scopedHome)) fail('configuration');
  return async (input, signal) => {
    const binding = Object.freeze({ ...input.binding }), systemPrompt = input.systemPrompt;
    const nativeContext = input.nativeContext ? contextWire(input.nativeContext,config.isolatedNativeWorker===true) : undefined;
    const expectedTools = structuredClone(input.tools);
    // One trusted model policy supplies both paid-route admission and native
    // iteration/output limits. The worker never chooses a second allowance.
    const limits = Object.freeze({ ...input.model.nativeLimits });
    if (!exact(limits, ['policyVersion','model','maxIterations','maxTokens'])
        || ![1, 2].includes(limits.policyVersion) || limits.model !== 'deepseek-v4-pro'
        || !Number.isSafeInteger(limits.maxIterations) || limits.maxIterations < 1 || limits.maxIterations > 50
        || !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 1 || limits.maxTokens > 8192
        || (limits.policyVersion === 1 && (limits.maxIterations !== 3 || limits.maxTokens !== 8192))) fail('model_limits');
    if (hash(binding) !== hash(input.protocol.binding) || input.transportCapability.length < 32) fail('binding');
    input.assertOwner(); signal.throwIfAborted();
    if (Date.now() >= binding.deadlineMs) fail('expired');
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= Promise.resolve().then(config.cleanup);
    const cancellation = new AbortController(), active = AbortSignal.any([signal, cancellation.signal]);
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command[0]!, command.slice(1), { cwd, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { await cleanup(); fail('spawn_failed'); }
    const stdin = child.stdin!, stdout = child.stdout!;
    let ended = false, exitCode: number | null = null, busy = false, closing = false, stopped = false, operationPending = false;
    let cleanupConfirmed = false;
    const hostObserved: EngineeringHostObserved = { modelRequestsReceived: 0, toolBegins: 0, toolEnds: 0, toolFailures: 0, environmentOperations: 0 };
    const failure = (phase: 'native_start' | 'native_turn' | 'native_close', error: unknown) => input.append(Object.freeze({
      kind: 'native_diagnostic', ...binding, diagnostic: { ...engineeringFailure(phase, error), hostObserved: { ...hostObserved } } }));
    const completion = new Promise<void>(resolve => {
      child.once('error', () => { cancellation.abort(); ended = true; resolve(); });
      child.once('exit', () => { if (operationPending) cancellation.abort(); });
      child.once('close', code => { exitCode = code; ended = true; resolve(); });
    });
    const stop = () => {
      if (stopped) return; stopped = true;
      if (child.pid && !ended) {
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* Exact container cleanup remains authoritative. */ } }
      }
      stdin.destroy(); stdout.destroy(); void cleanup().catch(() => {});
    };
    active.addEventListener('abort', stop, { once: true });
    stdin.on('error', () => cancellation.abort());
    const timer = setTimeout(() => cancellation.abort(), Math.max(1, Math.min(2_147_483_647, binding.deadlineMs - Date.now())));
    if (active.aborted) stop();
    const guard = () => { active.throwIfAborted(); if (!closing) input.assertOwner(); if (Date.now() >= binding.deadlineMs) fail('expired'); };
    async function write(value: unknown) {
      guard(); const raw = Buffer.from(JSON.stringify(value) + '\n');
      if (raw.length > MAX_FRAME || stdin.destroyed) fail('write_failed');
      await new Promise<void>((resolve, reject) => stdin.write(raw, e => e ? reject(new Error('engineering_worker:write_failed')) : resolve()));
      guard();
    }
    async function* frames(): AsyncGenerator<Json> {
      let pending = Buffer.alloc(0);
      for await (const bytes of stdout) {
        guard(); pending = Buffer.concat([pending, Buffer.from(bytes)]);
        if (pending.length > MAX_FRAME) fail('frame_limit');
        for (;;) {
          const at = pending.indexOf(10); if (at < 0) break;
          const raw = pending.subarray(0, at); pending = pending.subarray(at + 1);
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
          if (!object(value) || fingerprintJson(value).bytes > MAX_FRAME) fail('frame_shape');
          yield value;
        }
      }
      if (pending.length) fail('partial_frame');
    }
    const reader = frames(); let nextRequest = 1;
    async function until(type: string): Promise<Json> {
      for (;;) {
        guard(); const item = await reader.next(); guard();
        if (item.done) fail('unexpected_exit');
        const frame = item.value;
        if (frame.type === type) return frame;
        if (!exact(frame, ['type','id','kind','body']) || frame.type !== 'engineering.request'
            || frame.id !== nextRequest || nextRequest > 2048 || !['rpc','model'].includes(String(frame.kind))
            || !object(frame.body)) fail('request_shape');
        nextRequest++; operationPending = true;
        let response: Json;
        try {
          if (frame.kind === 'model') {
            if (closing) fail('model_during_close');
            hostObserved.modelRequestsReceived++;
            response = await input.model.handle(frame.body, active);
          } else {
            response = await input.protocol.accept(frame.body, input.transportCapability);
            if (response.ok !== true) {
              // Protocol responses contain fixed host codes, but still pass the
              // exact allowlist before propagating anything from this boundary.
              const rejected = engineeringFailure('native_turn', new Error(typeof response.error === 'string' ? response.error : ''));
              if (rejected.code !== 'unknown_failure') throw new Error(rejected.code);
              fail('rpc_rejected');
            }
            if (frame.body.kind === 'tool.begin') hostObserved.toolBegins++;
            if (frame.body.kind === 'environment.operation') hostObserved.environmentOperations++;
            if (frame.body.kind === 'tool.end') {
              const p = frame.body.payload;
              if (!object(p) || typeof p.toolCallId !== 'string' || typeof p.resultHash !== 'string') fail('tool_result');
              if (input.protocol.resultPresentation === 'raw' && response.nested !== true) input.model.observeToolResult(p.toolCallId, p.resultHash);
              hostObserved.toolEnds++; if (p.status === 'failed') hostObserved.toolFailures++;
            }
            if (frame.body.kind === 'tool.presentation') {
              const p = frame.body.payload;
              if (input.protocol.resultPresentation !== 'native_batch' || !object(p)
                  || typeof p.toolCallId !== 'string' || typeof p.resultHash !== 'string') fail('tool_result');
              input.model.observeToolResult(p.toolCallId, p.resultHash);
            }
          }
          guard(); await write({ type: 'engineering.response', id: frame.id, body: response });
        } finally { operationPending = false; }
      }
    }
    const dispose = async (reason?: string) => {
      clearTimeout(timer); active.removeEventListener('abort', stop);
      if (!ended) stop();
      await completion; stdin.destroy(); stdout.destroy();
      try { await cleanup(); }
      catch { input.fence('native_cleanup_unknown'); fail('cleanup_unknown'); }
      if (!cleanupConfirmed) {
        input.append(Object.freeze({ kind: 'native_cleanup_confirmed', ...binding }));
        cleanupConfirmed = true;
      }
      if (reason) input.fence(reason);
    };
    try {
      const ownedProcess = await nativeProcessIdentity(child.pid);
      if (ended) fail('spawn_failed');
      input.append(Object.freeze({ kind: 'native_stdio_start', ...binding, modelLimits: limits, ...ownedProcess }));
      await write({ type: 'engineering.start', binding, systemPrompt,
        ...paths, ...(nativeContext ? {scopedHome: config.fixturePaths?.scopedHome ?? '/task/native-home', nativeContext} : {}),
        model: limits.model, maxIterations: limits.maxIterations, maxTokens: limits.maxTokens,
        resultPresentation: input.protocol.resultPresentation });
      const ready = await until('engineering.ready');
      if (!exact(ready, ['type','sessionId','tools','toolSchemas']) || ready.sessionId !== binding.sessionId
          || hash(ready.toolSchemas) !== hash(expectedTools)
          || hash(ready.tools) !== hash(expectedTools.map(t => (t.function as Json).name).sort())) fail('native_schema_changed');
      input.append(Object.freeze({ kind: 'native_ready', ...binding, schemasHash: hash(expectedTools) }));
    } catch (error) { try { failure('native_start', error); } finally { await dispose('native_start_failed'); } fail('startup_failed'); }
    let closed = false;
    return {
      async turn(turn) {
        if (closed || closing || busy) fail('turn_not_available');
        busy = true;
        try {
          guard(); const history = input.model.history(); input.model.beginTurn(turn);
          await write({ type: 'engineering.turn', turnId: turn.turnId, prompt: turn.prompt, history });
          const frame = await until('engineering.result');
          if (!exact(frame, ['type','turnId','result']) || frame.turnId !== turn.turnId || !object(frame.result)
              || !Array.isArray(frame.result.messages)) fail('result_binding');
          const workerReported = frame.result.diagnostics === undefined ? undefined : parseEngineeringWorkerReported(frame.result.diagnostics);
          const messages = input.model.finishTurn(frame.result.messages);
          const last = messages.at(-1);
          input.append(Object.freeze({ kind: 'native_turn_result', ...binding, turnId: turn.turnId, historyHash: hash(messages),
            diagnostic: { version: 1, event: 'native_result', phase: 'native_turn', code: 'none', hostObserved: { ...hostObserved },
              ...(workerReported ? { workerReported } : {}) } }));
          return { turnId: turn.turnId, messages, finalResponse: last?.role === 'assistant' ? String(last.content ?? '') : '',
            nativeCompleted: frame.result.completed === true, ...(workerReported ? { workerReported } : {}) };
        } catch (error) { closed = true; try { failure('native_turn', error); } finally { await dispose('native_turn_failed'); } fail('turn_failed'); }
        finally { busy = false; }
      },
      async close() {
        if (cleanupConfirmed) return { cleanupConfirmed: true };
        if (busy || closed || closing) fail('close_not_available');
        closing = true;
        try {
          await write({ type: 'engineering.close' });
          const frame = await until('engineering.closed');
          if (!exact(frame, ['type','cleanupConfirmed']) || frame.cleanupConfirmed !== true) fail('close_receipt');
          stdin.end();
          const extra = await reader.next();
          if (!extra.done) fail('trailing_frame');
          await completion;
          if (exitCode !== 0) fail('exit_failed');
          await dispose(); closed = true;
          return { cleanupConfirmed: true };
        } catch (error) {
          // Execution authority can expire before cooperative close. Physical
          // cleanup remains mandatory and its verified absence is sufficient.
          closed = true; try { failure('native_close', error); } finally { await dispose('native_close_failed'); }
          return { cleanupConfirmed: true };
        }
      },
    };
  };
}

export interface EngineeringRuntimeFile { path: string; sha256: string }
export interface EngineeringDockerOptions {
  /** Exact reviewed source bytes, overlaid individually on the immutable image. */
  runtimeFiles: readonly EngineeringRuntimeFile[];
  /** Existing host-private directory for read-only per-worker source snapshots. */
  snapshotDirectory: string;
  /** Private durable guardian journals survive host/worker loss. Must be outside snapshots. */
  guardianDirectory: string;
  /** Host-only reservation profile, independently bounded by the worker ceiling. */
  resources: { cpus: number; memoryMiB: number };
  dockerExecutable: '/usr/local/bin/docker';
  dockerHost: 'unix:///Users/tanner/.colima/default/docker.sock';
}
export type EngineeringDockerRunner = (command: readonly string[], env: Readonly<Record<string, string>>,
  timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string }>;
const runDocker: EngineeringDockerRunner = (command, env, timeout, signal) => new Promise((resolve, reject) => {
  execFile(command[0]!, command.slice(1), { cwd: '/', env: { ...env }, timeout, encoding: 'utf8', maxBuffer: 1_048_576,
    killSignal: 'SIGKILL', ...(signal ? { signal } : {}) }, (e, stdout) => {
    if (e && (typeof e.code !== 'number' || e.killed)) reject(new Error('engineering_worker:docker_failed'));
    else resolve({ exitCode: e?.code as number ?? 0, stdout });
  });
});
function source(file: EngineeringRuntimeFile): Buffer {
  if (!isAbsolute(file.path) || realpathSync(file.path) !== file.path || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('source_path');
  const before = lstatSync(file.path), fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.mode & 0o022 || s.size > 262_144
        || s.dev !== before.dev || s.ino !== before.ino) fail('source_identity');
    const raw = readFileSync(fd), after = fstatSync(fd);
    if (after.mtimeMs !== s.mtimeMs || after.size !== s.size || createHash('sha256').update(raw).digest('hex') !== file.sha256) fail('source_changed');
    return raw;
  } finally { closeSync(fd); }
}

/** Construction is inert. Production execution uses immutable image, clean environment,
 * no network/socket/canonical-store mounts. Reviewed Python overlays are read-only;
 * standing tasks receive only their exact private materialized native paths. */
export function createEngineeringNativeLauncher(options: EngineeringDockerOptions, dependencies: {
  run?: EngineeringDockerRunner; stdio?: typeof createEngineeringStdioLauncher;
  guardian?: EngineeringSessionGuardianFactory;
} = {}): EngineeringNativeLauncher {
  const pinned = structuredClone(options);
  if (pinned.dockerExecutable !== '/usr/local/bin/docker' || pinned.dockerHost !== 'unix:///Users/tanner/.colima/default/docker.sock'
      || ![hash(FILES),hash([...FILES,TASK_TOOLS_FILE].sort())].includes(hash(pinned.runtimeFiles.map(f => basename(f.path)).sort())) || !isAbsolute(pinned.snapshotDirectory)
      || !isAbsolute(pinned.guardianDirectory) || /[,\x00-\x1f]/.test(pinned.snapshotDirectory)
      || !pinned.resources || !Number.isFinite(pinned.resources.cpus) || pinned.resources.cpus < 0.25 || pinned.resources.cpus > 2
      || !Number.isSafeInteger(pinned.resources.memoryMiB) || pinned.resources.memoryMiB < 256 || pinned.resources.memoryMiB > 4096) fail('docker_configuration');
  const run = dependencies.run ?? runDocker, stdio = dependencies.stdio ?? createEngineeringStdioLauncher;
  const guardians = dependencies.guardian ?? createEngineeringSessionGuardianFactory({ directory: pinned.guardianDirectory });
  return async (input, signal) => {
    const nativeContext=input.nativeContext ? Object.freeze({...input.nativeContext,tools:Object.freeze([...input.nativeContext.tools])}) : undefined;
    const standingSession=input.standingSession?Object.freeze({...input.standingSession}):undefined;
    let containerUser='65532:65532';
    let files: {name: string; raw: Buffer; sha256: string}[], snapshot: string;
    try {
      input.assertOwner(); signal.throwIfAborted();
      if (standingSession && (!nativeContext || !Number.isSafeInteger(standingSession.startedAtMs)
          || standingSession.startedAtMs<=0 || standingSession.deadlineMs!==input.binding.deadlineMs
          || (standingSession.deadlineMs-standingSession.startedAtMs<60_000||standingSession.deadlineMs-standingSession.startedAtMs>150*60_000))) fail('standing_session_window');
      const parent = lstatSync(pinned.snapshotDirectory);
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o077
          || realpathSync(pinned.snapshotDirectory) !== pinned.snapshotDirectory) fail('snapshot_directory');
      files = pinned.runtimeFiles.map(f => ({ name: basename(f.path), raw: source(f), sha256: f.sha256 }));
      if (nativeContext) {
        contextWire(nativeContext,true);
        const uid=process.getuid?.(),gid=process.getgid?.();
        if (!Number.isSafeInteger(uid)||!Number.isSafeInteger(gid)||uid!<=0||gid!<0) fail('native_context_user');
        containerUser=`${uid}:${gid}`;
        if (nativeContext.tools.some(t=>['delegate_task','execute_code'].includes(t))&&!files.some(f=>f.name===TASK_TOOLS_FILE)) fail('native_task_tools_source_missing');
        const dirs=[nativeContext.homeDirectory,nativeContext.approvedSkillsDirectory,nativeContext.draftSkillsDirectory];
        for (const path of dirs) {
          const stat=lstatSync(path);
          if (!isAbsolute(path)||/[,\x00-\x1f]/.test(path)||realpathSync(path)!==path||!stat.isDirectory()
              ||stat.uid!==process.getuid?.()||stat.mode&0o077) fail('native_context_directory');
        }
        for (let i=0;i<dirs.length;i++) for(let j=i+1;j<dirs.length;j++) {
          const a=relative(dirs[i]!,dirs[j]!),b=relative(dirs[j]!,dirs[i]!);
          if (!a||!a.startsWith('../')||!b.startsWith('../')) fail('native_context_overlap');
        }
      }
      snapshot = mkdtempSync(join(pinned.snapshotDirectory, 'native-'));
    } catch (error) {
      input.append(Object.freeze({ kind: 'native_cleanup_confirmed', ...input.binding, noContainerAttempted: true }));
      throw error;
    }
    const name = 'gary-longjob-' + randomUUID(), admissionId = randomUUID();
    const env = Object.freeze({ PATH: '/usr/bin:/bin', DOCKER_HOST: pinned.dockerHost,
      DOCKER_CONFIG: join(snapshot, 'docker-config'), HOME: snapshot });
    let creationAttempted = false, containerId: string | null = null, guardian: EngineeringSessionGuardian | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const verifyDaemon = async () => {
      if (!guardian) fail('guardian_missing');
      const found = await run([pinned.dockerExecutable, 'info', '--format', '{{.ID}}'], env, 10_000);
      if (found.exitCode !== 0 || found.stdout.trim() !== guardian.daemonId) fail('daemon_changed');
    };
    const ids = async (filter: string) => {
      const found = await run([pinned.dockerExecutable, 'container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', filter], env, 10_000);
      const values = found.stdout.trim() ? found.stdout.trim().split(/\s+/) : [];
      if (found.exitCode !== 0 || values.length > 1 || values.some(id => !/^[a-f0-9]{64}$/.test(id))) fail('container_identity_unknown');
      return values;
    };
    const verifyContainer = async (id: string) => {
      const found = await run([pinned.dockerExecutable, 'container', 'inspect', '--format', '{{json .}}', id], env, 10_000);
      const item: unknown = JSON.parse(found.stdout);
      if (found.exitCode !== 0 || !object(item) || item.Id !== id || !object(item.Config) || !object(item.Config.Labels)) fail('container_identity_unknown');
      const labels = item.Config.Labels;
      if (labels['gary.task'] !== input.binding.taskId || labels['gary.session'] !== input.binding.sessionId
          || labels['gary.owner'] !== input.binding.ownerEpoch || labels['gary.admission'] !== admissionId
          || labels['dev.gary.executor-job'] !== guardian?.reference.invocationId
          || labels['dev.gary.executor-journal'] !== guardian?.reference.journalId) fail('container_owner_changed');
    };
    const cleanup = () => cleanupPromise ??= (async () => {
      // Drain the independent remover before fallback; never race a live guardian.
      if (guardian) {
        try {
          const proof = await guardian.complete();
          if (proof.absenceVerified !== true || containerId !== null && proof.containerId !== containerId) fail('guardian_receipt_mismatch');
          containerId = proof.containerId;
        } catch { /* Exact-ID host fallback below preserves unrelated containers. */ }
      }
      if (creationAttempted) {
        await verifyDaemon();
        if (containerId === null) fail('unbound_creation');
        const existing = await ids(`id=${containerId}`);
        if (existing.some(id => id !== containerId)) fail('container_identity_unknown');
        if (existing.length) {
          await verifyContainer(containerId);
          const removed = await run([pinned.dockerExecutable, 'container', 'rm', '--force', containerId], env, 10_000);
          if (removed.exitCode !== 0) fail('container_removal_failed');
        }
        if ((await ids(`id=${containerId}`)).length) fail('container_absence_unknown');
        // A foreign replacement at the old name is never removed or adopted.
        const named = await ids(`name=^/${name}$`);
        if (named.includes(containerId)) fail('container_absence_unknown');
        input.append(Object.freeze({ kind: 'native_container_cleanup_confirmed', ...input.binding,
          containerName: name, containerId, daemonId: guardian!.daemonId, foreignNamePresent: named.length > 0 }));
      }
      rmSync(snapshot, { recursive: true });
      input.append(Object.freeze({ kind: 'native_cleanup_confirmed', ...input.binding,
        ...(creationAttempted ? { containerId, daemonId: guardian!.daemonId } : { noContainerAttempted: true }) }));
    })();
    try {
      mkdirSync(env.DOCKER_CONFIG, { mode: 0o700 });
      for (const file of files) writeFileSync(join(snapshot, file.name), file.raw, { flag: 'wx', mode: 0o444 });
      const inspected = await run([pinned.dockerExecutable, 'image', 'inspect', ENGINEERING_WORKER_IMAGE], env, 10_000, signal);
      const images: unknown = JSON.parse(inspected.stdout);
      if (inspected.exitCode !== 0 || !Array.isArray(images) || images.length !== 1 || !object(images[0])) fail('image_unverified');
      const image = images[0], config = image.Config;
      if (image.Id !== ENGINEERING_WORKER_IMAGE || image.Os !== 'linux' || image.Architecture !== 'arm64' || !object(config)
          || config.User !== '65532:65532' || config.WorkingDir !== RUNTIME
          || (config.Volumes !== null && config.Volumes !== undefined && (!object(config.Volumes) || Object.keys(config.Volumes).length))
          || config.Healthcheck !== undefined && config.Healthcheck !== null) fail('image_unverified');
      input.assertOwner(); signal.throwIfAborted();
      nativeContext?.assertCurrent();
      guardian = await guardians.arm({ binding: { ...input.binding, admissionId }, containerName: name,
        ...(standingSession?{standingSession}:{}),
        deadlineMs: input.binding.deadlineMs, workspaceRoot: snapshot, image: ENGINEERING_WORKER_IMAGE,
        dockerBinary: pinned.dockerExecutable, dockerHost: pinned.dockerHost, runner: {
          run: async invocation => { const r = await run(invocation.argv, invocation.env, invocation.timeoutMs);
            return { output: r.stdout, exitCode: r.exitCode, timedOut: false, outputTruncated: Buffer.byteLength(r.stdout) > invocation.maxOutputBytes }; },
          start: async () => fail('guardian_command_start_forbidden'),
        } });
      input.append(Object.freeze({ kind: 'native_guardian_armed', ...input.binding, containerName: name,
        admissionId, daemonId: guardian.daemonId, dockerHost: pinned.dockerHost, guardian: guardian.reference }));
      const command = [pinned.dockerExecutable, 'container', 'create', '--rm', '--interactive', '--init', '--name', name,
        '--pull', 'never', '--restart', 'no', '--network', 'none', '--read-only', '--user', containerUser,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '128', '--memory', `${pinned.resources.memoryMiB}m`,
        '--memory-swap', `${pinned.resources.memoryMiB}m`, '--cpus', String(pinned.resources.cpus), '--ulimit', 'nofile=256:256', '--stop-timeout', '5', '--no-healthcheck',
        '--log-driver', 'none', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',
        '--label', `gary.task=${input.binding.taskId}`, '--label', `gary.session=${input.binding.sessionId}`,
        '--label', `gary.owner=${input.binding.ownerEpoch}`, '--label', `gary.admission=${admissionId}`,
        '--label', `dev.gary.executor-job=${guardian.reference.invocationId}`,
        '--label', `dev.gary.executor-journal=${guardian.reference.journalId}`,
        ...files.flatMap(f => ['--mount', `type=bind,source=${join(snapshot, f.name)},target=${OVERLAY}/${f.name},readonly`]),
        ...(nativeContext ? [
          '--mount',`type=bind,source=${nativeContext.homeDirectory},target=/task/native-home`,
          '--mount',`type=bind,source=${nativeContext.approvedSkillsDirectory},target=/task/skills-approved,readonly`,
          '--mount',`type=bind,source=${nativeContext.draftSkillsDirectory},target=/task/skill-drafts`,
        ] : []),
        '--workdir', RUNTIME, '--entrypoint', '/usr/bin/env', ENGINEERING_WORKER_IMAGE, '-i',
        'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'PYTHONNOUSERSITE=1', 'PYTHONDONTWRITEBYTECODE=1',
        'python', '-I', '-B', '-c', `import sys,runpy;sys.path[:0]=['${OVERLAY}','${RUNTIME}/python'];runpy.run_path('${OVERLAY}/gary_engineering_runtime.py',run_name='__main__')`];
      input.append(Object.freeze({ kind: 'native_container_intent', ...input.binding, containerName: name,
        imageDigest: ENGINEERING_WORKER_IMAGE, resources: pinned.resources, containerUser,
        ...(nativeContext?{scopeKey:nativeContext.scopeKey,nativeTools:[...nativeContext.tools],delegationDepth:nativeContext.delegationDepth}:{}),
        sourceFiles: files.map(f => ({ name: f.name, sha256: f.sha256 })) }));
      await verifyDaemon(); input.assertOwner(); signal.throwIfAborted(); guardian.signal.throwIfAborted();
      creationAttempted = true;
      const created = await run(command, env, 10_000, signal), id = created.stdout.trim();
      if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(id)) fail('container_creation_unknown');
      containerId = id;
      input.append(Object.freeze({ kind: 'native_container_created', ...input.binding, containerName: name,
        containerId, daemonId: guardian.daemonId, admissionId }));
      await verifyContainer(id); await guardian.bind(id);
      input.assertOwner(); signal.throwIfAborted(); guardian.signal.throwIfAborted();
      return await stdio({ command: [pinned.dockerExecutable, 'container', 'start', '--attach', '--interactive', id],
        cwd: '/', env, cleanup, isolatedNativeWorker:true })({...input,...(nativeContext?{nativeContext}:{})}, AbortSignal.any([signal, guardian.signal]));
    } catch (error) {
      try { input.append(Object.freeze({ kind: 'native_diagnostic', ...input.binding, diagnostic: engineeringFailure('native_start', error) })); }
      finally { try { await cleanup(); } catch { input.fence('native_cleanup_unknown'); fail('cleanup_unknown'); } }
      fail('launch_failed');
    }
  };
}
