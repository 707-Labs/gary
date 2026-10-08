/**
 * Durable task trace, metadata and hashes only. No prompt, command, argument,
 * model reasoning or output preview is persisted. Hashes can establish repeated
 * work/content identity but cannot reconstruct discarded output or prove truth.
 *
 * Creation requires an existing private parent directory and a fresh filename.
 * Every append writes a complete ordered JSON line then fsyncs before returning.
 * Call append(start) before the side effect; a persistence error latches failed
 * and must revoke the host session. A failed/partial trailing write is never
 * retried or treated as a recorded result. This is not a spending ledger.
 */
import { readRuntimeDiagnostic, type RuntimeDiagnostic } from "./runtime-diagnostics.ts";
import { createHash } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface AuditTraceBinding {
  taskId: string; requestId: string; actionId: string; ownerEpoch: string; ticketId?: string;
}
export interface AuditFingerprint { readonly bytes: number; readonly sha256: string }
export type AuditPhase = "unknown" | "single" | "hermes" | "investigation" | "implementation" | "validation" | "review" | "publication";
export interface AuditModelState {
  provider: "unknown" | "deepseek" | "z.ai";
  model: "unknown" | "deepseek-v4-pro" | "glm-5.3";
  /** Only explicitly selected request settings. Provider defaults stay unknown. */
  thinking: "unknown" | "enabled" | "disabled" | "adaptive";
  effort: "unknown" | "low" | "medium" | "high" | "max";
  thinkingBudgetTokens?: number;
}
export type AuditToolName = "read_file" | "write_file" | "edit_file" | "grep" | "list_files" | "run_bash" | "commit" | "todo_write" | "finish" | "report_blocked" | "fetch_url" | "get_linear_issue" | "unassign_self" | "set_ticket_state" | "update_ticket_description" | "get_pr" | "query_cloudflare_logs" | "list_cloudflare_invocations" | "d1_query" | "dispatch_subagent";
const errorCodes = ["unknown", "cancelled", "deadline_exceeded", "owner_revoked", "admission_revoked", "allocation_inactive",
  "spend_guard_rejected", "reservation_exhausted", "receipt_exceeds_bounds", "provider_transport_failed", "provider_request_failed",
  "unsupported_provider_response", "unsupported_request", "unauthorized", "session_inactive", "request_in_flight", "tool_failed",
  "tool_denied", "path_denied", "invalid_arguments", "duplicate_call", "call_limit", "bridge_busy", "task_terminal",
  "capability_inactive", "capability_revoked", "executor_result_invalid", "native_runtime_error", "protocol_rejected", "cleanup_failed",
  "trace_persistence_failed", "unsupported_route", "body_too_large", "progress_guard_stopped", "operator_stopped", "process_exit", "signal", "aborted", "deadline_or_request_aborted"] as const;
