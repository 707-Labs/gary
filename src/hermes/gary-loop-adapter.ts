/** Offline integration seam; importing or constructing it starts no listener/process. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { AgentLoopArgs, AgentLoopResult } from "../agent/loop.ts";
import { createDeadline } from "../deadline.ts";
import { createSessionHost, type RuntimeManifest, type SessionOptions, type TerminationReason } from "./session-host.ts";
import { unknownAuditModelState } from "./audit-trace.ts";
import type { ConversationMessage } from "./conversation.ts";

export const MAX_LOOP_ITERATIONS = 50;

export type GaryRuntimeManifest = RuntimeManifest & { temperature: number };
export interface NativeRuntimeOutcome {
  taskId: string;
  requestId: string;
  status: "finished" | "blocked" | "no_finish" | "iteration_cap" | "timeout" | "error";
  publicationApproved: false;
  modelAttempts?: number;
  iterations?: number;
  text?: string;
  reason?: string;
  history?: ConversationMessage[];
}
export type RuntimeRequestHandler = (request: Request) => Promise<Response>;
/** Must resolve/reject ONLY after the child and its I/O have stopped and cleanup has settled. */
export type GaryRuntimeLauncher = (
  manifest: Readonly<GaryRuntimeManifest>, handle: RuntimeRequestHandler, signal: AbortSignal,
) => Promise<NativeRuntimeOutcome>;

export interface GaryLoopAdapterOptions {
  /** Existing canonical admission, ledger, isolated executor and reviewed model route. */
  hostOptions: SessionOptions;
  /** A reviewed loopback binding reserved by the launcher; no listener is created here. */
  baseUrl: string;
  launch: GaryRuntimeLauncher;
  /** Trusted host context refreshed before each launch; no other manifest field can change. */
  prepareManifest?: (manifest: Readonly<GaryRuntimeManifest>, signal: AbortSignal) => Promise<{ prompt: string }>;
}

export const SINGLE_PHASE_LIMITATIONS = [
  "Use the phase coordinator for phases. Integrations/subagents require matching explicit host bindings; read-only children require a host-isolated read-only executor.",
  "The admitted guarded model route replaces glm; the legacy provider fallback chain is not invoked.",
  "Gary's per-iteration nudge, todo reinjection and microcompaction are not reproduced by this seam.",
  "Token counters are unavailable here; zero placeholders are not billing evidence. Use the existing spend ledger.",
  "The launcher must enforce child process/egress isolation and settle cancellation cleanup; this seam does not launch or sandbox a process.",
  "Finished is a verified tool-state result, not independent review or publication approval.",
] as const;

export interface GaryLoopAdapterResult extends AgentLoopResult {
  publicationApproved: false;
  requestId: string;
  usageSource: "unavailable-use-spend-ledger";
  iterationSource: "authenticated-model-router-requests";
  parityLimitations: readonly string[];
  terminationReason: TerminationReason;
}

const hash = (text: string) => createHash("sha256").update(text).digest();
const nativeStatuses = new Set(["finished", "blocked", "no_finish", "iteration_cap", "timeout", "error"]);
const MAX_MODEL_BODY = 1_048_576;

