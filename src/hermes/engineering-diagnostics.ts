/** Bounded private diagnostics. Data here never grants authority or permits a retry. */
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { fingerprintJson } from './audit-trace.ts';

export const ENGINEERING_PHASES = ['prepare', 'host_execute', 'host_cleanup', 'host_finish', 'lease', 'model_setup',
  'dependencies', 'native_start', 'native_turn', 'native_close', 'primary_cleanup', 'artifact_capture',
  'verifier_acquire', 'verifier_import', 'verifier_snapshot', 'patch_capture', 'verifier_dependencies',
  'verifier_checks', 'verifier_cleanup', 'review', 'artifact_store', 'cleanup'] as const;
export type EngineeringPhase = typeof ENGINEERING_PHASES[number];
// Exact host codes only: never persist Error.message, stack, cause, or arbitrary suffixes.
const SAFE_ERRORS = new Set([
  'engineering_resource_binding_invalid',
  'engineering_resource_boot_observation_failed',
  'engineering_resource_boot_identity_changed',
  'engineering_resource_lock_identity_changed',
  'engineering_resource_invalid_pin',
  'engineering_resource_invalid_requirements',
  'engineering_resource_invalid_binding',
  'engineering_resource_invalid_python',
  'engineering_resource_holder_timeout',
  'engineering_resource_busy',
  'engineering_resource_cancelled',
  'engineering_resource_control_lost',
  'engineering_resource_holder_failed',
  'engineering_resource_holder_lost',
  'engineering_resource_holder_output_invalid',
  'engineering_resource_holder_binding',
  'engineering_resource_holder_protocol',
  'engineering_resource_parent_disconnected',
  'engineering_resource_control_invalid',
  'engineering_resource_not_held',
  'engineering_resource_cleanup_unconfirmed',
  'engineering_resource_headroom_unavailable',
  'engineering_binding_mismatch',
  'engineering_cache_prepare_failed',
  'engineering_cleanup_uncertain',
  'engineering_command_limit',
  'engineering_daemon_changed',
  'engineering_empty_argv',
  'engineering_guardian_receipt_mismatch',
  'engineering_guardian_required',
  'engineering_guardian_stopped',
  'engineering_independent_git_required',
  'engineering_invalid_binding',
  'engineering_invalid_cache_volume',
  'engineering_invalid_command',
  'engineering_invalid_docker_binary',
  'engineering_invalid_docker_socket',
  'engineering_invalid_limit',
  'engineering_invalid_operation_id',
  'engineering_invalid_resources',
  'engineering_invalid_stdin',
  'engineering_invalid_workspace',
  'engineering_pinned_image_required',
  'engineering_process_limit',
  'engineering_reconciliation_required',
  'engineering_runner_output_limit',
  'engineering_session_replaced',
  'engineering_session_start_failed',
  'engineering_unknown_operation',
  'engineering_unknown_process',

  'engineering_host:invalid_artifact',
  'engineering_host:invalid_receipt',
  'engineering_host:prepared_binding',
  'engineering_host:receipt_immutable',
  'engineering_host:request_missing',
  'engineering_host:start_receipt',
  'engineering_host:stopped',
  'engineering_host:task_missing',
  'engineering_host:unavailable',
  'engineering_execution:artifact_changed',
  'engineering_execution:binding',
  'engineering_execution:cleanup_unknown',
  'engineering_execution:command_incomplete',
  'engineering_execution:command_output_limit',
  'engineering_execution:execution_already_consumed',
  'engineering_execution:offline_dependencies_unavailable',
  'engineering_execution:patch_capture',
  'engineering_execution:patch_missing',
  'engineering_execution:process_missing',
  'engineering_execution:review_rejected',
  'engineering_execution:review_unavailable',
  'engineering_execution:scope_changed',
  'engineering_execution:snapshot_failed',
  'engineering_execution:unsupported_operation',
  'engineering_execution:verification_failed',
  'engineering_execution:verifier_cleanup_unknown',
  'engineering_execution:verifier_dependencies_unavailable',
  'engineering_worker:binding',
  'engineering_worker:cleanup_unknown',
  'engineering_worker:close_not_available',
  'engineering_worker:close_receipt',
  'engineering_worker:configuration',
  'engineering_worker:container_absence_unknown',
  'engineering_worker:container_creation_unknown',
  'engineering_worker:container_identity_unknown',
  'engineering_worker:container_owner_changed',
  'engineering_worker:container_removal_failed',
  'engineering_worker:daemon_changed',
  'engineering_worker:docker_configuration',
  'engineering_worker:docker_failed',
  'engineering_worker:exit_failed',
  'engineering_worker:expired',
  'engineering_worker:frame_limit',
  'engineering_worker:frame_shape',
  'engineering_worker:guardian_command_start_forbidden',
  'engineering_worker:guardian_missing',
  'engineering_worker:guardian_receipt_mismatch',
  'engineering_worker:image_unverified',
  'engineering_worker:launch_failed',
  'engineering_worker:model_during_close',
  'engineering_worker:native_schema_changed',
  'engineering_worker:partial_frame',
  'engineering_worker:request_shape',
  'engineering_worker:runtime_failed',
  'engineering_worker:result_binding',
  'engineering_worker:rpc_rejected',
  'engineering_worker:snapshot_directory',
  'engineering_worker:source_changed',
  'engineering_worker:source_identity',
  'engineering_worker:source_path',
  'engineering_worker:spawn_failed',
  'engineering_worker:startup_failed',
  'engineering_worker:tool_result',
  'engineering_worker:trailing_frame',
  'engineering_worker:turn_failed',
  'engineering_worker:turn_not_available',
  'engineering_worker:unbound_creation',
  'engineering_worker:unexpected_exit',
  'engineering_worker:write_failed',
  'engineering_artifact:artifact_changed',
  'engineering_artifact:byte_limit',
  'engineering_artifact:capture_hash',
  'engineering_artifact:capture_provenance',
  'engineering_artifact:duplicate_path',
  'engineering_artifact:file_changed',
  'engineering_artifact:file_count',
  'engineering_artifact:file_scope',
  'engineering_artifact:git_config',
  'engineering_artifact:git_metadata_limit',
  'engineering_artifact:missing_file',
  'engineering_artifact:parent_changed',
  'engineering_artifact:path_collision',
  'engineering_artifact:root_changed',
  'engineering_artifact:shared_git_metadata',
  'engineering_artifact:unsafe_directory',
  'engineering_artifact:unsafe_file',
  'engineering_artifact:unsafe_path',
  'engineering_artifact:unsafe_root',
  'engineering_artifact:unsupported_host',
  'engineering_artifact:verifier_reuse',
  'engineering_artifact:write_failed',
  'engineering_model:allocation_binding',
  'engineering_model:concurrent_or_inactive_turn',
  'engineering_model:concurrent_request',
  'engineering_model:configuration',
  'engineering_model:history_changed',
  'engineering_model:inactive',
  'engineering_model:journal_not_durable',
  'engineering_model:ledger_binding',
  'engineering_model:ledger_history',
  'engineering_model:owner_already_claimed',
  'engineering_model:owner_changed',
  'engineering_model:physical_request_replay',
  'engineering_model:receipt_persistence',
  'engineering_model:receipt_unresolved',
  'engineering_model:request_binding',
  'engineering_model:request_failed',
  'engineering_model:reservation_binding',
  'engineering_model:response_binding',
  'engineering_model:review_not_ready',
  'engineering_model:tool_call_replay',
  'engineering_model:tool_result_binding',
  'engineering_model:tool_result_changed',
  'engineering_model:tool_results_missing',
  'engineering_model:tool_schema',
  'engineering_model:transport_failed',
  'engineering_model:turn_not_ready',
  'engineering_model:turn_without_model_result',
  'engineering_protocol:binding_or_sequence',
  'engineering_protocol:cleanup_unknown',
  'engineering_protocol:closed',
  'engineering_protocol:configuration',
  'engineering_protocol:duplicate_process',
  'engineering_protocol:effective_arguments',
  'engineering_protocol:frame_too_large',
  'engineering_protocol:identity',
  'engineering_protocol:inactive',
  'engineering_protocol:invalid_executor_result',
  'engineering_protocol:kind',
  'engineering_protocol:observed_call',
  'engineering_protocol:operation',
  'engineering_protocol:operation_replay_or_limit',
  'engineering_protocol:operation_uncertain',
  'engineering_protocol:receipt_persistence_failed',
  'engineering_protocol:shape',
  'engineering_protocol:tool_admission',
  'engineering_protocol:tool_result_binding',
  'engineering_protocol:tool_presentation_binding',
  'engineering_protocol:turn_incomplete',
  'engineering_protocol:turn_replay',
  'engineering_protocol:unknown_process',
  'engineering_protocol:unobserved_or_replayed_call',
  'engineering_repository:acquisition',
  'engineering_repository:acquisition_failed',
  'engineering_repository:app_binding',
  'engineering_repository:audience_grant',
  'engineering_repository:authentication_channel',
  'engineering_repository:base_changed',
  'engineering_repository:credential_binding',
  'engineering_repository:credential_permissions_changed',
  'engineering_repository:credential_unavailable',
  'engineering_repository:credential_url',
  'engineering_repository:deadline',
  'engineering_repository:git_binary',
  'engineering_repository:git_config',
  'engineering_repository:git_metadata_limit',
  'engineering_repository:github_app_required',
  'engineering_repository:installation_authority',
  'engineering_repository:installation_changed',
  'engineering_repository:installation_unavailable',
  'engineering_repository:repository',
  'engineering_repository:repository_authority_changed',
  'engineering_repository:repository_page',
  'engineering_repository:repository_pagination',
  'engineering_repository:repository_response_limit',
  'engineering_repository:repository_snapshot',
  'engineering_repository:shared_git_metadata',
  'engineering_repository:stale_snapshot',
  'engineering_repository:standalone_git',
  'engineering_repository:untrusted_resolution',
  'engineering_repository:workspace',
  'engineering_worker:result_diagnostics',
]);
export interface EngineeringToolErrorDetail {
  toolOrdinal: number;
  toolName: string;
  phase: 'native_result';
  category: 'native_reported_error';
  resultHash: string;
}
export interface EngineeringWorkerReported {
  outcome: 'completed' | 'iteration_limit' | 'incomplete';
  modelRequests: number; toolCalls: number; toolFailures: number; toolBlocks: number; toolResultErrors: number;
  /** Worker observations only; no result bodies, arguments or authority. Old reports remain readable. */
  toolErrorDetails?: readonly EngineeringToolErrorDetail[];
  toolErrorDetailsTruncated?: boolean;
}
export interface EngineeringHostObserved {
  modelRequestsReceived: number; toolBegins: number; toolEnds: number; toolFailures: number; environmentOperations: number;
}
export interface EngineeringDiagnostic {
  version: 1; event: 'failure' | 'native_result'; phase: EngineeringPhase; code: string;
  hostObserved?: EngineeringHostObserved; workerReported?: EngineeringWorkerReported;
  workerFault?: EngineeringWorkerFault;
  hostCommand?: { ordinal: number; exitCode: number | null };
}
export interface EngineeringDiagnosticBinding { taskId: string; requestId: string; sessionId: string | null; ownerEpoch: string | null }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 2048;
const NATIVE_DIAGNOSTIC_TOOLS = new Set(['terminal', 'read_file', 'write_file', 'patch', 'search_files',
  'process', 'todo', 'memory', 'session_search', 'skills_list', 'skill_view', 'skill_manage', 'delegate_task', 'execute_code']);