export type AuditErrorCode = typeof errorCodes[number];
export type AuditTerminalStatus = "finished" | "blocked" | "no_finish" | "iteration_cap" | "timeout" | "error" | "cancelled" | "budget_exhausted";
interface AuditContext { iteration: number | "unknown"; phase: AuditPhase; modelState: AuditModelState }
interface StartBase extends AuditContext {
  stage: "start"; operationId: string; parentOperationId?: string;
  input?: AuditFingerprint; arguments?: AuditFingerprint; command?: AuditFingerprint;
}
export type AuditOperationStart = StartBase & ({ kind: "model" } | { kind: "tool"; toolName: AuditToolName });
export interface AuditResponseRejection {
  category: "invalid_json" | "envelope" | "model_mismatch" | "content_shape" | "unsupported_block_type" | "invalid_text_block" | "invalid_tool_block" | "tool_policy" | "parallel_tool_policy" | "required_tool_missing" | "stop_reason" | "stop_tool_mismatch" | "empty_content";
  blockTypes: ("text" | "tool_use" | "thinking" | "redacted_thinking" | "server_tool_use" | "tool_result" | "image" | "document" | "other" | "not_object")[];
  blockCount: number | null;
  stopReason: "end_turn" | "stop_sequence" | "max_tokens" | "tool_use" | "pause_turn" | "refusal" | "other" | "missing";
  modelMatches: boolean;
}
export interface AuditOperationEnd {
  kind: "model" | "tool"; stage: "result" | "error" | "cancel"; operationId: string;
  output?: AuditFingerprint; stdout?: AuditFingerprint; stderr?: AuditFingerprint;
  exitCode?: number | null; timedOut?: boolean; errorCode?: AuditErrorCode;
  /** Only a host-observed count; never inferred from model text or a tool claim. */
  trustedChangedFileCount?: number;
  httpStatus?: number;
  responseRejection?: AuditResponseRejection;
}
export interface AuditTerminal extends AuditContext {
  diagnostic?: RuntimeDiagnostic;
  kind: "terminal"; status: AuditTerminalStatus; errorCode?: AuditErrorCode;
  trustedChangedFileCount?: number;
}
export type AuditTraceEvent = AuditOperationStart | AuditOperationEnd | AuditTerminal;
export interface AuditTrace {
  readonly failed: boolean;
  readonly binding: Readonly<AuditTraceBinding>;
  append(event: AuditTraceEvent): void;
  /** A terminal event is mandatory. fsyncs again; failure cannot become success. */
  close(): void;
}
export interface AuditTraceOptions {
  path: string; binding: AuditTraceBinding; maxEvents?: number; maxBytes?: number;
}
export class AuditTraceError extends Error {
  constructor(readonly code: "invalid_trace_options" | "invalid_trace_event" | "trace_persistence_failed" | "trace_closed" | "terminal_event_required") {
    super(code); this.name = "AuditTraceError";
  }
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const phases = new Set<string>(["unknown", "single", "hermes", "investigation", "implementation", "validation", "review", "publication"]);
const toolNames = new Set<string>(["read_file", "write_file", "edit_file", "grep", "list_files", "run_bash", "commit", "todo_write", "finish", "report_blocked", "fetch_url", "get_linear_issue", "unassign_self", "set_ticket_state", "update_ticket_description", "get_pr", "query_cloudflare_logs", "list_cloudflare_invocations", "d1_query", "dispatch_subagent"]);
const terminalStatuses = new Set<string>(["finished", "blocked", "no_finish", "iteration_cap", "timeout", "error", "cancelled", "budget_exhausted"]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function only(value: Record<string, unknown>, names: readonly string[]): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !names.includes(key)
      || typeof Object.getOwnPropertyDescriptor(value, key)?.get === "function")) throw new AuditTraceError("invalid_trace_event");
}
const natural = (value: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const id = (value: unknown) => typeof value === "string" && ID.test(value);
function fingerprint(value: unknown): void {
  if (!object(value)) throw new AuditTraceError("invalid_trace_event");
  only(value, ["bytes", "sha256"]);
  if (!natural(value.bytes) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new AuditTraceError("invalid_trace_event");
}
function context(value: Record<string, unknown>): void {
  if ((value.iteration !== "unknown" && !natural(value.iteration, 1_000_000)) || !phases.has(value.phase as string) || !object(value.modelState)) throw new AuditTraceError("invalid_trace_event");
  const model = value.modelState;
  only(model, ["provider", "model", "thinking", "effort", "thinkingBudgetTokens"]);
  if (!["unknown", "deepseek", "z.ai"].includes(model.provider as string) || !["unknown", "deepseek-v4-pro", "glm-5.3"].includes(model.model as string)
      || !["unknown", "enabled", "disabled", "adaptive"].includes(model.thinking as string)
      || !["unknown", "low", "medium", "high", "max"].includes(model.effort as string)
      || (model.provider === "deepseek" && !["unknown", "deepseek-v4-pro"].includes(model.model as string))
      || (model.provider === "z.ai" && !["unknown", "glm-5.3"].includes(model.model as string))
      || (Object.hasOwn(model, "thinkingBudgetTokens") && (model.thinking !== "enabled" || !natural(model.thinkingBudgetTokens, 1_048_576)))) throw new AuditTraceError("invalid_trace_event");
}
function responseRejection(value: unknown): void {
  if (!object(value)) throw new AuditTraceError("invalid_trace_event");
  only(value, ["category", "blockTypes", "blockCount", "stopReason", "modelMatches"]);
  if (!["invalid_json", "envelope", "model_mismatch", "content_shape", "unsupported_block_type", "invalid_text_block", "invalid_tool_block", "tool_policy", "parallel_tool_policy", "required_tool_missing", "stop_reason", "stop_tool_mismatch", "empty_content"].includes(value.category as string)
      || (value.blockCount !== null && !natural(value.blockCount, 1_000_000))
      || !["end_turn", "stop_sequence", "max_tokens", "tool_use", "pause_turn", "refusal", "other", "missing"].includes(value.stopReason as string)
      || typeof value.modelMatches !== "boolean" || !Array.isArray(value.blockTypes) || value.blockTypes.length > 10) throw new AuditTraceError("invalid_trace_event");
  const descriptors = Object.getOwnPropertyDescriptors(value.blockTypes), seen = new Set<string>();
  if (Reflect.ownKeys(value.blockTypes).length !== value.blockTypes.length + 1) throw new AuditTraceError("invalid_trace_event");
  for (let i = 0; i < value.blockTypes.length; i++) {
    const item = descriptors[String(i)];
    if (!item || !Object.hasOwn(item, "value") || typeof item.value !== "string"
        || !["text", "tool_use", "thinking", "redacted_thinking", "server_tool_use", "tool_result", "image", "document", "other", "not_object"].includes(item.value)
        || seen.has(item.value)) throw new AuditTraceError("invalid_trace_event");
    seen.add(item.value);
  }
}
export function auditErrorCode(value: unknown): AuditErrorCode {
  return typeof value === "string" && (errorCodes as readonly string[]).includes(value) ? value as AuditErrorCode : "unknown";
}
export function unknownAuditModelState(): AuditModelState {
  return { provider: "unknown", model: "unknown", thinking: "unknown", effort: "unknown" };
}
export function fingerprintBytes(value: string | Uint8Array): AuditFingerprint {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new AuditTraceError("invalid_trace_event");
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Object.freeze({ bytes: bytes.byteLength, sha256: digest(bytes) });
}
/** Canonical JSON digest: rejects coercions, accessors, cycles and non-JSON data. */
export function fingerprintJson(value: unknown): AuditFingerprint {
  const ancestors = new Set<object>(); let nodes = 0;
  const normalize = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64) throw new AuditTraceError("invalid_trace_event");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item || ancestors.has(item)) throw new AuditTraceError("invalid_trace_event");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).length !== item.length + 1 || Object.keys(item).length !== item.length
            || Object.keys(item).some((key, index) => key !== String(index)
              || typeof Object.getOwnPropertyDescriptor(item, key)?.get === "function")) throw new AuditTraceError("invalid_trace_event");
        return Array.from(item, child => normalize(child, depth + 1));
      }
      if (!object(item)) throw new AuditTraceError("invalid_trace_event");
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(item).sort((a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b))))) {
        if (typeof key !== "string" || typeof Object.getOwnPropertyDescriptor(item, key)?.get === "function") throw new AuditTraceError("invalid_trace_event");
        result[key] = normalize(item[key], depth + 1);
      }
      return result;
    } finally { ancestors.delete(item); }
  };
  return fingerprintBytes(JSON.stringify(normalize(value, 0)));
}

