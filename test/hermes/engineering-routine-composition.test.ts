import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../../src/spend.ts';
import { openEngineeringRoutineServices } from '../../src/hermes/engineering-routine-composition.ts';
import { mintEngineeringDependencyAdmission, type prepareEngineeringDependencies } from '../../src/hermes/engineering-dependency-preparation.ts';
import { assertEngineeringDependencyAdmission } from '../../src/hermes/engineering-dependency-admission.ts';
import { createEngineeringVerificationProfile } from '../../src/hermes/engineering-verification-profile.ts';
import { engineeringScopedIdentity } from '../../src/hermes/engineering-scoped-persistence.ts';
import { ENGINEERING_ROUTINE_TOOLS_SHA256 } from '../../src/hermes/standing-engineering-config.ts';
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'routine-composition-'))); chmodSync(root, 0o700);
  const scopedRoot = join(root, 'scoped'); mkdirSync(scopedRoot, { mode: 0o700 });
  const integrityKeyPath = join(root, 'key'), key = Buffer.alloc(32, 71); writeFileSync(integrityKeyPath, key, { mode: 0o600 });
  const ledger = new SpendLedger(join(root, 'spend.sqlite'));
  const scope = { teamId: 'T123456789', surface: 'private_dm' as const, audienceId: 'U123456789', projectId: 'repository:123' };
  const binding = { taskId: 'routine-fixture', sessionId: 'session-fixture', ownerEpoch: 'owner-fixture', deadlineMs: 10_000 };
  const calls: Parameters<typeof prepareEngineeringDependencies>[0][] = [];
  let time = 1_000, revoked = false;
  const services = openEngineeringRoutineServices({ ledger, config: { version: 1, toolsProfileSha256: ENGINEERING_ROUTINE_TOOLS_SHA256,
    scopedRoot, integrityKeyPath, integrityKeySha256: createHash('sha256').update(key).digest('hex'), dependencyDownloads: true, allowLifecycleScripts: false },
    now: () => time, assertCurrent() { if (revoked) throw Error('revoked'); }, dependencies: {
      async prepareDependencies(input) {
        input.assertCurrent(); assertEngineeringDependencyAdmission(input.dependencyAdmission, { binding: input.binding, plan: null }); calls.push(input);
        return Object.freeze({ root: input.materializationRoot, manifestSha256: 'a'.repeat(64), command: 'synthetic offline command', assertCurrent() {} });
      },
    } });
  clean.push(() => { services.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
  function workspace(name: string) {
    const path = join(root, name), snapshots = join(root, name + '-snapshots'); mkdirSync(path, { mode: 0o700 }); mkdirSync(snapshots, { mode: 0o700 });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }), { mode: 0o600 });
    return { path, snapshots, profile: createEngineeringVerificationProfile({ workspaceRoot: path }) };
  }
  const author = workspace('author'), provenanceSha256 = 'b'.repeat(64);
  const dependencyAdmission = mintEngineeringDependencyAdmission({ workspaceRoot: author.path, profile: author.profile,
    binding: { taskId: binding.taskId, scopeKey: engineeringScopedIdentity(scope), deadlineMs: binding.deadlineMs }, provenanceSha256, assertCurrent() {} });
  const taskInput = { binding, scope, dependencyAdmission, assertCurrent() {} };
  const task = services.taskDependencies(taskInput); task.registerWorkspace(author.path, author.snapshots);
  const request = { workspaceRoot: author.path, destination: join(author.snapshots, 'bundle'), signal: new AbortController().signal,
    assertCurrent() {}, profile: author.profile, binding, provenanceSha256 };
  return { root, services, taskInput, task, request, author, workspace, calls, integrityKeyPath,
    expire() { time = 10_000; }, revoke() { revoked = true; } };
}

test('one task shares quota and only reuses identical source/provenance bundles across registered pristine clones', async () => {
  const f = fixture(), first = await f.task.prepare(f.request), child = f.workspace('child');
  f.task.registerWorkspace(child.path, child.snapshots);
  const childRequest = { ...f.request, workspaceRoot: child.path, destination: join(child.snapshots, 'bundle'), profile: child.profile };
  expect(await f.task.prepare(childRequest)).toBe(first); expect(f.calls).toHaveLength(1);
  await f.task.prepare({ ...childRequest, provenanceSha256: 'c'.repeat(64) });
  expect(f.calls).toHaveLength(2); expect(f.calls[0]!.networkQuota).toBe(f.calls[1]!.networkQuota);
  expect(f.calls[0]!.dependencyAdmission).toBe(f.calls[1]!.dependencyAdmission);
  expect(() => f.services.taskDependencies(f.taskInput)).toThrow('task_preparation_replay');
  writeFileSync(join(child.path, 'package.json'), JSON.stringify({ scripts: { test: 'different' } }), { mode: 0o600 });
  await expect(f.task.prepare(childRequest)).rejects.toThrow(); expect(f.calls).toHaveLength(2);
});

test('foreign bindings, workspace destinations and caller abort cannot reach preparation', async () => {
  const f = fixture();
  await expect(f.task.prepare({ ...f.request, binding: { ...f.request.binding, sessionId: 'foreign' } })).rejects.toThrow('preparation_binding');
  await expect(f.task.prepare({ ...f.request, destination: join(f.root, 'escaped') })).rejects.toThrow('preparation_binding');
  const controller = new AbortController(); controller.abort();
  await expect(f.task.prepare({ ...f.request, signal: controller.signal })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test('deadline, authority and private integrity key changes fence further preparation', async () => {
  for (const change of ['deadline', 'authority', 'key'] as const) {
    const f = fixture();
    if (change === 'deadline') f.expire(); else if (change === 'authority') f.revoke(); else writeFileSync(f.integrityKeyPath, Buffer.alloc(32, 72));
    await expect(f.task.prepare(f.request)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  }
});

test('closing host-owned private database invalidates services without closing canonical ledger', () => {
  const f = fixture(); f.services.close(); f.services.close(); expect(() => f.services.assertCurrent()).toThrow('closed');
  expect(() => f.services.taskDependencies(f.taskInput)).toThrow('closed');
});
