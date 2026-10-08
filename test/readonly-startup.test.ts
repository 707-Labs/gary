import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { verifyReadonlyRelease } from '../src/readonly-startup.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/index.ts';
import type { StartupDependencies } from '../src/startup.ts';
import { APPROVED_SLACK_IDENTITY, type SlackTransport } from '../src/slack/transport.ts';
import { READONLY_READY_DM_TEXT } from '../src/slack/service.ts';
import { openDb } from '../src/state/db.ts';
import { SpendLedger } from '../src/spend.ts';
import { Database } from 'bun:sqlite';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'gary-readonly-startup-')));roots.push(root);chmodSync(root,0o700);
  for(const name of ['fixtures','traces','state'])mkdirSync(join(root,name),{mode:0o700});
  const config={version:1,runId:'readonly-test-run',campaignId:'readonly-test-campaign',allocationId:'readonly-test-allocation',
    fixtureDirectory:join(root,'fixtures'),traceDirectory:join(root,'traces'),releaseCommit:'a'.repeat(40)};
  const configPath=join(root,'canary.json'),credentials=join(root,'slack.env');
  writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  writeFileSync(credentials,'SLACK_BOT_TOKEN=xoxb-offline-fixture-only\nSLACK_APP_TOKEN=xapp-offline-fixture-only\n',{mode:0o600});
  let ready=false,runs=0,starts=0,stops=0,identities=0,idle=0,revision=0;
  const posts:Array<{channel:string;text:string}>=[];
  const transport:SlackTransport={async start(){starts++;},async stop(){stops++;},socketHealthy:()=>starts>stops,
    async identity(){identities++;return APPROVED_SLACK_IDENTITY;},
    async sendMessage(message){posts.push(message);return {ok:true,channel:'D0FIXTURE1',ts:'1791417600.000001'};}};
  const deps:StartupDependencies={env:{GARY_RUNTIME_MODE:'hermes-readonly-canary',GARY_HERMES_ACTIVATION_PATH:configPath,
    GARY_EXECUTOR:'docker',GARY_EXECUTOR_NETWORK:'none',GARY_EXECUTOR_IMAGE:'sha256:e77edfc6e20402c7ed9f447dca81dc61e277c2a39199963f455a37a03dfcedf4',
    DOCKER_HOST:'unix:///Users/tanner/.colima/default/docker.sock',GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:credentials},
    config:()=>{throw new Error('legacy_config_forbidden');},linear:()=>{throw new Error('linear_forbidden');},github:()=>{throw new Error('github_forbidden');},
    runLoop:async()=>{throw new Error('legacy_poll_forbidden');},fetch:(async()=>{throw new Error('unmocked_network_forbidden');}) as unknown as typeof fetch,
    readonlySetup:()=>({stateDir:join(root,'state'),provider:{name:'deepseek',model:'deepseek-v4-pro',baseUrl:'https://api.deepseek.com/anthropic',apiKey:'fake-model-key',defaultBackoffMs:1000}}),
    verifyReadonlyRelease:expected=>{revision++;expect(expected).toBe(config.releaseCommit);},
    slackTransport:loaded=>{expect(loaded.botToken).toBe('xoxb-offline-fixture-only');return transport;},
    readonlyCanary:()=>({async run(){runs++;ready=true;},check:()=>({kind:'readonly_runtime' as const,ready,readonlyCanarySucceeded:ready,receiptId:ready?'sha256:'+'b'.repeat(64):'pending'})}),
    waitReadonlyIdle:async(_signal,refresh)=>{idle++;await refresh();},
  };
  return{root,config,configPath,transport,deps,posts,setReady:()=>{ready=true;},counts:()=>({runs,starts,stops,identities,idle,revision})};
}
test('actual main readonly mode starts verified Slack, runs one canary, sends exact DM and stays idle without coding clients',async()=>{
  const f=fixture();await main(f.deps);
  expect(f.counts()).toEqual({runs:1,starts:1,stops:1,identities:3,idle:1,revision:1});
  expect(f.posts).toEqual([{channel:'U0A9M5W16F8',text:READONLY_READY_DM_TEXT}]);
  const db=openDb(join(f.root,'state','gary.db'));
  try{expect(db.query('SELECT status,slack_channel FROM gary_slack_outbox').get()).toEqual({status:'sent',slack_channel:'D0FIXTURE1'});}finally{db.close();}
});
test('restart reuses verified readonly evidence but cannot repeat the authorized ready notification',async()=>{
  const f=fixture();await main(f.deps);await main(f.deps);
  expect(f.counts().runs).toBe(1);expect(f.counts().idle).toBe(2);expect(f.posts).toHaveLength(1);
});
test('conversation startup uses existing canary only and shutdown preserves its operator-owned $5 allocation',async()=>{
  const f=fixture();f.setReady();await main(f.deps);const path=join(f.root,'conversation.json');
  writeFileSync(path,JSON.stringify({version:1,runId:'hermes-dm-20261008',campaignId:'hermes-dm-20261008',allocationId:'local:hermes-dm-20261008-tanner'}),{mode:0o600});
  let ledger=new SpendLedger(join(f.root,'state','spend.db'));ledger.createCampaign('hermes-dm-20261008',5);ledger.enrollTicket('hermes-dm-20261008','local:hermes-dm-20261008-tanner',5);ledger.close();
  f.deps.env={...f.deps.env,GARY_SLACK_TANNER_DM_ENABLED:'1',GARY_READONLY_SLACK_RELEASE_COMMIT:'b'.repeat(40),GARY_SLACK_CONVERSATION_CONFIG:path};
  await main(f.deps);expect(f.posts).toHaveLength(1);expect(f.counts().runs).toBe(0);
  ledger=new SpendLedger(join(f.root,'state','spend.db'));expect(ledger.status('local:hermes-dm-20261008-tanner')).toMatchObject({state:'active',attemptCount:0});ledger.close();
  const db=new Database(join(f.root,'context.sqlite'));db.query('UPDATE control SET blocked=1 WHERE id=1').run();db.close();
  await expect(main(f.deps)).rejects.toThrow('dm_conversation_not_ready');
});
test('pinned Slack-only release requires existing readiness and can never run a new canary',async()=>{
  const f=fixture();f.deps.env={...f.deps.env,GARY_SLACK_TANNER_DM_ENABLED:'1',GARY_READONLY_SLACK_RELEASE_COMMIT:'b'.repeat(40)};
  f.deps.verifyReadonlyRelease=(expected,actual)=>{expect(expected).toBe(f.config.releaseCommit);expect(actual).toBe('b'.repeat(40));};
  await expect(main(f.deps)).rejects.toThrow('readonly_slack_release_requires_existing_receipt');
  expect(f.counts().runs).toBe(0);expect(f.counts().starts).toBe(0);expect(f.posts).toEqual([]);
  f.setReady();await main(f.deps);expect(f.counts().runs).toBe(0);expect(f.counts().idle).toBe(1);
});
test('compatibility verifies exact clean descendant and rejects any non-Slack production change',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'gary-slack-release-')));roots.push(root);
  const git=(...args:string[])=>execFileSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
  git('init','-q');git('config','user.name','Offline Test');git('config','user.email','offline@example.invalid');
  mkdirSync(join(root,'src/slack'),{recursive:true});mkdirSync(join(root,'src/hermes'),{recursive:true});
  writeFileSync(join(root,'src/slack/service.ts'),'old');writeFileSync(join(root,'src/hermes/readonly-canary.ts'),'unchanged');
  git('add','.');git('commit','-qm','fixture base');const base=git('rev-parse','HEAD');
  verifyReadonlyRelease(base,undefined,root);
  writeFileSync(join(root,'src/slack/service.ts'),'reviewed patch');git('add','.');git('commit','-qm','fixture DM');const slack=git('rev-parse','HEAD');
  verifyReadonlyRelease(base,slack,root);
  expect(()=>verifyReadonlyRelease(base,undefined,root)).toThrow('readonly_release_mismatch');
  expect(()=>verifyReadonlyRelease(base,'a'.repeat(40),root)).toThrow('readonly_release_mismatch');
  writeFileSync(join(root,'src/slack/service.ts'),'dirty');expect(()=>verifyReadonlyRelease(base,slack,root)).toThrow('readonly_release_mismatch');
  writeFileSync(join(root,'src/slack/service.ts'),'reviewed patch');writeFileSync(join(root,'src/hermes/readonly-canary.ts'),'changed proof');
  git('add','.');git('commit','-qm','fixture forbidden change');const forbidden=git('rev-parse','HEAD');
  expect(()=>verifyReadonlyRelease(base,forbidden,root)).toThrow('readonly_slack_release_scope_mismatch');
});
test('wrong release, wrong Slack identity and failed canary cannot send a ready DM',async()=>{
  for(const failure of ['revision','identity','canary'] as const){
    const f=fixture();
    if(failure==='revision')f.deps.verifyReadonlyRelease=()=>{throw new Error('readonly_release_mismatch');};
    if(failure==='identity')f.transport.identity=async()=>({...APPROVED_SLACK_IDENTITY,teamId:'TWRONG'});
    if(failure==='canary')f.deps.readonlyCanary=()=>({async run(){throw new Error('canary_failed');},check:()=>({kind:'readonly_runtime',ready:false,readonlyCanarySucceeded:false,receiptId:'pending'})});
    await expect(main(f.deps)).rejects.toThrow();expect(f.posts).toEqual([]);expect(f.counts().idle).toBe(0);
    if(failure==='revision')expect(f.counts().starts).toBe(0);else expect(f.counts().stops).toBe(1);
  }
});
test('uncertain ready delivery exits without retrying its durable claim',async()=>{
  const f=fixture();let attempts=0;
  f.transport.sendMessage=async()=>{attempts++;return {ok:false,outcome:'unknown',code:'fixture_unknown'};};
  await expect(main(f.deps)).rejects.toThrow('readonly_ready_delivery_unconfirmed');
  await expect(main(f.deps)).rejects.toThrow('readonly_ready_delivery_unconfirmed');
  expect(attempts).toBe(1);expect(f.counts().runs).toBe(1);expect(f.counts().idle).toBe(0);
  const db=openDb(join(f.root,'state','gary.db'));try{expect(db.query('SELECT status FROM gary_slack_outbox').get()).toEqual({status:'unknown'});}finally{db.close();}
});
test('abort during canary stops ingress, waits for runner cleanup, and never sends readiness',async()=>{
  const f=fixture(),controller=new AbortController();let cleaned=false;
  f.deps.signal=controller.signal;
  f.deps.readonlyCanary=(_config,options)=>({async run(){controller.abort();expect(options.signal?.aborted).toBe(true);await Promise.resolve();cleaned=true;},
    check:()=>({kind:'readonly_runtime',ready:false,readonlyCanarySucceeded:false,receiptId:'pending'})});
  await main(f.deps);expect(cleaned).toBe(true);expect(f.posts).toEqual([]);expect(f.counts().stops).toBe(1);
});
