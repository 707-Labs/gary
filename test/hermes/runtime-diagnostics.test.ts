
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../src/executors/process.ts';
import { RUNTIME_DIAGNOSTICS, readRuntimeDiagnostic, runtimeDiagnostic, workerDiagnostic, RuntimeDiagnosticError, diagnosticFromError } from '../../src/hermes/runtime-diagnostics.ts';

test('schema is exact, inert, immutable and rejects unknown data without invoking accessors', () => {
  const good=runtimeDiagnostic('worker','invalid_model_history_response','model_response');
  expect(Object.isFrozen(good)).toBe(true);
  let reads=0;
  for(const bad of [{...good,raw:'SECRET'}, {...good,code:'SECRET'}, {...good,stage:'SECRET'}, {...good,category:'SECRET'},
    {...good,[Symbol('secret')]:'SECRET'}, Object.defineProperty({...good},'code',{get(){reads++;return 'invalid_model_history_response';}}),
    Object.assign(Object.create({hidden:'SECRET'}),good)]) expect(readRuntimeDiagnostic(bad)).toBeUndefined();
  expect(reads).toBe(0);
  expect(diagnosticFromError(Object.assign(new Error('SECRET'),{diagnostic:good}))).toBeUndefined();
  expect(diagnosticFromError(new RuntimeDiagnosticError('fixed',good))).toEqual(good);
});
test('worker ingress cannot impersonate host or smuggle raw legacy reasons', () => {
  const host=runtimeDiagnostic('host','aborted','launch');
  expect(workerDiagnostic(host)).toEqual(runtimeDiagnostic('worker','diagnostic_rejected','unknown'));
  expect(workerDiagnostic(undefined,'SECRET')).toEqual(runtimeDiagnostic('worker','unknown_native_failure','unknown'));
  expect(workerDiagnostic(undefined,'deadline_exceeded')).toEqual(runtimeDiagnostic('worker','deadline_exceeded','unknown'));
});
test('Python and host worker code/stage enums cannot silently diverge', async () => {
  const cwd=fileURLToPath(new URL('../../hermes/python',import.meta.url));
  const run=await runProcess('/usr/bin/python3',['-B','-c','import json,gary_runtime as r; print(json.dumps({"codes":sorted(r._DIAGNOSTIC_CODES),"stages":sorted(r._DIAGNOSTIC_STAGES)}))'],
    {cwd,env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},timeoutMs:5000});
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({codes:[...RUNTIME_DIAGNOSTICS.worker.codes].sort(),stages:[...RUNTIME_DIAGNOSTICS.worker.stages].sort()});
});
