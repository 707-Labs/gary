/** Diagnostic metadata only: no code here grants execution or publication authority. */
import { DeadlineExceededError } from "../deadline.ts";
export const RUNTIME_DIAGNOSTICS = {
  "worker": {
    "codes": [
      "concurrent_task_denied",
      "deadline_exceeded",
      "diagnostic_rejected",
      "duplicate_live_tool_call_id",
      "endpoint_origin_mismatch",
      "executor_state_invalidated",
      "history_contains_capability",
      "history_duplicate_tool_id",
      "history_pending_tool_calls",
      "history_too_large",
      "history_tool_receipt_mismatch",
      "invalid_capability",
      "invalid_deadline",
      "invalid_endpoint",
      "invalid_history",
      "invalid_history_content",
      "invalid_history_fields",
      "invalid_history_message",
      "invalid_history_reasoning",
      "invalid_history_tool_arguments",
      "invalid_history_tool_call",
      "invalid_history_tool_calls",
      "invalid_history_tool_id",
      "invalid_history_tool_name",
      "invalid_identity",
      "invalid_input_json",
      "invalid_long_test_policy",
      "invalid_maxIterations",
      "invalid_maxTokens",
      "invalid_model",
      "invalid_model_history_response",
      "invalid_native_result",
      "invalid_native_source",
      "invalid_payload",
      "invalid_prompt",
      "invalid_rpc_response",
      "invalid_state_receipt",
      "invalid_stdio_frame",
      "invalid_stdio_request",
      "invalid_stdio_response",
      "invalid_stdio_transport",
      "invalid_system_prompt",
      "invalid_temperature",
      "invalid_test_job",
      "invalid_tool_arguments",
      "invalid_tool_name",
      "invalid_tool_schema",
      "invalid_tools",
      "invalid_transport",
      "missing_original_tool_call_id",
      "model_attempt_limit",
      "model_authority_rejected",
      "model_output_cap_exceeded",
      "native_dotenv_present",
      "native_execution_failed",
      "native_pin_mismatch",
      "native_process_reuse_denied",
      "native_runtime_error",
      "native_toolset_mismatch",
      "registry_binding_mismatch",
      "registry_toolset_mismatch",
      "rpc_authority_rejected",
      "rpc_http_error",
      "rpc_redirect_denied",
      "rpc_transport_error",
      "stdio_closed",
      "stdio_endpoint_denied",
      "stdio_frame_too_large",
      "stdio_method_denied",
      "test_job_binding_rejected",
      "test_job_poll_limit",
      "test_job_receipt_rejected",
      "tool_receipt_mismatch",
      "unapproved_native_tool",
      "unexpected_native_iteration_cap",
      "unexpected_test_job",
      "unknown_native_failure",
      "unknown_runtime_fault",
      "unresolved_live_tool_calls",
      "unsupported_model_request",
      "untraced_live_tool_call"
    ],
    "stages": [
      "unknown",
      "input_validation",
      "native_init",
      "native_run",
      "model_request",
      "model_response",
      "tool_call",
      "state_read",
      "native_result",
      "stdio_write",
      "stdio_read",
      "stdio_response"
    ]
  },
  "launcher": {
    "codes": [
      "worker_protocol_or_lifetime_rejected",
      "worker_cleanup_failed"
    ],
    "stages": [
      "launch",
      "protocol",
      "response",
      "response_write",
      "result",
      "exit",
      "cleanup"
    ]
  },
  "phase": {
    "codes": [
      "concurrent_phase_model_requests",
      "empty_phase_history",
      "native_phase_history_invalid",
      "native_phase_history_mismatch",
      "native_phase_outcome_binding_rejected",
      "native_phase_terminal_not_verified",
      "phase_history_rewritten",
      "phase_iteration_limit",
      "phase_model_tools_denied",
      "phase_request_rejected",
      "phase_returned_with_pending_test",
      "phase_state_unavailable",
      "phase_test_job_history_mismatch",
      "phase_test_job_mismatch",
      "phase_test_job_pending",
      "phase_test_job_receipt_mismatch",
      "tool_call_history_mismatch"
    ],
    "stages": [
      "request",
      "result"
    ]
  },
  "host": {
    "codes": [
      "concurrent_model_requests_rejected",
      "model_body_or_deadline_rejected",
      "model_body_required",
      "model_body_too_large",
      "model_iteration_limit",
      "model_method_rejected",
      "model_run_limits_rejected",
      "runtime_launch_or_admission_failed",
      "native_outcome_binding_rejected",
      "shared_deadline_exceeded",
      "aborted",
      "production_runtime_failed"
    ],
    "stages": [
      "admission",
      "model_request",
      "launch",
      "result",
      "policy",
      "trace",
      "evidence",
      "integrations",
      "coordinator"
    ]
  }
} as const;
for (const rule of Object.values(RUNTIME_DIAGNOSTICS)) { Object.freeze(rule.codes); Object.freeze(rule.stages); Object.freeze(rule); }
Object.freeze(RUNTIME_DIAGNOSTICS);
export const DIAGNOSTIC_CATEGORIES = ['none','type_error','value_error','key_error','attribute_error','os_error','other_exception'] as const;
export type RuntimeDiagnosticOrigin = keyof typeof RUNTIME_DIAGNOSTICS;
export interface RuntimeDiagnostic {
  readonly origin: RuntimeDiagnosticOrigin;
  readonly code: typeof RUNTIME_DIAGNOSTICS[RuntimeDiagnosticOrigin]['codes'][number];
  readonly stage: typeof RUNTIME_DIAGNOSTICS[RuntimeDiagnosticOrigin]['stages'][number];
  readonly category: typeof DIAGNOSTIC_CATEGORIES[number];
}
/** Reject accessors, additional fields and arbitrary strings before copying. */
export function readRuntimeDiagnostic(value: unknown, expectedOrigin?: RuntimeDiagnosticOrigin): Readonly<RuntimeDiagnostic> | undefined {
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return;
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.length !== 4 || keys.some(key => typeof key !== 'string' || !['origin','code','stage','category'].includes(key)
      || !Object.hasOwn(descriptors[key]!, 'value'))) return;
  const {origin,code,stage,category} = value as Record<string,unknown>;
  if (typeof origin !== 'string' || !Object.hasOwn(RUNTIME_DIAGNOSTICS,origin) || (expectedOrigin && origin !== expectedOrigin)) return;
  const allowed = RUNTIME_DIAGNOSTICS[origin as RuntimeDiagnosticOrigin];
  if (!(allowed.codes as readonly unknown[]).includes(code) || !(allowed.stages as readonly unknown[]).includes(stage)
      || !(DIAGNOSTIC_CATEGORIES as readonly unknown[]).includes(category)) return;
  return Object.freeze({origin,code,stage,category}) as Readonly<RuntimeDiagnostic>;
}
export function runtimeDiagnostic(origin: RuntimeDiagnosticOrigin, code: string, stage: string): Readonly<RuntimeDiagnostic> {
  const value = readRuntimeDiagnostic({origin,code,stage,category:'none'});
  if (!value) throw new Error('invalid_runtime_diagnostic');
  return value;
}
/** Worker provenance is enforced at ingress. Legacy fixed reasons are diagnostic-only. */
export function workerDiagnostic(value: unknown, legacyReason?: unknown): Readonly<RuntimeDiagnostic> {
  if (value !== undefined) return readRuntimeDiagnostic(value,'worker') ?? runtimeDiagnostic('worker','diagnostic_rejected','unknown');
  const code = typeof legacyReason === 'string' && (RUNTIME_DIAGNOSTICS.worker.codes as readonly string[]).includes(legacyReason)
    ? legacyReason : 'unknown_native_failure';
  return runtimeDiagnostic('worker',code,'unknown');
}
/** Only this branded host exception carries diagnostics across the CODE boundary. */
export class RuntimeDiagnosticError extends Error {
  readonly diagnostic: Readonly<RuntimeDiagnostic>;
  constructor(message: string, diagnostic: RuntimeDiagnostic) {
    super(message); this.name='RuntimeDiagnosticError';
    const checked=readRuntimeDiagnostic(diagnostic);
    if (!checked) throw new Error('invalid_runtime_diagnostic');
    this.diagnostic=checked;
  }
}
export class RuntimeDiagnosticDeadlineError extends DeadlineExceededError {
  readonly diagnostic: Readonly<RuntimeDiagnostic>;
  constructor(diagnostic: RuntimeDiagnostic) {
    super();
    const checked=readRuntimeDiagnostic(diagnostic);
    if (!checked) throw new Error('invalid_runtime_diagnostic');
    this.diagnostic=checked;
  }
}
export function diagnosticFromError(error: unknown): Readonly<RuntimeDiagnostic> | undefined {
  return (error instanceof RuntimeDiagnosticError || error instanceof RuntimeDiagnosticDeadlineError) ? readRuntimeDiagnostic(error.diagnostic) : undefined;
}