export function createAuditTrace(options: AuditTraceOptions): AuditTrace {
  let fd: number | undefined;
  try {
    if (!object(options)) throw new Error();
    only(options, ["path", "binding", "maxEvents", "maxBytes"]);
    if (!object(options.binding)) throw new Error();
    only(options.binding, ["taskId", "requestId", "actionId", "ownerEpoch", "ticketId"]);
    if (![options.binding.taskId, options.binding.requestId, options.binding.actionId, options.binding.ownerEpoch].every(id)
        || (Object.hasOwn(options.binding, "ticketId") && !id(options.binding.ticketId))) throw new Error();
    if (typeof options.path !== "string" || !isAbsolute(options.path) || resolve(options.path) !== options.path || /[\x00-\x1f\x7f]/.test(options.path)) throw new Error();
    const parent = dirname(options.path), metadata = lstatSync(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(parent) !== parent
        || (metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())) throw new Error();
    const maxEvents = options.maxEvents ?? 10_000, maxBytes = options.maxBytes ?? 16_777_216;
    if (!natural(maxEvents, 1_000_000) || maxEvents < 2 || !natural(maxBytes, 1_073_741_824) || maxBytes < 1024) throw new Error();
    fd = openSync(options.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    const identity = fstatSync(fd);
    const binding = Object.freeze({ ...options.binding });
    const active = new Map<string, { event: AuditOperationStart; start: number }>();
    const usedIds = new Set<string>();
    let failed = false, closed = false, terminal = false, sequence = 0, written = 0;
    const fail = (code: AuditTraceError["code"]): never => {
      failed = true;
      if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; }
      throw new AuditTraceError(code);
    };
    const assertFile = () => {
      if (fd === undefined) throw new Error();
      const current = lstatSync(options.path), opened = fstatSync(fd);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
          || current.nlink !== 1 || opened.nlink !== 1 || current.size !== written || opened.size !== written
          || (current.mode & 0o777) !== 0o600) throw new Error();
    };
    const persist = (event: Record<string, unknown>): void => {
      if (failed) throw new AuditTraceError("trace_persistence_failed");
      if (closed || fd === undefined) throw new AuditTraceError("trace_closed");
      try {
        assertFile();
        const line = Buffer.from(JSON.stringify({ version: 1, sequence: sequence + 1, at: new Date().toISOString(), binding, ...event }) + "\n");
        if (sequence >= maxEvents || written + line.length > maxBytes || line.length > 65_536) throw new Error();
        let offset = 0;
        while (offset < line.length) {
          const count = writeSync(fd, line, offset, line.length - offset);
          if (count < 1) throw new Error();
          offset += count;
        }
        fsyncSync(fd);
        sequence++; written += line.length;
      } catch { fail("trace_persistence_failed"); }
    };
    persist({ kind: "run_start" });
    try {
      const directoryFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch { fail("trace_persistence_failed"); }
    return {
      get failed() { return failed; },
      get binding() { return binding; },
      append(event: AuditTraceEvent): void {
        if (failed) throw new AuditTraceError("trace_persistence_failed");
        if (closed || terminal) return fail("trace_closed");
        try {
          if (!object(event)) throw new AuditTraceError("invalid_trace_event");
          if (event.kind === "terminal") {
            only(event, ["kind", "status", "iteration", "phase", "modelState", "errorCode", "trustedChangedFileCount", "diagnostic"]);
            context(event);
            if (Object.hasOwn(event,"diagnostic") && !readRuntimeDiagnostic(event.diagnostic)) throw new AuditTraceError("invalid_trace_event");
            if (!terminalStatuses.has(event.status as string) || (event.status === "finished" && active.size)) throw new AuditTraceError("invalid_trace_event");
          } else if (event.kind === "model" || event.kind === "tool") {
            if (!id(event.operationId)) throw new AuditTraceError("invalid_trace_event");
            if (event.stage === "start") {
              only(event, ["kind", "stage", "operationId", "parentOperationId", "iteration", "phase", "modelState", "toolName", "input", "arguments", "command"]);
              context(event);
              if (usedIds.has(event.operationId as string) || (event.kind === "tool" ? !toolNames.has(event.toolName as string) : Object.hasOwn(event, "toolName"))
                  || (Object.hasOwn(event, "parentOperationId") && (!id(event.parentOperationId) || !active.has(event.parentOperationId as string)))) throw new AuditTraceError("invalid_trace_event");
              for (const key of ["input", "arguments", "command"]) if (Object.hasOwn(event, key)) fingerprint(event[key]);
            } else {
              only(event, ["kind", "stage", "operationId", "output", "stdout", "stderr", "exitCode", "timedOut", "errorCode", "trustedChangedFileCount", "httpStatus", "responseRejection"]);
              const start = active.get(event.operationId as string);
              if (!["result", "error", "cancel"].includes(event.stage as string) || !start || start.event.kind !== event.kind
                  || (["error", "cancel"].includes(event.stage as string) && !Object.hasOwn(event, "errorCode"))) throw new AuditTraceError("invalid_trace_event");
              if (Object.hasOwn(event, "responseRejection")) {
                if (event.kind !== "model" || event.stage !== "error" || event.errorCode !== "unsupported_provider_response") throw new AuditTraceError("invalid_trace_event");
                responseRejection(event.responseRejection);
              }
              for (const key of ["output", "stdout", "stderr"]) if (Object.hasOwn(event, key)) fingerprint(event[key]);
              if (Object.hasOwn(event, "exitCode") && event.exitCode !== null && (!Number.isSafeInteger(event.exitCode) || (event.exitCode as number) < -2147483648 || (event.exitCode as number) > 2147483647)) throw new AuditTraceError("invalid_trace_event");
              if (Object.hasOwn(event, "timedOut") && typeof event.timedOut !== "boolean") throw new AuditTraceError("invalid_trace_event");
              if (Object.hasOwn(event, "httpStatus") && (!natural(event.httpStatus, 599) || (event.httpStatus as number) < 100)) throw new AuditTraceError("invalid_trace_event");
            }
          } else throw new AuditTraceError("invalid_trace_event");
          if (Object.hasOwn(event, "errorCode") && !(errorCodes as readonly unknown[]).includes(event.errorCode)) throw new AuditTraceError("invalid_trace_event");
          if (Object.hasOwn(event, "trustedChangedFileCount") && !natural(event.trustedChangedFileCount, 1_000_000)) throw new AuditTraceError("invalid_trace_event");
          // Freeze detached values before persisting or retaining them as context.
          const snapshot = JSON.parse(JSON.stringify(event)) as AuditTraceEvent;
          if (snapshot.kind === "terminal") {
            persist({ ...snapshot, pendingOperationIds: [...active.keys()] }); terminal = true;
          } else if (snapshot.stage === "start") {
            persist({ ...snapshot });
            active.set(snapshot.operationId, { event: snapshot, start: performance.now() }); usedIds.add(snapshot.operationId);
          } else {
            const started = active.get(snapshot.operationId)!;
            persist({ ...started.event, ...snapshot, durationMs: Math.max(0, Math.round((performance.now() - started.start) * 1000) / 1000) });
            active.delete(snapshot.operationId);
          }
        } catch (error) {
          if (failed) throw error;
          fail(error instanceof AuditTraceError ? error.code : "invalid_trace_event");
        }
      },
      close(): void {
        if (failed) throw new AuditTraceError("trace_persistence_failed");
        if (closed) return;
        if (!terminal) return fail("terminal_event_required");
        try { assertFile(); fsyncSync(fd!); closeSync(fd!); fd = undefined; closed = true; }
        catch { fail("trace_persistence_failed"); }
      },
    };
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    throw new AuditTraceError(error instanceof AuditTraceError && error.code === "trace_persistence_failed" ? error.code : "invalid_trace_options");
  }
}