function unsupported(args: AgentLoopArgs, host: SessionOptions): string | null {
  if (args.phases !== undefined) return "unsupported_loop_option:phases";
  const bindings = host.integrations;
  for (const key of ["cloudflare", "linear", "github"] as const) {
    const client = bindings?.[key]?.client;
    if (args[key] !== undefined && client === undefined) return "unsupported_loop_option:" + key;
    if (args[key] !== client) return "integration_binding_mismatch:" + key;
  }
  const issue = bindings?.linear?.currentIssue;
  if (args.currentIssue !== undefined && issue === undefined) return "unsupported_loop_option:currentIssue";
  if ((args.currentIssue === undefined) !== (issue === undefined)
      || (args.currentIssue && issue && ["id", "identifier", "teamId"].some(key => args.currentIssue![key as keyof typeof issue] !== issue[key as keyof typeof issue]))) return "integration_binding_mismatch:currentIssue";
  const repo = bindings?.github?.defaultRepo;
  if (args.defaultRepo !== undefined && repo === undefined) return "unsupported_loop_option:defaultRepo";
  if (args.defaultRepo !== repo) return "integration_binding_mismatch:defaultRepo";
  const integrationTools = { linear: ["get_linear_issue"], github: ["get_pr"],
    cloudflare: [...(bindings?.cloudflare?.allowedServices.length ? ["query_cloudflare_logs", "list_cloudflare_invocations"] : []),
      ...(bindings?.cloudflare?.allowedDatabases.length ? ["d1_query"] : [])] };
  for (const key of ["linear", "github", "cloudflare"] as const) {
    if (args[key] !== undefined && integrationTools[key].some(name => !host.allowedTools.includes(name))) return "integration_tools_not_granted:" + key;
  }
  if (args.currentIssue && ["unassign_self", "set_ticket_state", "update_ticket_description"].some(name => !host.allowedTools.includes(name))) return "integration_tools_not_granted:currentIssue";
  if (args.disableSubagent !== true && (!bindings?.subagentRunner || !host.allowedTools.includes("dispatch_subagent"))) return "unsupported_loop_option:subagents_must_be_disabled";
  if (args.disableSubagent === true && host.allowedTools.includes("dispatch_subagent")) return "subagent_binding_mismatch";
  if (args.readOnly === true && host.readOnly !== true) return "unsupported_loop_option:readOnly";
  if ((args.readOnly === true) !== (host.readOnly === true)) return "readonly_binding_mismatch";
  if (args.executor !== host.executor) return "executor_does_not_match_admission";
  if (args.readOnly) {
    if (args.finishGateCommand !== undefined || host.finishGateCommand !== "") return "readonly_finish_gate_mismatch";
    if (host.allowedTools.some(name => ["write_file", "edit_file", "commit", "finish", "dispatch_subagent", "unassign_self", "set_ticket_state", "update_ticket_description"].includes(name))) return "readonly_mutation_granted";
  } else {
    if (!args.finishGateCommand || args.finishGateCommand !== host.finishGateCommand) return "finish_gate_does_not_match_admission";
    if (!["run_bash", "finish", "report_blocked"].every(name => host.allowedTools.includes(name))) return "required_control_tools_not_granted";
  }
  if (typeof args.task !== "string" || !args.task.trim() || typeof args.systemPrompt !== "string" || !args.systemPrompt.trim()) return "invalid_task_or_system_prompt";
  if (!Number.isSafeInteger(args.maxIterations) || args.maxIterations < 1 || args.maxIterations > MAX_LOOP_ITERATIONS) return "unsupported_iteration_limit";
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 0 || (args.deadlineMs !== undefined && !Number.isFinite(args.deadlineMs))) return "invalid_deadline";
  const maxTokens = args.maxTokensPerTurn ?? 8192, temperature = args.temperature ?? 0.3;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) return "unsupported_output_limit";
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) return "unsupported_temperature";
  return null;
}

