/** No listener, polling, provider client, or publication side effect starts on import. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createExecutorBridge, type ExecutorBridgeOptions } from './executor-bridge.ts';
import { EXECUTOR_TOOL_NAMES } from './executor-bridge.ts';
import { INTEGRATION_TOOL_NAMES, type ScopedIntegrationBindings } from './scoped-integrations.ts';
import { createModelTransport, type ModelTransportOptions, type ModelTransportFailure } from './model-transport.ts';
import type { SpendLedger } from '../spend.ts';
import type { AgentLoopResult } from '../agent/loop.ts';
import type { ProductiveProgressGuard } from './progress-guard.ts';
import { auditErrorCode, fingerprintBytes, fingerprintJson, type AuditTrace, type AuditPhase, type AuditToolName } from './audit-trace.ts';

export interface AdmittedSession {
  taskId: string; requestId: string; ticketId: string; actionId: string;
  fingerprint: string; ownerEpoch: string; deadlineMs: number;
}
export interface SessionOptions {
  admission: AdmittedSession;
  capabilityToken: string;
  ledger: SpendLedger;
  provider: 'z.ai' | 'deepseek';
  model: 'glm-5.3' | 'deepseek-v4-pro';
  providerApiKey: string;
  /** Trusted DeepSeek host policy; never read from native request JSON. */
  thinking?: 'disabled';
  /** Mandatory injection. Offline tests use a fake; only a reviewed host may supply real fetch. */
  fetch: ModelTransportOptions['fetch'];
  executor: ExecutorBridgeOptions['executor'];
  allowedTools: readonly string[];
  finishGateCommand: string;
  integrations?: ScopedIntegrationBindings;
  readOnly?: boolean;
  assertFinishEvidence?: (signal: AbortSignal) => Promise<void>;
  currentOwnerEpoch(): string;
  /** Must consult canonical admitted action/fingerprint ownership. No queue is created here. */
  assertAdmission(admission: Readonly<AdmittedSession>): void;
  /** Explicit host policy/evidence only; no inferred progress from model text. */
  progress?: ProductiveProgressGuard;
  /** Operator-created private per-run trace; no default path or hidden writes. */
  trace?: AuditTrace;
  tracePhase?: () => AuditPhase;
  signal?: AbortSignal;
}
export interface RuntimeManifest {
  taskId: string; requestId: string; ownerEpoch: string; capability: string;
  modelBaseUrl: string; executorUrl: string; stateUrl: string; model: string;
  prompt: string; systemPrompt: string; tools: ReturnType<typeof createExecutorBridge>['definitions'];
  maxIterations: number; maxTokens: number; temperature: number; deadlineMs: number;
  history?: readonly Record<string, unknown>[];
}
export type TerminationReason = 'budget_exhausted' | 'progress_stopped' | 'trace_failed' | 'timeout' | 'cancelled' | 'native_error' | 'session_inactive' | null;
const digest = (s: string) => createHash('sha256').update(s).digest();
const clipped = (text: string | null) => text === null ? null : new TextDecoder().decode(Buffer.from(text).subarray(0,4096), { stream: true });
const fail = (status: number, code: string) => Response.json({ error: { code } }, { status });
export function createSessionHost(options: SessionOptions) {
  const admission = Object.freeze({ ...options.admission });
  const token = options.capabilityToken;
  if (options.trace && (['taskId','requestId','actionId','ownerEpoch'].some(key => options.trace!.binding[key as keyof typeof options.trace.binding] !== admission[key as keyof AdmittedSession])
      || (options.trace.binding.ticketId !== undefined && options.trace.binding.ticketId !== admission.ticketId))) throw new Error('trace admission mismatch');
  if (token.length < 32 || !admission.actionId || !admission.fingerprint || !admission.requestId
      || !Number.isFinite(admission.deadlineMs)) throw new Error('invalid admitted session');
  if (options.model !== (options.provider === 'z.ai' ? 'glm-5.3' : 'deepseek-v4-pro')) throw new Error('unpriced provider/model pair');
  const thinking=options.thinking;
  if (thinking !== undefined && (thinking !== 'disabled' || options.provider !== 'deepseek')) throw new Error('invalid host thinking policy');
  const cancellation = new AbortController();
  const cancelFromParent = () => cancellation.abort(options.signal?.reason);
  if (options.signal?.aborted) cancelFromParent();
  else options.signal?.addEventListener('abort', cancelFromParent, { once: true });
  let disposed = false;
  let traceFinalized = false, traceSequence = 0, modelRequests = 0;
  const modelState = {provider:options.provider,model:options.model,thinking:thinking ?? 'unknown' as const,effort:'unknown' as const};
  const traceContext = () => ({iteration:modelRequests,phase:options.tracePhase?.() ?? 'hermes' as AuditPhase,modelState});
  const currentTool = new AsyncLocalStorage<{operationId:string;toolName:AuditToolName}>();
  const currentModel = new AsyncLocalStorage<{failure?:ModelTransportFailure}>();
  let bridgeInvalidated = () => false;
  const live = () => {
    if (disposed || traceFinalized || options.trace?.failed || bridgeInvalidated() || cancellation.signal.aborted || options.progress?.state.stopReason || Date.now() >= admission.deadlineMs) throw new Error('session inactive');
    if (options.currentOwnerEpoch() !== admission.ownerEpoch) throw new Error('owner changed');
    options.assertAdmission(admission);
    if (options.ledger.status(admission.ticketId)?.state !== 'active') throw new Error('allocation inactive');
  };
  try {live();} catch(error) {options.signal?.removeEventListener('abort',cancelFromParent);cancellation.abort();throw error;}
  const executor: ExecutorBridgeOptions['executor'] = !options.trace ? options.executor : {
    workspaceRoot:options.executor.workspaceRoot,
    readFile:(...args)=>options.executor.readFile(...args),writeFile:(...args)=>options.executor.writeFile(...args),
    listFiles:(...args)=>options.executor.listFiles(...args),grep:(...args)=>options.executor.grep(...args),
    run:async(command,opts)=>{
      const parent=currentTool.getStore();
      if(!parent) throw new Error('executor trace context missing');
      const operationId='executor-'+(++traceSequence);
      options.trace!.append({kind:'tool',stage:'start',operationId,parentOperationId:parent.operationId,toolName:parent.toolName,
        command:fingerprintBytes(command),...traceContext()});
      try {
        const result=await options.executor.run(command,opts);
        options.trace!.append({kind:'tool',stage:'result',operationId,exitCode:result.exitCode,timedOut:result.timedOut,
          stdout:fingerprintBytes(result.stdout),stderr:fingerprintBytes(result.stderr)});
        return result;
      } catch {
        if(!options.trace!.failed) options.trace!.append({kind:'tool',stage:cancellation.signal.aborted?'cancel':'error',operationId,errorCode:cancellation.signal.aborted?'cancelled':'tool_failed'});
        throw new Error('executor_operation_failed');
      }
    },
  };
  let bridge: ReturnType<typeof createExecutorBridge>;
  try {bridge = createExecutorBridge({
    executor,
    capability: { taskId: admission.taskId, token, ownerEpoch: admission.ownerEpoch, deadlineMs: admission.deadlineMs },
    currentOwnerEpoch: options.currentOwnerEpoch,
    isCapabilityActive: () => { try { live(); return true; } catch { return false; } },
    allowedTools: options.allowedTools,
    finishGateCommand: options.finishGateCommand,
    ...(options.integrations ? { integrations: options.integrations } : {}),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.assertFinishEvidence ? { assertFinishEvidence: options.assertFinishEvidence } : {}),
    signal: cancellation.signal,
  });} catch(error) {options.signal?.removeEventListener('abort',cancelFromParent);cancellation.abort();throw error;}
  bridgeInvalidated = () => bridge.state.invalidated;
  let model:ReturnType<typeof createModelTransport>;
  try {model = createModelTransport({
    ledger: options.ledger,
    capability: { ticketId: admission.ticketId, ownerId: admission.ownerEpoch,
      ...(options.provider === 'z.ai' ? { provider: 'z.ai' as const, model: 'glm-5.3' as const }
        : { provider: 'deepseek' as const, model: 'deepseek-v4-pro' as const }), deadlineMs: admission.deadlineMs,
      allowedToolNames: bridge.definitions.map(t => t.function.name),
      signal: cancellation.signal,
    },
    bearerToken: token, providerApiKey: options.providerApiKey, fetch: options.fetch,
    ...(thinking === undefined ? {} : {thinking}),
    onFailure: failure => {
      const context=currentModel.getStore();
      if (!context || context.failure) throw new Error('model failure context invalid');
      context.failure=failure;
    },
    ...(options.progress ? { beforeRequest: (signal: AbortSignal) => options.progress!.beforeModelRequest(signal) } : {}),
    assertOwner: (ticketId: string, ownerId: string) => {
      if (ticketId !== admission.ticketId || ownerId !== admission.ownerEpoch) throw new Error('scope mismatch');
      live();
    },
  });} catch(error) {bridge.dispose();options.signal?.removeEventListener('abort',cancelFromParent);cancellation.abort();throw error;}
  const deadlineTimer = setTimeout(() => cancellation.abort(new Error('shared deadline exceeded')), Math.max(0, Math.min(2147483647, admission.deadlineMs - Date.now())));
  const authenticated = (request: Request) => {
    const header = request.headers.get('authorization') ?? '';
    return timingSafeEqual(digest(header), digest('Bearer ' + token));
  };
  async function handle(request: Request): Promise<Response> {
    if (!authenticated(request)) return fail(401, 'unauthorized');
    try { live(); } catch { return fail(409, 'session_inactive'); }
    const url = new URL(request.url);
    if (url.search || request.method !== 'POST') return fail(405, 'unsupported_route');
    if (url.pathname === '/v1/chat/completions') {
      const operationId='model-'+(++traceSequence); modelRequests++;
      try {
        options.trace?.append({kind:'model',stage:'start',operationId,...traceContext()});
        const context:{failure?:ModelTransportFailure}={};
        const response=await currentModel.run(context,()=>model(request));
        options.trace?.append({kind:'model',stage:response.ok?'result':'error',operationId,httpStatus:response.status,
          ...(response.ok?{}:{errorCode:auditErrorCode(context.failure?.errorCode ?? 'provider_transport_failed'),
            ...(context.failure?.errorCode==='unsupported_provider_response' && context.failure.responseRejection
              ? {responseRejection:{...context.failure.responseRejection,blockTypes:[...context.failure.responseRejection.blockTypes]}} : {})})});
        return response;
      } catch { cancellation.abort(); return fail(409,'trace_or_model_failed'); }
    }
    if (!['/tools/execute', '/tools/state'].includes(url.pathname)) return fail(404, 'unknown_route');
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return fail(415, 'json_required');
    let body: Record<string, unknown>;
    try {
      if (Number(request.headers.get('content-length')) > 131072) return fail(413, 'body_too_large');
      const reader = request.body?.getReader();
      if (!reader) return fail(400, 'invalid_body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const abortRead = () => { void reader.cancel().catch(() => {}); };
      cancellation.signal.addEventListener('abort', abortRead, { once: true });
      try {
        for (;;) {
          live();
          const part = await reader.read();
          live();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 131072) { void reader.cancel().catch(() => {}); return fail(413, 'body_too_large'); }
          chunks.push(part.value);
        }
      } finally { cancellation.signal.removeEventListener('abort', abortRead); reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'invalid_body');
      body = parsed as Record<string, unknown>;
    } catch { return fail(cancellation.signal.aborted ? 409 : 400, cancellation.signal.aborted ? 'session_inactive' : 'invalid_body'); }
    try { live(); } catch { return fail(409, 'session_inactive'); }
    if (body.taskId !== admission.taskId || body.ownerEpoch !== admission.ownerEpoch) return fail(403, 'scope_mismatch');
    if (url.pathname === '/tools/state') {
      if (Object.keys(body).some(k => !['taskId','ownerEpoch'].includes(k))) return fail(400, 'unknown_field');
      const state = bridge.state;
      return Response.json({ ok: true, state: { finishSummary: clipped(state.finishSummary), blockedReason: clipped(state.blockedReason),
        finishGateMet: state.finishGateMet, invalidated: state.invalidated, todos: state.todos }, runLog: [], runLogCount: state.runLog.length });
    }
    let response: Awaited<ReturnType<typeof bridge.invoke>>;
    const toolName=typeof body.name==='string' && ([...EXECUTOR_TOOL_NAMES, ...INTEGRATION_TOOL_NAMES] as readonly string[]).includes(body.name) ? body.name as AuditToolName : undefined;
    const operationId='tool-'+(++traceSequence);
    try {
      if(options.trace && toolName) {
        options.trace.append({kind:'tool',stage:'start',operationId,toolName,arguments:fingerprintJson(typeof body.arguments==='string'?JSON.parse(body.arguments):body.arguments),...traceContext()});
        response=await currentTool.run({operationId,toolName},()=>bridge.invoke(body));
        options.trace.append({kind:'tool',stage:response.ok?'result':'error',operationId,output:fingerprintBytes(response.content),
          ...(response.ok?{}:{errorCode:auditErrorCode(response.error)})});
      } else response=await bridge.invoke(body);
    } catch { cancellation.abort(); return fail(409,'trace_or_tool_failed'); }
    if (response.ok && options.progress) {
      try { options.progress.observeSuccessfulTool(response.name, typeof body.arguments === 'string' ? JSON.parse(body.arguments) : body.arguments); }
      catch { cancellation.abort(); return fail(409, 'progress_guard_stopped'); }
    }
    try { live(); } catch { return fail(409, 'session_inactive'); }
    return Response.json(response, { status: response.ok ? 200 : 400 });
  }
  return {
    handle,
    /** Parent launches the runtime only after the sandbox/egress path is approved and proven. */
    manifest(baseUrl: string, task: { prompt: string; systemPrompt: string; maxIterations: number; maxTokens: number; temperature?: number }): RuntimeManifest {
      live();
      const base = new URL(baseUrl);
      if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
          || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('unreviewed runtime endpoint');
      if (!Number.isInteger(task.maxIterations) || task.maxIterations < 1 || task.maxIterations > 50
          || !Number.isInteger(task.maxTokens) || task.maxTokens < 1 || task.maxTokens > 8192) throw new Error('invalid runtime limit');
      const temperature = task.temperature ?? 0.3;
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new Error('invalid temperature');
      return { ...task, temperature, taskId: admission.taskId, requestId: admission.requestId, ownerEpoch: admission.ownerEpoch,
        capability: token, modelBaseUrl: new URL('/v1', base).href, executorUrl: new URL('/tools/execute', base).href,
        stateUrl: new URL('/tools/state', base).href, model: options.model, tools: bridge.definitions, deadlineMs: admission.deadlineMs };
    },
    /** Native model prose never grants finish or publication. Only trusted Gary tool state does. */
    result(native: { status?: string; iterations?: number }): AgentLoopResult & { publicationApproved: false; requestId: string; usageSource: 'unavailable-use-spend-ledger'; terminationReason: TerminationReason } {
      const state = bridge.state;
      let status: AgentLoopResult['status'];
      try { live(); status = native.status === 'error' ? 'error' : native.status === 'timeout' ? 'timeout' : state.blockedReason ? 'blocked' : native.status === 'finished' && state.finishSummary && state.finishGateMet && !state.invalidated ? 'finished'
        : native.status === 'iteration_cap' ? 'iteration_cap' : 'no_finish'; }
      catch { status = Date.now() >= admission.deadlineMs || options.signal?.aborted ? 'timeout' : 'error'; }
      const spending = options.ledger.status(admission.ticketId);
      const terminationReason: TerminationReason = spending?.state === 'exhausted' ? 'budget_exhausted'
        : options.progress?.state.stopReason ? 'progress_stopped'
        : options.trace?.failed ? 'trace_failed'
        : Date.now() >= admission.deadlineMs || status === 'timeout' ? 'timeout'
        : options.signal?.aborted ? 'cancelled' : native.status === 'error' ? 'native_error'
        : status === 'error' ? 'session_inactive' : null;
      return { status, summary: status === 'finished' ? state.finishSummary : state.blockedReason,
        iterations: Number.isSafeInteger(native.iterations) && native.iterations! >= 0 ? native.iterations! : 0,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
        phase: 'hermes', runLog: state.runLog, publicationApproved: false, requestId: admission.requestId, usageSource: 'unavailable-use-spend-ledger', terminationReason,
        ...(terminationReason === 'budget_exhausted' ? {errorMessage:'budget_exhausted'} : {}) };
    },
    get state() { return bridge.state; },
    finalizeTrace(outcome: {status:AgentLoopResult['status'];terminationReason:TerminationReason}): boolean {
      if(!options.trace) return true;
      if(options.trace.failed) return false;
      if(traceFinalized) return true;
      traceFinalized=true;
      try {
        options.trace.append({kind:'terminal',status:outcome.terminationReason==='budget_exhausted'?'budget_exhausted':outcome.status,...traceContext(),
          ...(outcome.terminationReason==='budget_exhausted'?{errorCode:'reservation_exhausted' as const}:outcome.status==='error'?{errorCode:'native_runtime_error' as const}:{})});
        options.trace.close();return true;
      } catch {return false;}
    },
    dispose() { disposed = true; clearTimeout(deadlineTimer); cancellation.abort(); options.signal?.removeEventListener('abort', cancelFromParent); bridge.dispose();
      if(options.trace && !traceFinalized && !options.trace.failed) {
        traceFinalized=true;
        try {options.trace.append({kind:'terminal',status:'cancelled',errorCode:'cancelled',...traceContext()});options.trace.close();} catch { /* Failed flag remains authoritative; cleanup has completed. */ }
      }
    },
  };
}
