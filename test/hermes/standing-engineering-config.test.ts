import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINEERING_ROUTINE_TOOLS_SHA256, loadStandingEngineeringConfig, parseStandingEngineeringConfig } from '../../src/hermes/standing-engineering-config.ts';
import { loadHostStartupConfig } from '../../src/host-config.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'standing-config-'))); roots.push(root); chmodSync(root, 0o700);
  const state = join(root, 'state'), workspacesRoot = join(root, 'workspaces');
  mkdirSync(state, {mode:0o700}); mkdirSync(workspacesRoot, {mode:0o700});
  const authority = {version:1,kind:'standing_engineering_authority',grantId:'standing-grant',requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',
    sourceThreadId:'offline-fixture-only',userApprovalEvidenceSha256:'a'.repeat(64),scope:'707-Labs-existing-app-isolated-engineering',
    ordinaryOwnerDMTasks:true,mergeAllowed:false,deploymentAllowed:false};
  const approval = JSON.stringify(authority), authoritySha256 = hash(approval), authorityFile=join(state,'authority.json');
  writeFileSync(authorityFile,approval,{mode:0o600});
  const runtimeFiles=['gary_engineering_environment.py','gary_engineering_runtime.py'].map(name=>{
    const path=join(state,name);writeFileSync(path,'# fixture\n',{mode:0o600});return {path,sha256:hash('# fixture\n')};
  });
  const config={version:1,kind:'standing_engineering',grantId:'standing-grant',sourceRevision:'a'.repeat(40),authoritySha256,
    requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',organization:'707-Labs',surface:'private_dm',repositoryAccess:'current_existing_github_app',
    root:state,workspacesRoot,deadlineMs:1800000,
    workerImage:'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',executorImage:'sha256:'+'b'.repeat(64),
    bunCacheVolume:'reviewed-cache',dockerExecutable:'/usr/local/bin/docker',dockerSocketPath:'/Users/tanner/.colima/default/docker.sock',runtimeFiles,
    resourceLock:{path:'/private/tmp/apple-release-xcode.lock',dev:1,ino:2,uid:501,mode:0o644,nlink:1,
      bootSessionUUID:'02D97A38-83D2-457D-967F-A01481D5EEFC',apfsVolumeUUID:'7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697'},
    funding:{version:1,poolId:'standing-engineering-fixture',campaignId:'standing-engineering-fixture-campaign',capMicros:20_000_000,taskCapMicros:5_000_000,
      authoritySha256:'c'.repeat(64),holdReceiptSha256:'d'.repeat(64)},
    fundingAuthorityPath:join(state,'funding.json'),fundingHoldReceiptPath:join(state,'hold.json'),aggregatePath:join(state,'aggregate.json'),
    publication:'patch_only',mergeAllowed:false,deploymentAllowed:false};
  function load(value:unknown=config) {const text=JSON.stringify(value),file=join(state,'config.json');writeFileSync(file,text,{mode:0o600});
    return loadStandingEngineeringConfig(file,hash(text),authorityFile,authoritySha256);}
  return {config,load,state,authorityFile};
}
test('standing policy has no ticket, repository, base or path acceptance allowlist',()=>{
  const f=fixture(),p=f.load();
  expect(Object.isFrozen(p)).toBe(true);expect(Object.isFrozen(p.funding)).toBe(true);
  expect(Object.keys(p)).not.toContain('repository');expect(Object.keys(p)).not.toContain('allowedFiles');
  expect(p.funding.capMicros).toBe(20_000_000);
  // Loading is read-only: funding files intentionally do not exist in this fixture.
});
test('capability cannot enlarge audiences, owner, publication, deployment or actual guardian deadline',()=>{
  const f=fixture();
  for(const update of [{requesterId:'another'},{organization:'other-org'},{surface:'shared_channel'},
    {publication:'draft_pr'},{mergeAllowed:true},{deploymentAllowed:true},{deadlineMs:150*60_000},
    {allowedFiles:['special.ts']},{repository:'707-Labs/acceptance-only'},
    {funding:{...f.config.funding,taskCapMicros:21_000_000}},
    {funding:{...f.config.funding,taskCapMicros:1_000_000}},
  ]) expect(()=>parseStandingEngineeringConfig({...f.config,...update})).toThrow();
});
test('private canonical state and independently pinned authority/source files remain mandatory',()=>{
  const f=fixture();
  expect(()=>f.load({...f.config,workspacesRoot:f.state})).toThrow();
  expect(()=>f.load({...f.config,authoritySha256:'f'.repeat(64)})).toThrow();
  chmodSync(f.authorityFile,0o644);expect(()=>f.load()).toThrow();chmodSync(f.authorityFile,0o600);
  const link=join(f.state,'linked-workspaces');symlinkSync(f.config.workspacesRoot,link);
  expect(()=>f.load({...f.config,workspacesRoot:link})).toThrow();
  writeFileSync(f.config.runtimeFiles[0]!.path,'# changed');expect(()=>f.load()).toThrow();
});
test('standing startup requires all pins and cannot coexist with acceptance runtime',()=>{
  const env={GARY_RUNTIME_MODE:'hermes-canary',GARY_HERMES_ACTIVATION_PATH:'/private/legacy/activation.json',
    GARY_EXECUTOR:'docker',GARY_EXECUTOR_NETWORK:'none',
    GARY_EXECUTOR_IMAGE:'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c',
    GARY_BUN_CACHE_VOLUME:'gary-bun-cache-20261007-node24',DOCKER_HOST:'unix:///Users/tanner/.colima/default/docker.sock',
    GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/slack/creds',GARY_SLACK_TANNER_DM_ENABLED:'1',
    GARY_SLACK_CONVERSATION_CONFIG:'/private/dm/config.json',GARY_CONVERSATION_RUNTIME_RELEASE:'a'.repeat(40),
    GARY_PROJECT_ASSISTANT_CONFIG:'/private/projects/config.json',GARY_PROJECT_ASSISTANT_CONFIG_SHA256:'a'.repeat(64),
    GARY_STANDING_ENGINEERING_CONFIG:'/private/standing/config.json',GARY_STANDING_ENGINEERING_CONFIG_SHA256:'b'.repeat(64),
    GARY_STANDING_ENGINEERING_AUTHORITY:'/private/standing/authority.json',GARY_STANDING_ENGINEERING_AUTHORITY_SHA256:'c'.repeat(64)};
  expect(loadHostStartupConfig(env).standingEngineeringConfigPath).toBe(env.GARY_STANDING_ENGINEERING_CONFIG);
  for(const key of ['GARY_STANDING_ENGINEERING_CONFIG_SHA256','GARY_STANDING_ENGINEERING_AUTHORITY','GARY_PROJECT_ASSISTANT_CONFIG',
    'GARY_SLACK_TANNER_DM_ENABLED'])expect(()=>loadHostStartupConfig({...env,[key]:undefined})).toThrow();
  expect(()=>loadHostStartupConfig({...env,GARY_ENGINEERING_CONFIG:'/private/acceptance/config.json'})).toThrow();
});