/** One admitted invocation per adapter. Reuse requires a new canonical admission/capability. */
export function createGaryLoopAdapter(options: GaryLoopAdapterOptions): (args: AgentLoopArgs) => Promise<GaryLoopAdapterResult> {
  const configured = { ...options.hostOptions, admission: { ...options.hostOptions.admission },
    allowedTools: [...options.hostOptions.allowedTools] };
  let consumed = false;
  return async function runGaryHermesLoop(args): Promise<GaryLoopAdapterResult> {
    const empty = (errorMessage: string, status: AgentLoopResult["status"] = "error"): GaryLoopAdapterResult => ({
      status, summary: null, iterations: 0, errorMessage, phase: "single", runLog: [],
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
      publicationApproved: false, requestId: configured.admission.requestId,
      usageSource: "unavailable-use-spend-ledger", iterationSource: "authenticated-model-router-requests",
      parityLimitations: SINGLE_PHASE_LIMITATIONS,
      terminationReason: configured.ledger.status(configured.admission.ticketId)?.state === 'exhausted' ? 'budget_exhausted' : null,
    });
    if (consumed) return empty("admitted_adapter_already_used");
    consumed = true;
    let fallbackTraceFinalized = false;
    const traceFailure = (outcome: GaryLoopAdapterResult): GaryLoopAdapterResult => ({ ...outcome,
      status: "error", summary: null, terminationReason: "trace_failed", errorMessage: "trace_persistence_failed" });
    // An externally created trace already has a durable run-start record, even
    // when argument validation or host construction refuses this invocation.
    // The adapter owns that trace until a host has successfully been returned.
    const finalizeUnhostedTrace = (outcome: GaryLoopAdapterResult): GaryLoopAdapterResult => {
      if (!configured.trace || fallbackTraceFinalized) return outcome;
      fallbackTraceFinalized = true;
      try {
        if (configured.trace.failed) return traceFailure(outcome);
        configured.trace.append({ kind: "terminal", status: outcome.terminationReason === "budget_exhausted" ? "budget_exhausted" : outcome.status,
          iteration: 0, phase: "single", modelState: unknownAuditModelState(),
          errorCode: outcome.terminationReason === "budget_exhausted" ? "reservation_exhausted" : "session_inactive" });
        configured.trace.close();
        return outcome;
      } catch {
        // The concrete writer closes its descriptor when persistence fails.
        // A foreign sink still gets one cleanup attempt, without retrying append.
        try { configured.trace.close(); } catch { /* Fixed typed outcome below. */ }
        return traceFailure(outcome);
      }
    };
    const limitation = unsupported(args, configured);
    if (limitation) return finalizeUnhostedTrace(empty(limitation));
    const cancellation = new AbortController();
    const signals = [cancellation.signal, args.signal, configured.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    let budget: ReturnType<typeof createDeadline>;
    try {
      budget = createDeadline({ timeoutMs: args.timeoutMs,
        deadlineMs: Math.min(configured.admission.deadlineMs, args.deadlineMs ?? Infinity),
        signal: AbortSignal.any(signals) });
    } catch { return finalizeUnhostedTrace(empty("runtime_deadline_initialization_failed")); }
    let host: ReturnType<typeof createSessionHost> | undefined;
    let modelRequests = 0;
    let modelInFlight = false;
    let fatal: string | null = null;
    const failure = (code: string, status = 400): Response => Response.json({ error: { code } }, { status });
    const guard = () => { budget.throwIfExpired(); if (fatal) throw new Error("runtime_protocol_rejected"); };
    const protocolFault = (code: string) => { fatal ??= code; cancellation.abort(); return failure(code); };
    const result = async (native: NativeRuntimeOutcome["status"], errorMessage?: string, nativeText?: string): Promise<GaryLoopAdapterResult> => {
      await host?.drain();
      const base = host ? host.result({ status: native, iterations: modelRequests }) : empty(errorMessage ?? "session_unavailable");
      let status = base.status;
      if (Date.now() >= budget.deadlineMs) status = "timeout";
      else if (fatal || budget.signal.aborted || errorMessage) status = "error";
      if (status === "finished" && modelRequests === 0) { status = "error"; errorMessage = "finished_without_model_request"; }
      const outcome: GaryLoopAdapterResult = { ...base, status, summary: status === "finished" || status === "blocked" ? base.summary : null,
        ...(configured.readOnly && status === "no_finish" && modelRequests > 0 && typeof nativeText === "string"
          ? { summary: nativeText.replaceAll(configured.capabilityToken, "[REDACTED]").slice(0, 65536) } : {}),
        phase: "single", iterations: modelRequests, ...(base.terminationReason === 'budget_exhausted' ? {errorMessage:'budget_exhausted'} : errorMessage ? { errorMessage } : {}),
        publicationApproved: false, requestId: configured.admission.requestId,
        usageSource: "unavailable-use-spend-ledger", iterationSource: "authenticated-model-router-requests",
        parityLimitations: SINGLE_PHASE_LIMITATIONS };
      if (!host) return finalizeUnhostedTrace(outcome);
      return host.finalizeTrace({ status, terminationReason: base.terminationReason }) ? outcome : traceFailure(outcome);
    };
    try {
      guard();
      host = createSessionHost({ ...configured,
        admission: { ...configured.admission, deadlineMs: budget.deadlineMs }, signal: budget.signal });
      const manifest: GaryRuntimeManifest = { ...host.manifest(options.baseUrl, {
        prompt: args.task, systemPrompt: args.systemPrompt, maxIterations: args.maxIterations,
        maxTokens: args.maxTokensPerTurn ?? 8192 }), temperature: args.temperature ?? 0.3 };
      if (options.prepareManifest) {
        const prepared = await options.prepareManifest(Object.freeze({ ...manifest }), budget.signal);
        guard();
        if (!prepared || Object.keys(prepared).some(key => key !== "prompt") || typeof prepared.prompt !== "string"
            || !prepared.prompt.trim() || Buffer.byteLength(prepared.prompt) > 524_288) throw new Error("invalid_prepared_prompt");
        manifest.prompt = prepared.prompt;
      }
      const expectedAuthorization = hash("Bearer " + configured.capabilityToken);
      const handle: RuntimeRequestHandler = async request => {
        let acquiredModel = false;
        try {
          try { guard(); } catch { return failure("session_inactive", 409); }
          if (new URL(request.url).pathname === "/v1/chat/completions"
              && timingSafeEqual(expectedAuthorization, hash(request.headers.get("authorization") ?? ""))) {
            if (request.method !== "POST") return protocolFault("model_method_rejected");
            if (modelInFlight) return protocolFault("concurrent_model_requests_rejected");
            modelInFlight = true; acquiredModel = true;
            if (modelRequests >= args.maxIterations) return protocolFault("model_iteration_limit");
            // Consume once, then forward the bounded original bytes for the canonical
            // transport's complete schema, spend reservation and ownership checks.
            // A tee/clone would leave an unread branch buffered after cancellation.
            const reader = request.body?.getReader();
            if (!reader) return protocolFault("model_body_required");
            const chunks: Uint8Array[] = [];
            let total = 0;
            const bodySignal = AbortSignal.any([budget.signal, request.signal]);
            const onAbort = () => { void reader.cancel().catch(() => {}); };
            bodySignal.addEventListener("abort", onAbort, { once: true });
            try {
              for (;;) {
                guard(); bodySignal.throwIfAborted();
                const part = await reader.read();
                guard(); bodySignal.throwIfAborted();
                if (part.done) break;
                total += part.value.byteLength;
                if (total > MAX_MODEL_BODY) { void reader.cancel().catch(() => {}); return protocolFault("model_body_too_large"); }
                chunks.push(part.value);
              }
              const bytes = Buffer.concat(chunks);
              const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
              if (!body || typeof body !== "object" || Array.isArray(body)
                  || !Number.isSafeInteger(body.max_tokens) || (body.max_tokens as number) < 1
                  || (body.max_tokens as number) > manifest.maxTokens || body.temperature !== manifest.temperature) {
                return protocolFault("model_run_limits_rejected");
              }
              request = new Request(request.url, { method: request.method, headers: request.headers,
                body: bytes, signal: request.signal });
            } catch { return protocolFault("model_body_or_deadline_rejected"); }
            finally { bodySignal.removeEventListener("abort", onAbort); reader.releaseLock(); }
            guard();
            modelRequests++;
          }
          let response: Response;
          try { response = await host!.handle(request); guard(); }
          catch { return failure("session_inactive", 409); }
          return response;
        } finally { if (acquiredModel) modelInFlight = false; }
      };
      // The launcher receives no executor, glm, ledger, upstream key or adapter.
      // It must use these URLs/router for every model and tool request.
      const native = await options.launch(Object.freeze(manifest), handle, budget.signal);
      guard();
      if (!native || native.taskId !== manifest.taskId || native.requestId !== manifest.requestId
          || native.publicationApproved !== false || !nativeStatuses.has(native.status)) {
        return await result("error", "native_outcome_binding_rejected");
      }
      return await result(native.status, undefined, native.text);
    } catch {
      return await result("error", fatal ?? (Date.now() >= budget.deadlineMs ? "shared_deadline_exceeded"
        : budget.signal.aborted ? "aborted" : "runtime_launch_or_admission_failed"));
    } finally {
      cancellation.abort();
      try { await host?.drain(); host?.dispose(); } finally { budget.dispose(); }
    }
  };
}
