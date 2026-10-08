/** Production phase mechanics over one admitted host; no scheduler or live transport. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { AgentLoopArgs, PhaseSpec } from "../agent/loop.ts";
import { renderTodos, type TodoItem } from "../agent/tools.ts";
import { EXECUTOR_TOOL_NAMES } from "./executor-bridge.ts";
import { INTEGRATION_TOOL_NAMES } from "./scoped-integrations.ts";
import {
  canonicalArguments, canonicalizeConversation, finiteJson, sameConversation,
  type ConversationMessage,
} from "./conversation.ts";
import {
  createGaryLoopAdapter, MAX_LOOP_ITERATIONS, SINGLE_PHASE_LIMITATIONS,
  type GaryLoopAdapterOptions, type GaryLoopAdapterResult, type NativeRuntimeOutcome, type RuntimeRequestHandler,
} from "./gary-loop-adapter.ts";

export const MAX_PHASE_ITERATIONS = MAX_LOOP_ITERATIONS;
export const PHASE_LIMITATIONS = [
  "History is transferred as verified structured messages, including original tool IDs/results, phase entry messages, nudges and current todos; no text summary substitutes for history.",
  "History over 512 messages or 512 KiB fails closed. Automatic lossy microcompaction is not enabled.",
  "All production integrations and subagents must match explicitly admitted host bindings; optional phase tools absent from those bindings remain unavailable.",
  ...SINGLE_PHASE_LIMITATIONS.filter(text => !text.startsWith("Use the phase coordinator") && !text.startsWith("Gary's per-iteration")),
] as const;
export const PRODUCTION_CODE_GAPS = {
  sourceFile: "src/handlers/code.ts",
  verifiedCapabilities: [
    { capability: "handler_injection", field: "CodeHandlerDeps.runAdmittedAgentLoop", defaultChanged: false },
    { capability: "phase_budget", supported: 50, budgets: { S: [8, 20], M: [15, 35] } },
    { capability: "phase_context", transport: "structured_history", verification: "Actual model requests/responses and authenticated tool receipts" },
    { capability: "native_phase_cap", evidence: "hermes/python/native-stdio-smoke-result.json", additionalSummaryRequests: 0 },
  ],
  callSites: [
    { baseLine: 280, stage: "primary", phaseBudgets: { S: [8, 20], M: [15, 35] } },
    { baseLine: 653, stage: "post_finish_check_fixup", maxIterations: 15 },
    { baseLine: 965, stage: "reviewer_fixup", maxIterations: 15 },
  ],
  requiredDeltas: [
    { capability: "host_admission", required: "Bind each invocation to the canonical owner, isolated executor, current ledger and same approved integration clients" },
    { capability: "final_checks_and_publication", required: "Retain code.ts checks, independent review, repair/recheck and publication guards; loop completion grants no publication authority" },
    { capability: "deployment", required: "Immutable source/image attestation, tested isolation and explicit runtime-owner cutover remain separate gates" },
  ],
} as const;
export interface PhaseTrace {
  name: string; modelRequests: number; nudgeInjected: boolean;
  termination: NativeRuntimeOutcome["status"];
  historyMessages: number;
}
export interface PhaseCoordinatorResult extends GaryLoopAdapterResult {
  contextMode: "structured-history" | "single-phase";
  phaseTrace: readonly PhaseTrace[];
}
interface PreparedPhase { name: string; maxIter: number; allowedTools: readonly string[]; entryMessage?: string; nudgeMessage?: string }
const DEFAULT_NUDGE = "you're approaching the iteration cap. wrap up: commit verified work, then call finish() with a brief summary. If blocked or checks still fail, call report_blocked({reason}) with the blocker and evidence.";
const READ_ONLY_NUDGE = "you're approaching the iteration cap. return the investigation findings and evidence. If blocked, call report_blocked({reason}) with the blocker and evidence.";
const KNOWN = new Set<string>([...EXECUTOR_TOOL_NAMES, ...INTEGRATION_TOOL_NAMES]);
const READ_ONLY = new Set(["read_file", "grep", "list_files", "todo_write", "report_blocked", "fetch_url", "get_linear_issue", "get_pr", "query_cloudflare_logs", "list_cloudflare_invocations", "d1_query", "dispatch_subagent"]);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const digest = (s: string) => createHash("sha256").update(s).digest();
const errorResponse = (code: string, status = 400) => Response.json({ error: { code } }, { status });
function prepare(phases: readonly PhaseSpec[], tools: readonly string[], readOnly: boolean): PreparedPhase[] {
  if (!Array.isArray(phases) || phases.length < 1 || phases.length > 4) throw new Error("unsupported_phase_count");
  let total = 0; const names = new Set<string>();
  return phases.map((phase, index) => {
    if (!phase || typeof phase.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(phase.name) || names.has(phase.name)) throw new Error("invalid_phase_name");
    names.add(phase.name);
    if (!Number.isSafeInteger(phase.maxIter) || phase.maxIter < 1 || phase.maxIter > MAX_PHASE_ITERATIONS || (total += phase.maxIter) > MAX_PHASE_ITERATIONS) throw new Error("unsupported_phase_iteration_budget");
    for (const text of [phase.entryMessage, phase.nudgeMessage]) if (text !== undefined && (typeof text !== "string" || Buffer.byteLength(text) > 8192)) throw new Error("invalid_phase_instruction");
    const requested = phase.allowedTools === undefined ? [...tools] : [...phase.allowedTools];
    if (requested.some(name => !KNOWN.has(name))) throw new Error("unsupported_phase_tools");
    // Gary's investigate set includes optional adapters even when not configured.
    // Intersect known names with actual grants, never synthesize missing handlers.
    const allowedTools = tools.filter(name => requested.includes(name));
    if (index < phases.length - 1 && allowedTools.some(name => !READ_ONLY.has(name))) throw new Error("nonfinal_phase_must_be_read_only");
    if (!allowedTools.includes("report_blocked") || (!readOnly && index === phases.length - 1 && ["run_bash", "finish"].some(name => !allowedTools.includes(name)))) throw new Error("required_phase_control_tools_not_granted");
    return { name: phase.name, maxIter: phase.maxIter, allowedTools,
      ...(phase.entryMessage === undefined ? {} : { entryMessage: phase.entryMessage }),
      ...(phase.nudgeMessage === undefined ? {} : { nudgeMessage: phase.nudgeMessage }) };
  });
}
async function boundedBody(request: Request, signal: AbortSignal, limit: number): Promise<Record<string, unknown>> {
  if (!request.body || request.body.locked) throw new Error("phase_request_body_invalid");
  const reader = request.body.getReader(), bodySignal = AbortSignal.any([signal, request.signal]);
  const abort = () => { void reader.cancel().catch(() => {}); };
  bodySignal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      bodySignal.throwIfAborted(); const part = await reader.read(); bodySignal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength; if (size > limit) { abort(); throw new Error("phase_request_body_too_large"); }
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!object(value) || !finiteJson(value)) throw new Error("phase_request_body_invalid");
    return value;
  } finally { bodySignal.removeEventListener("abort", abort); reader.releaseLock(); }
}
function forwarded(request: Request, body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  if (Buffer.byteLength(raw) > 1_048_576) throw new Error("phase_request_body_too_large");
  const headers = new Headers(request.headers); headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: raw, signal: request.signal });
}
function splitMessages(messages: unknown): { system: Record<string, unknown>[]; history: ConversationMessage[] } {
  if (!Array.isArray(messages)) throw new Error("phase_messages_invalid");
  let at = 0;
  while (at < messages.length && object(messages[at]) && messages[at].role === "system") at++;
  return { system: messages.slice(0, at), history: canonicalizeConversation(messages.slice(at)) };
}
function pendingCall(history: readonly ConversationMessage[], id: unknown): { name: string; arguments: string } | undefined {
  if (typeof id !== "string") return undefined;
  const resolved = new Set(history.filter(row => row.role === "tool").map(row => row.tool_call_id));
  if (resolved.has(id)) return undefined;
  for (const row of history) for (const call of (row.tool_calls ?? []) as Array<{ id: string; function: { name: string; arguments: string } }>) {
    if (call.id === id) return call.function;
  }
  return undefined;
}

/** One canonical admission, ledger, owner, deadline, tool state and verified history. */
export function createGaryPhaseCoordinator(options: GaryLoopAdapterOptions): (args: AgentLoopArgs) => Promise<PhaseCoordinatorResult> {
  let consumed = false;
  return async args => {
    const traces: PhaseTrace[] = [];
    if (consumed) return { status: "error", summary: null, errorMessage: "admitted_adapter_already_used", phase: "single", iterations: 0, runLog: [],
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, publicationApproved: false,
      requestId: options.hostOptions.admission.requestId, usageSource: "unavailable-use-spend-ledger", iterationSource: "authenticated-model-router-requests",
      terminationReason: null, parityLimitations: PHASE_LIMITATIONS, contextMode: "structured-history", phaseTrace: [] };
    consumed = true;
    const contextMode = args.phases === undefined ? "single-phase" : "structured-history";
    let phases: PreparedPhase[];
    try { phases = prepare(args.phases ?? [{ name: "single", maxIter: args.maxIterations, nudgeMessage: args.readOnly ? READ_ONLY_NUDGE : DEFAULT_NUDGE }], options.hostOptions.allowedTools, args.readOnly === true); }
    catch (error) {
      // Let the loop adapter close an already-created audit trace exactly once.
      const rejected = await createGaryLoopAdapter(options)({ ...args, phases: [] });
      return { ...rejected, ...(rejected.terminationReason === "trace_failed" ? {} : { errorMessage: error instanceof Error ? error.message : "invalid_phase_specification" }),
        contextMode: "structured-history", phaseTrace: [], parityLimitations: PHASE_LIMITATIONS };
    }
    const cancellation = new AbortController(); let fault: string | undefined, lastPhase = phases[0]!.name;
    const fail = (code: string) => { fault ??= code; cancellation.abort(); return errorResponse(code); };
    const { phases: _phases, ...singleArgs } = args;
    const { prepareManifest, ...outerOptions } = options;
    const run = createGaryLoopAdapter({ ...outerOptions,
      hostOptions: { ...options.hostOptions, tracePhase: () => lastPhase === "investigate" ? "investigation" : lastPhase === "implement" ? "implementation" : "hermes" },
      launch: async (manifest, hostHandle, signal) => {
        let continued: ConversationMessage[] = []; let currentTodos = "";
        const auth = digest("Bearer " + manifest.capability);
        for (const [index, phase] of phases.entries()) {
          signal.throwIfAborted(); lastPhase = phase.name;
          const allowed = new Set(phase.allowedTools);
          const trace: PhaseTrace = { name: phase.name, modelRequests: 0, nudgeInjected: false, termination: "error", historyMessages: continued.length };
          traces.push(trace);
          let active = true, modelBusy = false;
          let nativeHistory = structuredClone(continued), providerHistory = structuredClone(continued);
          const additions: Array<{ position: number; text: string }> = [];
          const overlay = (history: ConversationMessage[]) => {
            const out: ConversationMessage[] = [];
            for (let at = 0; at <= history.length; at++) {
              for (const item of additions) if (item.position === at) out.push({ role: "user", content: item.text });
              if (at < history.length) out.push(history[at]!);
            }
            return canonicalizeConversation(out, { requireResolved: false });
          };
          const draftManifest = { ...manifest,
            prompt: index === 0 ? manifest.prompt : phase.entryMessage ?? "Continue the admitted task in the next phase.",
            history: structuredClone(continued), maxIterations: phase.maxIter,
            tools: manifest.tools.filter(definition => allowed.has(definition.function.name)) };
          if (prepareManifest) {
            const prepared = await prepareManifest(Object.freeze({ ...draftManifest }), signal);
            signal.throwIfAborted();
            if (!prepared || Object.keys(prepared).some(key => key !== "prompt") || typeof prepared.prompt !== "string"
                || !prepared.prompt.trim() || Buffer.byteLength(prepared.prompt) > 524_288) throw new Error("invalid_prepared_prompt");
            draftManifest.prompt = prepared.prompt;
          }
          const phaseManifest = Object.freeze(draftManifest);
          nativeHistory = canonicalizeConversation([...continued, { role: "user", content: phaseManifest.prompt }]);
          providerHistory = structuredClone(nativeHistory);
          let pendingJob:{jobId:string;callId:string}|undefined;
          const handle: RuntimeRequestHandler = async request => {
            if (!active || signal.aborted) return errorResponse("phase_inactive", 409);
            const url = new URL(request.url);
            if (!timingSafeEqual(auth, digest(request.headers.get("authorization") ?? "")) || request.method !== "POST" || url.search
                || !["/tools/execute", "/tools/jobs/poll", "/v1/chat/completions"].includes(url.pathname)) return hostHandle(request);
            let acquired = false;
            try {
              const model = url.pathname === "/v1/chat/completions";
              const poll = url.pathname === '/tools/jobs/poll';
              if(pendingJob && !poll)return fail('phase_test_job_pending');
              if (model) { if (modelBusy) return fail("concurrent_phase_model_requests"); modelBusy = true; acquired = true; }
              const body = await boundedBody(request, signal, model ? 1_048_576 : 131_072);
              if (!active || signal.aborted) return errorResponse("phase_inactive", 409);
              if(pendingJob && !poll)return fail("phase_test_job_pending");
              if (model) {
                if (trace.modelRequests >= phase.maxIter) return fail("phase_iteration_limit");
                trace.modelRequests++;
                if (Array.isArray(body.tools) && body.tools.some(tool => !object(tool) || !object(tool.function) || typeof tool.function.name !== "string" || !allowed.has(tool.function.name))) return fail("phase_model_tools_denied");
                const incoming = splitMessages(body.messages);
                if (!sameConversation(nativeHistory, incoming.history)) return fail("phase_history_rewritten");
                nativeHistory = incoming.history;
                if (phase.nudgeMessage && trace.modelRequests === Math.max(1, Math.floor(phase.maxIter * 0.8))) {
                  additions.push({ position: nativeHistory.length, text: phase.nudgeMessage }); trace.nudgeInjected = true;
                }
                providerHistory = overlay(nativeHistory);
                // Gary owns the admitted persona/instructions. Native helper prompts do
                // not acquire system authority by arriving through the model router.
                body.messages = [{ role: "system", content: phaseManifest.systemPrompt }, ...providerHistory];
                const response = await hostHandle(forwarded(request, body));
                if (response.ok) {
                  const completion = await response.clone().json();
                  const assistant = completion?.choices?.[0]?.message;
                  nativeHistory = canonicalizeConversation([...nativeHistory, assistant], { requireResolved: false });
                  providerHistory = canonicalizeConversation([...providerHistory, assistant], { requireResolved: false });
                }
                return response;
              }
              if(pendingJob && !poll)return fail('phase_test_job_pending');
              if(poll) {
                if(!pendingJob || body.taskId!==manifest.taskId || body.requestId!==manifest.requestId || body.ownerEpoch!==manifest.ownerEpoch
                    || body.callId!==pendingJob.callId || body.jobId!==pendingJob.jobId) return fail('phase_test_job_mismatch');
                const expected=pendingCall(nativeHistory,body.callId);
                if(!expected || expected.name!=='run_bash')return fail('phase_test_job_history_mismatch');
                const response=await hostHandle(forwarded(request,body)), envelope=await response.clone().json();
                if(response.status===202) {
                  if(envelope.kind!=='test_job_pending' || envelope.jobId!==pendingJob.jobId || envelope.callId!==pendingJob.callId) return fail('phase_test_job_mismatch');
                  return response;
                }
                if(envelope.kind==='test_job_complete') {
                  const receipt=envelope.receipt;
                  if(envelope.jobId!==pendingJob.jobId || envelope.callId!==pendingJob.callId || !object(receipt)
                      || receipt.tool_call_id!==pendingJob.callId || receipt.name!=='run_bash' || typeof receipt.content!=='string' || typeof receipt.ok!=='boolean') return fail('phase_test_job_receipt_mismatch');
                  const row={role:'tool',tool_call_id:pendingJob.callId,content:receipt.content.replaceAll(manifest.capability,'[REDACTED]')};
                  nativeHistory=canonicalizeConversation([...nativeHistory,row],{requireResolved:false});
                  providerHistory=canonicalizeConversation([...providerHistory,row],{requireResolved:false});
                  pendingJob=undefined;
                  try {canonicalizeConversation(nativeHistory);if(currentTodos){additions.push({position:nativeHistory.length,text:'[current todos]\n'+currentTodos});providerHistory=overlay(nativeHistory);}} catch {}
                }
                return response;
              }
              if (body.taskId !== manifest.taskId || body.ownerEpoch !== manifest.ownerEpoch || body.token !== manifest.capability) return hostHandle(forwarded(request, body));
              if (typeof body.name === "string" && !allowed.has(body.name)) return Response.json({ ok: false, tool_call_id: body.callId, name: body.name,
                content: `error: tool '${body.name}' is unavailable in phase '${phase.name}'`, error: "phase_tool_denied", truncated: false }, { status: 400 });
              const expected = pendingCall(nativeHistory, body.callId);
              if (!expected || body.name !== expected.name || canonicalArguments(body.arguments) !== expected.arguments) return fail("tool_call_history_mismatch");
              const response = await hostHandle(forwarded(request, body));
              const receipt = await response.clone().json();
              if(response.status===202) {
                if(pendingJob || receipt.kind!=='test_job_pending' || typeof receipt.jobId!=='string' || receipt.callId!==body.callId
                    || receipt.taskId!==manifest.taskId || receipt.requestId!==manifest.requestId || receipt.ownerEpoch!==manifest.ownerEpoch || receipt.name!=='run_bash' || body.name!=='run_bash')return fail('phase_test_job_mismatch');
                pendingJob={jobId:receipt.jobId,callId:body.callId as string};
                return response;
              }
              if (typeof receipt.content === "string" && receipt.tool_call_id === body.callId && receipt.name === body.name && typeof receipt.ok === "boolean") {
                const row = { role: "tool", tool_call_id: body.callId, content: receipt.content.replaceAll(manifest.capability, "[REDACTED]") };
                nativeHistory = canonicalizeConversation([...nativeHistory, row], { requireResolved: false });
                providerHistory = canonicalizeConversation([...providerHistory, row], { requireResolved: false });
                if (receipt.ok && body.name === "todo_write") currentTodos = receipt.content === "(no todos)" ? "" : receipt.content;
                // Gary appends current todos only after the whole tool batch.
                try {
                  canonicalizeConversation(nativeHistory);
                  if (currentTodos) { additions.push({ position: nativeHistory.length, text: "[current todos]\n" + currentTodos }); providerHistory = overlay(nativeHistory); }
                } catch { /* Remaining calls in this assistant batch must settle first. */ }
              }
              return response;
            } catch { return fail("phase_request_rejected"); }
            finally { if (acquired) modelBusy = false; }
          };
          let native: NativeRuntimeOutcome;
          try { native = await options.launch(phaseManifest, handle, signal); }
          finally { active = false; }
          signal.throwIfAborted();
          if(pendingJob){fail('phase_returned_with_pending_test');throw new Error(fault);}
          if (!native || native.taskId !== manifest.taskId || native.requestId !== manifest.requestId || native.publicationApproved !== false
              || !["finished", "blocked", "no_finish", "iteration_cap", "timeout", "error"].includes(native.status)) { fail("native_phase_outcome_binding_rejected"); throw new Error(fault); }
          if (native.status === "error" || native.status === "timeout") { trace.termination = native.status; return native; }
          let exported: ConversationMessage[];
          try { exported = canonicalizeConversation(native.history); }
          catch { fail("native_phase_history_invalid"); throw new Error(fault); }
          if (!sameConversation(exported, canonicalizeConversation(nativeHistory))) { fail("native_phase_history_mismatch"); throw new Error(fault); }
          continued = canonicalizeConversation(providerHistory); trace.historyMessages = continued.length;
          const stateResponse = await hostHandle(new Request(manifest.stateUrl, { method: "POST", headers: { authorization: "Bearer " + manifest.capability, "content-type": "application/json" },
            body: JSON.stringify({ taskId: manifest.taskId, ownerEpoch: manifest.ownerEpoch }) }));
          const stateReceipt = await stateResponse.json(); signal.throwIfAborted();
          if (!stateResponse.ok || stateReceipt.ok !== true || !object(stateReceipt.state)) { fail("phase_state_unavailable"); throw new Error(fault); }
          const state = stateReceipt.state;
          if (Array.isArray(state.todos)) currentTodos = state.todos.length ? renderTodos(state.todos as TodoItem[]) : "";
          if (state.blockedReason) { trace.termination = "blocked"; return { ...native, status: "blocked" }; }
          if (native.status === "finished" && state.finishSummary && state.finishGateMet === true) { trace.termination = "finished"; return native; }
          if (native.status === "finished" || native.status === "blocked") { fail("native_phase_terminal_not_verified"); throw new Error(fault); }
          if (trace.modelRequests === 0) { fail("empty_phase_history"); throw new Error(fault); }
          trace.termination = native.status;
          if (index === phases.length - 1) return native;
        }
        throw new Error("phase_sequence_empty");
      } });
    try {
      const outcome = await run({ ...singleArgs, maxIterations: phases.reduce((sum, phase) => sum + phase.maxIter, 0), signal: args.signal ? AbortSignal.any([args.signal, cancellation.signal]) : cancellation.signal });
      if (traces.length && (outcome.status === "error" || outcome.status === "timeout")) traces.at(-1)!.termination = outcome.status;
      return { ...outcome, phase: lastPhase, ...(fault && outcome.terminationReason !== "trace_failed" ? { errorMessage: fault } : {}), contextMode, phaseTrace: traces.map(t => ({ ...t })), parityLimitations: PHASE_LIMITATIONS };
    } finally { cancellation.abort(); }
  };
}
