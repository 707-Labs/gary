import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadEngineeringRuntimeConfig, type EngineeringRuntimeConfig, type EngineeringAuthorityReceipt } from '../../src/hermes/engineering-config.ts';
const roots: string[] = []; afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-config-'))); roots.push(fixtureRoot); chmodSync(fixtureRoot, 0o700);
  const root=join(fixtureRoot,'state'),workspacesRoot=join(fixtureRoot,'workspaces');mkdirSync(root,{mode:0o700});mkdirSync(workspacesRoot,{mode:0o700});
  const runtimeFiles = ['gary_engineering_runtime.py', 'gary_engineering_environment.py'].map(name => {
    const path = join(root, name); writeFileSync(path, '# test source\n', { mode: 0o600 }); return { path, sha256: hash('# test source\n') };
  });
  const authority: EngineeringAuthorityReceipt = { version: 1, grantId: 'grant', sourceThreadId: '01a0fa90-833c-71cc-907b-0b3fc0e1b02d',
    assistantMessageId: 'Sentinel_668b96adaca8819199844e4bbb4f2971', userMessageId: 'Sentinel_c0289b9b991c81918b40e3a04e870894', userApproval: 'yes approve go ahead',
    requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ', capMicros: 5650000, scope: '707-Labs-existing-app-isolated-engineering', mergeAllowed: false, deploymentAllowed: false };
  const config: EngineeringRuntimeConfig = { version: 1, grantId: 'grant', allocationId: 'allocation', campaignId: 'campaign', root, workspacesRoot,
    repository: '707-Labs/example', baseBranch: 'main', baseCommit: 'a'.repeat(40), allowedFiles: ['src/example.ts'], requiredCommands: ['bun test test/example.test.ts'],
    deadlineMs: 1800000, workerImage: 'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',
    executorImage: 'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c', bunCacheVolume: 'gary-bun-cache-20261010-mulligan-4bb2fdde-v2',
    dockerExecutable: '/usr/local/bin/docker', dockerSocketPath: '/Users/tanner/.colima/default/docker.sock', runtimeFiles,
    sourceRevision: 'b'.repeat(40), publication: 'patch_only', capMicros: 5650000,
    budget: { aggregatePath: join(root, 'aggregate.json'), auditDir: join(root, 'budget-admission'), runId: 'grant' } };
  function load(c = config, a = authority) {
    const raw = JSON.stringify(c), approval = JSON.stringify(a), p = join(root, 'config.json'), ap = join(root, 'authority.json');
    writeFileSync(p, raw, { mode: 0o600 }); writeFileSync(ap, approval, { mode: 0o600 });
    return loadEngineeringRuntimeConfig(p, hash(raw), ap, hash(approval));
  }
  return { root, config, authority, load };
}
test('exact approved config loads frozen with bounded new allocation, no enrollment side effect', () => {
  const f = fixture(), config = f.load(); expect(Object.isFrozen(config)).toBe(true); expect(Object.isFrozen(config.allowedFiles)).toBe(true);
  expect(config.capMicros).toBe(5650000);
});
test('worker bind sources require a separate canonical private workspace root',()=>{
  const f=fixture();expect(()=>f.load({...f.config,workspacesRoot:f.root})).toThrow('rejected');
  expect(()=>f.load({...f.config,workspacesRoot:join(f.root,'worker-files')})).toThrow('rejected');
  chmodSync(f.config.workspacesRoot,0o755);expect(()=>f.load()).toThrow('rejected');chmodSync(f.config.workspacesRoot,0o700);
  const link=f.config.workspacesRoot+'-link';symlinkSync(f.config.workspacesRoot,link);
  expect(()=>f.load({...f.config,workspacesRoot:link})).toThrow('rejected');
});
test('larger spend, publication, mismatched approval and changed overlay are rejected', () => {
  const f = fixture();
  expect(() => f.load({ ...f.config, capMicros: 5650024 } as any)).toThrow('rejected');
  expect(() => f.load({ ...f.config, publication: 'draft_pr' } as any)).toThrow('rejected');
  for (const bunCacheVolume of ['gary-bun-cache-20261007-node24','gary-bun-cache-20261010-mulligan-4bb2fdde-v1']) {
    expect(() => f.load({ ...f.config, bunCacheVolume })).toThrow('rejected');
  }
  expect(() => f.load({ ...f.config, budget: { ...f.config.budget, auditDir: '/elsewhere' } })).toThrow('rejected');
  expect(() => f.load({ ...f.config, budget: { ...f.config.budget, runId: 'another-grant' } })).toThrow('rejected');
  expect(() => f.load(f.config, { ...f.authority, userMessageId: 'wrong' })).toThrow('rejected');
  writeFileSync(f.config.runtimeFiles[0]!.path, '# changed'); expect(() => f.load()).toThrow('rejected');
});
