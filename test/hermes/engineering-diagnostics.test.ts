import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createEngineeringDiagnosticJournal, engineeringFailure, parseEngineeringWorkerReported, readEngineeringDiagnostics } from '../../src/hermes/engineering-diagnostics.ts';
const binding = { taskId: 'task', requestId: 'request', sessionId: 'session', ownerEpoch: 'owner' };
test('diagnostics permit only exact public error codes and bounded worker fields', () => {
  expect(engineeringFailure('native_start', Error('engineering_worker:docker_failed')).code).toBe('engineering_worker:docker_failed');
  expect(engineeringFailure('verifier_import', Error('engineering_artifact:git_config')).code).toBe('engineering_artifact:git_config');
  for (const suffix of [' secret', '\n', ':credential', '\u0000']) expect(engineeringFailure('verifier_import', Error('engineering_artifact:git_config' + suffix)).code).toBe('unknown_failure');
  for (const code of ['engineering_resource_binding_invalid', 'engineering_resource_boot_observation_failed',
    'engineering_resource_boot_identity_changed', 'engineering_resource_lock_identity_changed', 'engineering_resource_busy',
    'engineering_resource_headroom_unavailable', 'engineering_resource_holder_lost']) {
    expect(engineeringFailure('lease', Error(code)).code).toBe(code);
    for (const suffix of [' secret', '\n', ':credential', '\u0000']) expect(engineeringFailure('lease', Error(code + suffix)).code).toBe('unknown_failure');
  }
  const report = { outcome: 'incomplete' as const, modelRequests: 0, toolCalls: 0, toolFailures: 0, toolBlocks: 0, toolResultErrors: 0 };
  expect(parseEngineeringWorkerReported(report)).toEqual(report);
  for (const patch of [{ toolCalls: -1 }, { modelRequests: 2049 }, { toolFailures: 0.5 }, { prompt: 'private' }, { outcome: 'raw-body' }])
    expect(() => parseEngineeringWorkerReported({ ...report, ...patch })).toThrow('result_diagnostics');
});
test('journal caps durable records and validates immutable hashes on exact scoped reads', () => {
  const db = new Database(':memory:');
  try {
    const append = createEngineeringDiagnosticJournal(db, binding), diagnostic = engineeringFailure('native_turn', Error('private error'));
    expect(() => append({ ...diagnostic, prompt: 'private' } as any)).toThrow('shape');
    for (let i = 0; i < 64; i++) append(diagnostic);
    expect(() => append(diagnostic)).toThrow('limit');
    expect(readEngineeringDiagnostics(db, binding)).toHaveLength(64);
    expect(readEngineeringDiagnostics(db, { ...binding, requestId: 'foreign' })).toEqual([]);
    db.exec("UPDATE engineering_diagnostics_v1 SET payload_sha256='tampered' WHERE rowid=1");
    expect(() => readEngineeringDiagnostics(db, binding)).toThrow('digest');
  } finally { db.close(); }
});