export function parseEngineeringWorkerReported(v: unknown): EngineeringWorkerReported {
  const fields = ['outcome','modelRequests','toolCalls','toolFailures','toolBlocks','toolResultErrors'];
  const detailed = object(v) && (Object.hasOwn(v, 'toolErrorDetails') || Object.hasOwn(v, 'toolErrorDetailsTruncated'));
  if (!object(v) || !exact(v, detailed ? [...fields, 'toolErrorDetails', 'toolErrorDetailsTruncated'] : fields)
      || !['completed','iteration_limit','incomplete'].includes(String(v.outcome))
      || !['modelRequests','toolCalls','toolFailures','toolBlocks','toolResultErrors'].every(k => count(v[k]))) throw Error('engineering_worker:result_diagnostics');
  if (detailed) {
    const details = v.toolErrorDetails;
    if (!Array.isArray(details) || details.length !== Math.min(v.toolResultErrors as number, 6)
        || v.toolErrorDetailsTruncated !== ((v.toolResultErrors as number) > 6)
        || (v.toolResultErrors as number) > (v.toolCalls as number)) throw Error('engineering_worker:result_diagnostics');
    let previousOrdinal = 0;
    for (const item of details) {
      if (!object(item) || !exact(item, ['toolOrdinal','toolName','phase','category','resultHash'])
          || !count(item.toolOrdinal) || (item.toolOrdinal as number) <= previousOrdinal
          || (item.toolOrdinal as number) > (v.toolCalls as number)
          || typeof item.toolName !== 'string' || !NATIVE_DIAGNOSTIC_TOOLS.has(item.toolName)
          || item.phase !== 'native_result' || item.category !== 'native_reported_error'
          || typeof item.resultHash !== 'string' || item.resultHash.length !== 64
          || !/^[a-f0-9]{64}$/.test(item.resultHash)) throw Error('engineering_worker:result_diagnostics');
      previousOrdinal = item.toolOrdinal as number;
    }
  }
  return structuredClone(v) as unknown as EngineeringWorkerReported;
}
export interface EngineeringWorkerFault { version: 1; lifecycle?: { state: 'closing' | 'fenced'; reason: 'environment_close' | 'process_cancel' | 'backend_fault'; initiator: 'close' | 'cancel' | 'pump' | 'operation' | 'registry'; atMs: number; operationCount: number }; causes: readonly { code: string; frames: readonly {file: string; line: number}[] }[] }
const WORKER_FAULT_CODES = new Set(["child_delegation_denied", "cleanup_unconfirmed", "close_during_native_tool", "code_cleanup_unconfirmed", "code_process_cleanup_unconfirmed", "code_requires_isolated_native_worker", "concurrent_environment_execution", "cross_profile_denied", "cross_profile_session_lookup_denied", "environment_closed", "environment_closing", "polling_cleanup_unconfirmed", "environment_fenced", "environment_operation_limit", "environment_operation_rejected", "expired_tool_admission", "foreign_native_module", "frame_limit", "host_rejected", "host_reply_limit", "host_system_prompt_changed", "incomplete_process_output", "inherited_call_limit", "inherited_process_mode_denied", "invalid_code_authorization", "invalid_command", "invalid_command_timeout", "invalid_deadline", "invalid_delegation_depth", "invalid_engineering_binding", "invalid_engineering_start", "invalid_host_system_prompt", "invalid_model_limits", "invalid_native_context", "invalid_native_context_tools", "invalid_native_history", "invalid_native_source", "invalid_native_tool_call", "invalid_process_start", "invalid_process_status", "invalid_result_presentation", "invalid_scoped_directory", "invalid_scoped_home", "invalid_scoped_session_path", "invalid_stdin", "invalid_task_operation", "invalid_task_result", "invalid_turn_frame", "local_process_denied", "missing_guarded_model_client_or_profile", "missing_process_exit_code", "missing_scoped_directory", "missing_scoped_session_db", "model_request_limit", "model_response_shape", "model_route_denied", "native_agent_session_mismatch", "native_batch_history_changed", "native_batch_overlap", "native_batch_result_mismatch", "native_call_identity_changed", "native_call_identity_replayed", "native_dotenv_present", "native_environment_collision", "native_file_cwd_unbound", "native_handler_changed", "native_identity_mismatch", "native_pin_mismatch", "native_presentation_limit", "native_process_action_not_implemented", "native_process_feature_not_implemented", "native_profile_changed", "native_profile_not_installed", "native_registry_mismatch", "native_result_count_invalid", "native_result_history_missing", "native_result_limit", "native_scope_mismatch", "parallel_native_tool_denied", "process_deadline_exceeded", "process_identity_mismatch", "process_observation_failed", "process_output_limit", "scoped_config_symlink", "scoped_directory_contains_symlink", "scoped_home_symlink", "scoped_memory_identity_changed", "scoped_session_checkpoint_busy", "scoped_session_checkpoint_incomplete", "scoped_session_identity_changed", "session_closed", "session_deadline", "session_fenced", "skill_roots_overlap", "stdio_frame_limit", "stdio_reply_mismatch", "stdio_transport_fenced", "tool_arguments_changed", "tool_arguments_limit", "tool_limit", "tool_not_allowed_or_replayed", "turn_replay_or_limit", "unapproved_native_tool", "unbound_background_start", "unbound_code_invocation", "unbound_environment_operation", "unbound_inherited_call", "unbound_native_environment", "unbound_task_operation", "unknown_environment_operation", "unknown_failure", "unknown_native_capability"]);
const WORKER_FAULT_FILES = new Set(['gary_engineering_runtime.py','gary_engineering_environment.py','gary_runtime.py','tool_executor.py','terminal_tool.py','conversation_loop.py']);
export function parseEngineeringWorkerFault(v: unknown): EngineeringWorkerFault {
  const bad = () => { throw Error('engineering_worker:frame_shape'); };
  if (!object(v) || Object.keys(v).some(k => !['version','causes','lifecycle'].includes(k)) || v.version !== 1 || !Array.isArray(v.causes) || v.causes.length < 1 || v.causes.length > 4) return bad();
  if (v.lifecycle !== undefined) {
    const l = v.lifecycle;
    if (!object(l) || !exact(l,['state','reason','initiator','atMs','operationCount'])
        || !['closing','fenced'].includes(String(l.state))
        || !['environment_close','process_cancel','backend_fault'].includes(String(l.reason))
        || !['close','cancel','pump','operation','registry'].includes(String(l.initiator))
        || !Number.isSafeInteger(l.atMs) || Number(l.atMs) < 1 || !count(l.operationCount)) return bad();
  }
  for (const c of v.causes) {
    if (!object(c) || !exact(c,['code','frames']) || !WORKER_FAULT_CODES.has(String(c.code)) || !Array.isArray(c.frames) || c.frames.length > 4) return bad();
    for (const f of c.frames) if (!object(f) || !exact(f,['file','line']) || !WORKER_FAULT_FILES.has(String(f.file)) || !Number.isSafeInteger(f.line) || Number(f.line) < 1 || Number(f.line) > 100000) return bad();
  }
  return structuredClone(v) as unknown as EngineeringWorkerFault;
}
export function engineeringFailure(phase: EngineeringPhase, error: unknown): EngineeringDiagnostic {
  const message = error instanceof Error ? error.message : '';
  return { version: 1, event: 'failure', phase, code: SAFE_ERRORS.has(message) ? message
    : error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'unknown_failure' };
}
function validate(v: unknown): asserts v is EngineeringDiagnostic {
  if (!object(v) || Object.keys(v).some(k => !['version','event','phase','code','hostObserved','workerReported','hostCommand','workerFault'].includes(k))
      || v.version !== 1 || !ENGINEERING_PHASES.includes(v.phase as EngineeringPhase)
      || !['failure','native_result'].includes(String(v.event))
      || !(v.event === 'native_result' ? v.code === 'none' : ['unknown_failure','aborted'].includes(String(v.code)) || SAFE_ERRORS.has(String(v.code)))) throw Error('engineering_diagnostics:shape');
  if (v.workerFault !== undefined) parseEngineeringWorkerFault(v.workerFault);
  if (v.workerReported !== undefined) parseEngineeringWorkerReported(v.workerReported);
  if (v.hostObserved !== undefined && (!object(v.hostObserved)
      || !exact(v.hostObserved, ['modelRequestsReceived','toolBegins','toolEnds','toolFailures','environmentOperations'])
      || !Object.values(v.hostObserved).every(count))) throw Error('engineering_diagnostics:shape');
  if (v.hostCommand !== undefined && (!object(v.hostCommand) || !exact(v.hostCommand, ['ordinal','exitCode'])
      || !count(v.hostCommand.ordinal) || !(v.hostCommand.exitCode === null || Number.isSafeInteger(v.hostCommand.exitCode)
        && Math.abs(v.hostCommand.exitCode as number) <= 2147483647))) throw Error('engineering_diagnostics:shape');
}
function parameters(binding: EngineeringDiagnosticBinding) {
  for (const value of [binding.taskId, binding.requestId]) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) throw Error('engineering_diagnostics:binding');
  for (const value of [binding.sessionId, binding.ownerEpoch]) if (value !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) throw Error('engineering_diagnostics:binding');
  return [binding.taskId, binding.requestId, binding.sessionId, binding.ownerEpoch] as const;
}
export function createEngineeringDiagnosticJournal(db: Database, binding: EngineeringDiagnosticBinding) {
  const params = parameters(binding);
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_diagnostics_v1 (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT, owner_epoch TEXT,
    payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL);`);
  return (value: EngineeringDiagnostic): void => {
    validate(value); const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > 2048) throw Error('engineering_diagnostics:limit');
    db.transaction(() => {
      const n = db.query<{ n: number }, [string]>('SELECT count(*) n FROM engineering_diagnostics_v1 WHERE task_id=?').get(binding.taskId)!.n;
      if (n >= 64) throw Error('engineering_diagnostics:limit');
      db.query('INSERT INTO engineering_diagnostics_v1 VALUES(?,?,?,?,?,?,?)').run(randomUUID(), ...params, payload, fingerprintJson(value).sha256);
    }).immediate();
  };
}
/** Exact-binding read only, usable with a read-only SQLite connection after restart. */
export function readEngineeringDiagnostics(db: Database, binding: EngineeringDiagnosticBinding): readonly EngineeringDiagnostic[] {
  const rows = db.query<{ payload_json: string; payload_sha256: string }, [string,string,string|null,string|null]>(
    'SELECT payload_json,payload_sha256 FROM engineering_diagnostics_v1 WHERE task_id=? AND request_id=? AND session_id IS ? AND owner_epoch IS ? ORDER BY rowid LIMIT 65').all(...parameters(binding));
  if (rows.length > 64) throw Error('engineering_diagnostics:limit');
  return rows.map(row => {
    if (Buffer.byteLength(row.payload_json) > 2048) throw Error('engineering_diagnostics:limit');
    const value: unknown = JSON.parse(row.payload_json); validate(value);
    if (fingerprintJson(value).sha256 !== row.payload_sha256) throw Error('engineering_diagnostics:digest');
    return value;
  });
}
