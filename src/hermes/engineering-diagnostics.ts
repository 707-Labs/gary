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
export interface EngineeringWorkerReported {
  outcome: 'completed' | 'iteration_limit' | 'incomplete';
  modelRequests: number; toolCalls: number; toolFailures: number; toolBlocks: number; toolResultErrors: number;
}
export interface EngineeringHostObserved {
  modelRequestsReceived: number; toolBegins: number; toolEnds: number; toolFailures: number; environmentOperations: number;
}
export interface EngineeringDiagnostic {
  version: 1; event: 'failure' | 'native_result'; phase: EngineeringPhase; code: string;
  hostObserved?: EngineeringHostObserved; workerReported?: EngineeringWorkerReported;
  hostCommand?: { ordinal: number; exitCode: number | null };
}
export interface EngineeringDiagnosticBinding { taskId: string; requestId: string; sessionId: string | null; ownerEpoch: string | null }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 2048;
export function parseEngineeringWorkerReported(v: unknown): EngineeringWorkerReported {
  if (!object(v) || !exact(v, ['outcome','modelRequests','toolCalls','toolFailures','toolBlocks','toolResultErrors'])
      || !['completed','iteration_limit','incomplete'].includes(String(v.outcome))
      || !['modelRequests','toolCalls','toolFailures','toolBlocks','toolResultErrors'].every(k => count(v[k]))) throw Error('engineering_worker:result_diagnostics');
  return structuredClone(v) as unknown as EngineeringWorkerReported;
}
export function engineeringFailure(phase: EngineeringPhase, error: unknown): EngineeringDiagnostic {
  const message = error instanceof Error ? error.message : '';
  return { version: 1, event: 'failure', phase, code: SAFE_ERRORS.has(message) ? message
    : error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'unknown_failure' };
}
function validate(v: unknown): asserts v is EngineeringDiagnostic {
  if (!object(v) || Object.keys(v).some(k => !['version','event','phase','code','hostObserved','workerReported','hostCommand'].includes(k))
      || v.version !== 1 || !ENGINEERING_PHASES.includes(v.phase as EngineeringPhase)
      || !['failure','native_result'].includes(String(v.event))
      || !(v.event === 'native_result' ? v.code === 'none' : ['unknown_failure','aborted'].includes(String(v.code)) || SAFE_ERRORS.has(String(v.code)))) throw Error('engineering_diagnostics:shape');
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
