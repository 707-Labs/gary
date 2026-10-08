import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/index.ts';
import type { StartupDependencies } from '../src/startup.ts';
import { APPROVED_SLACK_IDENTITY, type SlackTransport } from '../src/slack/transport.ts';
import { READONLY_READY_DM_TEXT } from '../src/slack/service.ts';
import { openDb } from '../src/state/db.ts';

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
