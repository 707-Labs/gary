import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync, symlinkSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    resourceLock: { path:'/private/tmp/apple-release-xcode.lock',dev:16777232,ino:176033673,uid:501,mode:0o644,nlink:1,
      bootSessionUUID:'02D97A38-83D2-457D-967F-A01481D5EEFC',apfsVolumeUUID:'7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697' },
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
  expect(Object.isFrozen(config.resourceLock)).toBe(true);
});
test('production resource binding is mandatory and cannot widen path, ownership or metadata scope',()=>{
  const f=fixture();
  for(const change of [
    (v:any)=>{delete v.resourceLock;},(v:any)=>{v.resourceLock=null;},
    (v:any)=>{v.resourceLock.path='/tmp/arbitrary.lock';},(v:any)=>{v.resourceLock.uid=0;},
    (v:any)=>{v.resourceLock.mode=0o666;},(v:any)=>{v.resourceLock.nlink=2;},
    (v:any)=>{v.resourceLock.dev=-1;},(v:any)=>{v.resourceLock.ino=0;},
    (v:any)=>{v.resourceLock.bootSessionUUID='invalid';},(v:any)=>{v.resourceLock.apfsVolumeUUID='invalid';},
    (v:any)=>{v.resourceLock.discover=true;},
  ]) {const value=structuredClone(f.config);change(value);expect(()=>f.load(value)).toThrow('engineering_config_rejected');}
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

function continuationFixture() {
  const f = fixture(), grantId = 'gary-native-engineering-20261010-02';
  const original = { aggregatePath: join(dirname(f.root), 'aggregate.json'), ledgerPath: join(dirname(f.root), 'canonical', 'spend.db'),
    auditDir: join(dirname(f.root), 'predecessor', 'budget-admission'), runId: 'gary-native-engineering-20261010-01',
    grantId: 'gary-native-engineering-20261010-01', campaignId: 'gary-native-engineering-20261010-01-campaign',
    allocationId: 'gary-native-engineering-20261010-01-allocation', sourceRevision: '9b8b31e7a876e320432e6aead61d5cc5902ad587',
    runtimeConfigSha256: 'cd5324697e222dd9f8e5bca88a7cd1a5795bb584e9048366f6c5919aeae9656d',
    authoritySha256: '883f2b010ddcf6e18793cb95aa1a921e0e6b2403a7b4cf0a77c336cff0724645' };
  const config: EngineeringRuntimeConfig = { ...f.config, grantId, campaignId: original.campaignId, allocationId: original.allocationId,
    budget: { ...f.config.budget, aggregatePath: original.aggregatePath, runId: grantId,
      continuation: { version: 1, original, predecessorJournalPath: join(dirname(original.auditDir), 'engineering.sqlite'),
        predecessorTaskId: 'engineering-1683fa3a-bde9-4d73-b000-f84f88d67b4a', receiptPath: join(f.config.budget.auditDir, 'continuation.json') } } };
  const authority = { ...f.authority, grantId };
  return { ...f, config, authority, load: (value = config) => f.load(value, authority) };
}

test('continuation preserves the original allocation and immutable pins with separate operator paths', () => {
  const f = continuationFixture(), loaded = f.load();
  expect(loaded.grantId).toBe('gary-native-engineering-20261010-02');
  expect(loaded.allocationId).toBe(loaded.budget.continuation!.original.allocationId);
  expect(Object.isFrozen(loaded.budget.continuation)).toBe(true);
  expect(Object.isFrozen(loaded.budget.continuation!.original)).toBe(true);
  expect(loaded.budget.continuation!.receiptPath).toBe(join(loaded.budget.auditDir, 'continuation.json'));
});

test('continuation accepts only the exact immutable original-ledger reboot reference',()=>{
  const f=continuationFixture(),continuation=f.config.budget.continuation!;
  continuation.ledgerRebootAttestation={path:join(continuation.original.auditDir,continuation.original.runId+'.ledger-reboot.json'),sha256:'a'.repeat(64)};
  const loaded=f.load();expect(Object.isFrozen(loaded.budget.continuation!.ledgerRebootAttestation)).toBe(true);
  const original=structuredClone(continuation.ledgerRebootAttestation);
  for(const change of [(v:any)=>v.path+='.other',(v:any)=>v.sha256='invalid',(v:any)=>v.extra=true]) {
    continuation.ledgerRebootAttestation=structuredClone(original);change(continuation.ledgerRebootAttestation);expect(()=>f.load()).toThrow();
  }
});

test('continuation permits sibling engineering roots beneath the canonical ledger directory', () => {
  const f = continuationFixture(), state = f.root;
  const root = join(state, 'engineering-v2'), predecessorRoot = join(state, 'engineering-v1');
  const workspacesRoot = join(f.config.workspacesRoot, 'engineering-v2');
  for (const path of [root, predecessorRoot, workspacesRoot]) mkdirSync(path, { mode: 0o700 });
  const ledgerPath = join(state, 'spend.db'); writeFileSync(ledgerPath, '', { mode: 0o600 });
  const previous = f.config.budget.continuation!;
  const config: EngineeringRuntimeConfig = { ...f.config, root, workspacesRoot,
    budget: { ...f.config.budget, auditDir: join(root, 'budget-admission'), continuation: { ...previous,
      original: { ...previous.original, ledgerPath, auditDir: join(predecessorRoot, 'budget-admission') },
      predecessorJournalPath: join(predecessorRoot, 'engineering.sqlite'), receiptPath: join(root, 'budget-admission', 'continuation.json') } } };
  const raw = JSON.stringify(config), approval = JSON.stringify(f.authority);
  const path = join(root, 'config.json'), authorityPath = join(root, 'authority.json');
  writeFileSync(path, raw, { mode: 0o600 }); writeFileSync(authorityPath, approval, { mode: 0o600 });
  const loaded = loadEngineeringRuntimeConfig(path, hash(raw), authorityPath, hash(approval));
  expect(loaded.root).toBe(root); expect(loaded.workspacesRoot).toBe(workspacesRoot);
  expect(loaded.budget.continuation!.original.ledgerPath).toBe(ledgerPath);
  expect(loaded.budget.continuation!.predecessorJournalPath).toBe(join(predecessorRoot, 'engineering.sqlite'));
});

test('continuation rejects widened identities, changed predecessor pins, extra fields and overlapping roots', () => {
  const f = continuationFixture();
  const changes: ((value: any) => void)[] = [
    c => { c.budget.continuation = null; },
    c => { c.budget.continuation.version = 2; },
    c => { c.budget.continuation.extra = true; },
    c => { c.budget.continuation.original.extra = true; },
    c => { c.budget.runId = 'gary-native-engineering-20261010-03'; },
    c => { c.campaignId = 'new-campaign'; },
    c => { c.allocationId = 'new-allocation'; },
    c => { c.budget.continuation.original.grantId = 'different'; },
    c => { c.budget.continuation.original.runId = 'different'; },
    c => { c.budget.continuation.original.sourceRevision = 'a'.repeat(40); },
    c => { c.budget.continuation.original.runtimeConfigSha256 = 'a'.repeat(64); },
    c => { c.budget.continuation.original.authoritySha256 = 'a'.repeat(64); },
    c => { c.budget.continuation.original.aggregatePath += '.other'; },
    c => { c.budget.continuation.predecessorTaskId = 'another-task'; },
    c => { c.budget.continuation.predecessorJournalPath += '.other'; },
    c => { c.budget.continuation.receiptPath = join(f.root, 'continuation.json'); },
    c => { c.budget.continuation.original.ledgerPath = join(c.workspacesRoot, 'spend.db'); },
    c => { c.budget.continuation.original.ledgerPath = join(c.root, 'spend.db'); },
    c => { c.budget.continuation.original.auditDir = c.budget.auditDir;
      c.budget.continuation.predecessorJournalPath = join(c.root, 'engineering.sqlite'); },
    c => { c.budget.continuation.original.auditDir = join(c.workspacesRoot, 'old', 'budget-admission');
      c.budget.continuation.predecessorJournalPath = join(c.workspacesRoot, 'old', 'engineering.sqlite'); },
  ];
  for (const change of changes) { const candidate = structuredClone(f.config); change(candidate); expect(() => f.load(candidate)).toThrow('engineering_config_rejected'); }
});

test('grant03 requires the exact new delegation and immutable zero-spend predecessor references',()=>{
  const f=continuationFixture(),grantId='gary-native-engineering-20261010-03';
  const original=f.config.budget.continuation!.original;
  const decisionPath=join(f.root,'continuation-authority.json');
  const decision=readFileSync(join(import.meta.dir,'../fixtures/engineering-continuation-03-decision.json'));
  expect(hash(decision.toString())).toBe('61c49e6a05d3a06ce8414b0ede773cb8c691a872d441fedcb821e6ee5c52a246');
  writeFileSync(decisionPath,decision,{mode:0o600});
  const config:EngineeringRuntimeConfig={...f.config,grantId,budget:{...f.config.budget,runId:grantId,continuation:{...f.config.budget.continuation!,
    ledgerRebootAttestation:{path:join(original.auditDir,original.runId+'.ledger-reboot.json'),sha256:'a'.repeat(64)},
    afterBlockedContinuation:{receiptPath:join(dirname(dirname(original.auditDir)),'engineering-v2/budget-admission/continuation.json'),
      receiptSha256:'f7b68d23b79e16e291792f924882086af9e7149b8f9dd79bb80a7a25db3a150d',
      claimSha256:'6bdf4049a16d2165c933c1622d5f20bc91b2eb4e284673b5249c5f6b42e7b316',taskId:'engineering-438c8176-7f19-495d-9a8b-4056a141e1c8'}}}};
  const authority:EngineeringAuthorityReceipt={...f.authority,grantId,continuationDecision:{path:decisionPath,sha256:hash(decision.toString())}};
  const load=(c=config,a=authority)=>{
    const p=join(f.root,'config.json'),ap=join(f.root,'authority.json');const raw=JSON.stringify(c),approval=JSON.stringify(a);
    writeFileSync(p,raw,{mode:0o600});writeFileSync(ap,approval,{mode:0o600});return loadEngineeringRuntimeConfig(p,hash(raw),ap,hash(approval));
  };
  expect(Object.isFrozen(load().budget.continuation!.afterBlockedContinuation)).toBe(true);
  for(const change of [
    (v:any)=>{delete v.budget.continuation.afterBlockedContinuation;},
    (v:any)=>{delete v.budget.continuation.ledgerRebootAttestation;},
    (v:any)=>{v.budget.continuation.afterBlockedContinuation.receiptPath+='.other';},
    (v:any)=>{v.budget.continuation.afterBlockedContinuation.receiptSha256='a'.repeat(64);},
    (v:any)=>{v.budget.continuation.afterBlockedContinuation.claimSha256='a'.repeat(64);},
    (v:any)=>{v.budget.continuation.afterBlockedContinuation.taskId='different';},
    (v:any)=>{v.budget.continuation.afterBlockedContinuation.extra=true;},
  ]){const value=structuredClone(config);change(value);expect(()=>load(value)).toThrow('engineering_config_rejected');}
  for(const change of [(v:any)=>{delete v.continuationDecision;},(v:any)=>{v.continuationDecision.path+='.other';},
    (v:any)=>{v.continuationDecision.sha256='a'.repeat(64);},(v:any)=>{v.continuationDecision.extra=true;}]){
    const value=structuredClone(authority);change(value);expect(()=>load(config,value)).toThrow('engineering_config_rejected');
  }
  writeFileSync(decisionPath,Buffer.from(decision.toString().replace('5535224','5535225')),{mode:0o600});
  expect(()=>load()).toThrow('engineering_config_rejected');
});