test('routine mode requires exact profile, three overlays and separate private pinned stores', () => {
  const f = fixture();
  const canonicalScopedRoot = realpathSync(join(f.state, '..')) + '/scoped'; mkdirSync(canonicalScopedRoot, { mode: 0o700 });
  const integrityKeyPath = join(f.state, 'integrity-key'); writeFileSync(integrityKeyPath, 'k'.repeat(32), { mode: 0o600 });
  const extra = join(f.state, 'gary_engineering_task_tools.py'); writeFileSync(extra, '# task tools', { mode: 0o600 });
  const routine = { version: 1 as const, toolsProfileSha256: ENGINEERING_ROUTINE_TOOLS_SHA256, scopedRoot: canonicalScopedRoot,
    integrityKeyPath, integrityKeySha256: hash('k'.repeat(32)), dependencyDownloads: true as const, allowLifecycleScripts: false } as const;
  const config = { ...f.config, deadlineMs: 150 * 60_000, routine,
    runtimeFiles: [...f.config.runtimeFiles, { path: extra, sha256: hash('# task tools') }] };
  expect(f.load(config).routine).toEqual(routine);
  for (const altered of [{ toolsProfileSha256: 'e'.repeat(64) }, { dependencyDownloads: false }, { scopedRoot: f.config.workspacesRoot },
    { integrityKeyPath: join(f.config.workspacesRoot, 'key') }]) expect(() => f.load({ ...config, routine: { ...routine, ...altered } })).toThrow();
  expect(() => f.load({ ...config, deadlineMs: 150 * 60_000 + 1 })).toThrow();
  expect(() => f.load({ ...config, runtimeFiles: f.config.runtimeFiles })).toThrow('routine_sources');
  writeFileSync(integrityKeyPath, 'changed'); expect(() => f.load(config)).toThrow();
});
