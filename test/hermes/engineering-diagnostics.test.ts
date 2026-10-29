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

test('native error details preserve ordinal and result identity without retaining arbitrary tool content', () => {
  const item = { toolOrdinal: 3, toolName: 'patch', phase: 'native_result' as const,
    category: 'native_reported_error' as const, resultHash: 'a'.repeat(64) };
  const report = { outcome: 'iteration_limit' as const, modelRequests: 3, toolCalls: 7,
    toolFailures: 0, toolBlocks: 0, toolResultErrors: 1, toolErrorDetails: [item], toolErrorDetailsTruncated: false };
  expect(parseEngineeringWorkerReported(report)).toEqual(report);
  const parsed = parseEngineeringWorkerReported(report);
  item.resultHash = 'b'.repeat(64);
  expect(parsed.toolErrorDetails![0]!.resultHash).toBe('a'.repeat(64));
  for (const patch of [{ error: 'private secret' }, { arguments: '/private/path' }, { toolName: 'secret-tool-name' },
    { phase: 'private' }, { category: 'raw error' }, { resultHash: 'b'.repeat(64) + '\nsecret' },
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(suffix => ({ resultHash: 'b'.repeat(64) + suffix })),
    { toolOrdinal: 0 }, { toolOrdinal: 8 }, { toolOrdinal: 1.1 }]) {
    expect(() => parseEngineeringWorkerReported({ ...report, toolErrorDetails: [{ ...item, ...patch }] })).toThrow('result_diagnostics');
  }
  for (const patch of [{ toolResultErrors: 0 }, { toolErrorDetailsTruncated: true }, { toolErrorDetailsTruncated: undefined },
    { toolErrorDetails: undefined }, { toolErrorDetails: [] }, { toolResultErrors: 8 }]) {
    expect(() => parseEngineeringWorkerReported({ ...report, ...patch })).toThrow('result_diagnostics');
  }
  const { toolErrorDetailsTruncated: _unused, ...missingPair } = report;
  expect(() => parseEngineeringWorkerReported(missingPair)).toThrow('result_diagnostics');
});

test('bounded error detail overflow survives private journal roundtrip within its existing byte limit', () => {
  const details = Array.from({ length: 6 }, (_, i) => ({ toolOrdinal: i + 1, toolName: 'session_search',
    phase: 'native_result' as const, category: 'native_reported_error' as const, resultHash: 'f'.repeat(64) }));
  const report = { outcome: 'iteration_limit' as const, modelRequests: 2048, toolCalls: 2048,
    toolFailures: 2048, toolBlocks: 2048, toolResultErrors: 2048, toolErrorDetails: details, toolErrorDetailsTruncated: true };
  const diagnostic = { version: 1 as const, event: 'native_result' as const, phase: 'native_turn' as const, code: 'none',
    hostObserved: { modelRequestsReceived: 2048, toolBegins: 2048, toolEnds: 2048, toolFailures: 2048, environmentOperations: 2048 },
    hostCommand: { ordinal: 2048, exitCode: -2147483647 }, workerReported: report };
  const db = new Database(':memory:');
  try {
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(2048);
    createEngineeringDiagnosticJournal(db, binding)(diagnostic);
    expect(readEngineeringDiagnostics(db, binding)).toEqual([diagnostic]);
    expect(readEngineeringDiagnostics(db, { ...binding, sessionId: 'other' })).toEqual([]);
    for (const replacement of [details.slice(0, 5), [...details, { ...details[0]!, toolOrdinal: 7 }],
      [{ ...details[0]!, toolOrdinal: 2 }, ...details.slice(1)]]) {
      expect(() => parseEngineeringWorkerReported({ ...report, toolErrorDetails: replacement })).toThrow('result_diagnostics');
    }
  } finally { db.close(); }
});

test('maximum redacted worker cause chain fits the existing journal cap and rejects extra text',()=>{
 const db=new Database(':memory:'),write=createEngineeringDiagnosticJournal(db,binding);
 const workerFault={version:1 as const,lifecycle:{state:'closing' as const,reason:'environment_close' as const,initiator:'close' as const,atMs:1791839027750,operationCount:406},causes:Array.from({length:4},()=>({code:'process_observation_failed',frames:Array.from({length:4},()=>({file:'gary_engineering_environment.py',line:99999}))}))};
 const diagnostic={...engineeringFailure('native_turn',Error('engineering_worker:runtime_failed')),workerFault};
 write(diagnostic);expect(readEngineeringDiagnostics(db,binding)).toEqual([diagnostic]);
 expect(()=>write({...diagnostic,workerFault:{...workerFault,secret:'private'} as any})).toThrow('frame_shape');
 for (const lifecycle of [{...workerFault.lifecycle,reason:'private exception'}, {...workerFault.lifecycle,operationCount:-1}, {...workerFault.lifecycle,command:'secret'}, {...workerFault.lifecycle,atMs:Infinity}]) {
   expect(()=>write({...diagnostic,workerFault:{...workerFault,lifecycle} as any})).toThrow('frame_shape');
 }
 db.close();
});
