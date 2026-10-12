import { afterEach, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { main } from '../src/index.ts';
import type { Config } from '../src/config.ts';
import type { StartupDependencies } from '../src/startup.ts';
import { HERMES_CODING_WORKER_IMAGE, HERMES_CANARY_CHILD_IMAGE, type HermesActivationConfig } from '../src/hermes/activation.ts';
import { bindCanonicalCodeAction } from '../src/hermes/canonical-admission.ts';
import { HERMES_CODING_RUNTIME_POLICY } from '../src/hermes/coding-runtime-policy.ts';
import { openDb } from '../src/state/db.ts';
import { SpendLedger } from '../src/spend.ts';
import { setClassification, upsertTicket } from '../src/state/queries.ts';
import { LocalExecutor } from '../src/executors/local.ts';
import type { AssignedIssue, LinearAdapter } from '../src/adapters/linear.ts';
import type { GitHubClient } from '../src/adapters/github.ts';
import { APPROVED_SLACK_IDENTITY, type SlackTransport } from '../src/slack/transport.ts';
import { runLoop as runExistingLoop, type LoopWake } from '../src/loop.ts';
import { GARY_SLACK } from '../src/slack/service.ts';
import type { EngineeringReceipt } from '../src/slack/service.ts';
import type { EngineeringRuntimeConfig, EngineeringAuthorityReceipt } from '../src/hermes/engineering-config.ts';
import type { EngineeringRuntimeOptions } from '../src/hermes/engineering-runtime.ts';
import type { EngineeringContinuationBaseline } from '../src/hermes/engineering-continuation-budget.ts';
import { createStandingEngineeringBudget } from '../src/hermes/engineering-standing-budget.ts';
import { createStandingEngineeringFundingGuard } from '../src/hermes/engineering-standing-funding.ts';
import { openEngineeringRoutineServices } from '../src/hermes/engineering-routine-composition.ts';
import { ENGINEERING_ROUTINE_TOOLS_SHA256, type StandingEngineeringRuntimeConfig } from '../src/hermes/standing-engineering-config.ts';
import { ENGINEERING_WORKER_IMAGE } from '../src/hermes/engineering-native-launcher.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const issueId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-main-fixture-'))); roots.push(root); chmodSync(root, 0o700);
  const traces = join(root, 'traces'); mkdirSync(traces, { mode: 0o700 });
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const command = (...args:string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd: workspace, env: { PATH: '/usr/bin:/bin', HOME: root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('fixture_git_failed'); return result.stdout.trim();
  };
  command('init','-q'); command('config','user.email','fixture@example.invalid'); command('config','user.name','Fixture');
  command('config','core.hooksPath','/dev/null'); writeFileSync(join(workspace,'task.ts'),'baseline\n');
  command('add','task.ts'); command('commit','-qm','baseline');
  const activation: HermesActivationConfig = { version:1, issueId, repo:'fixture/repo', provider:'deepseek', model:'deepseek-v4-pro',
    workerImage:HERMES_CODING_WORKER_IMAGE, childImage:HERMES_CANARY_CHILD_IMAGE,
    dockerExecutable:'/usr/local/bin/docker', dockerHost:'unix:///Users/tanner/.colima/default/docker.sock', traceDirectory:traces,
    policy:{baseCommit:command('rev-parse','HEAD'),task:{allowedFiles:['task.ts'],criteria:[{id:'check',description:'Check allowed change',requiredCommands:['bun run check','bun run ci:full']}]},
      progress:{maxModelRequests:50,maxModelRequestsWithoutProgress:20,maxSuccessfulToolCalls:100,toolRepeatWindow:10,maxRepeatedToolCalls:5},
      instructions:[],voicePrinciples:'Use Gary voice.',readTicketIdentifiers:['ERT-1'],publicFetch:{policy:{kind:'urls',urls:[]}},
      cloudflare:{allowedServices:[],allowedDatabases:[]},preparationCommands:[]}};
  const activationPath=join(root,'activation.json'); writeFileSync(activationPath,JSON.stringify(activation),{mode:0o600});
  const config:Config={
    gary:{name:'Gary fixture',linearUserId:'fixture-user',home:root,stateDir:join(root,'state'),reposDir:join(root,'repos'),workspacesDir:join(root,'workspaces'),
      dbPath:join(root,'state','gary.db'),repoMap:new Map([['ERT','fixture/repo']]),allowlistedMentionUserIds:[]},
    linear:{apiKey:'fake-linear',teamId:'fixture-team',inProgressStateId:'fixture-progress'},
    github:{kind:'pat',token:'fake-github',username:'fixture'},
    providers:[{name:'deepseek',apiKey:'fixture-model-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-v4-pro',defaultBackoffMs:1000}],
    cloudflare:null,runtime:{pollIntervalMs:1,maxAttemptsPerTicket:1,circuitBreakerWindowHours:6,maxCiAttempts:1,agentLoopMaxIterations:50,agentLoopTimeoutMs:30_000,stalePrAfterMs:1000},
    review:{providerOrder:['deepseek'],maxRounds:1,iterationCap:5,timeoutMs:1000},
  };
  const env={GARY_RUNTIME_MODE:'hermes-canary',GARY_HERMES_ACTIVATION_PATH:activationPath,GARY_EXECUTOR:'docker',GARY_EXECUTOR_NETWORK:'none',GARY_EXECUTOR_IMAGE:HERMES_CODING_RUNTIME_POLICY.executor.image,
      GARY_BUN_CACHE_VOLUME:HERMES_CODING_RUNTIME_POLICY.executor.bunCacheVolume,
    DOCKER_HOST:'unix:///Users/tanner/.colima/default/docker.sock'};
  let networkCalls=0;
  const deps:StartupDependencies={executorJobs:{create:options=>({directory:options.directory,close(){}}),reconcile:async()=>{}},env,config:()=>config,linear:()=>({} as LinearAdapter),github:()=>({} as GitHubClient),
    db:()=>openDb(':memory:'),ledger:()=>new SpendLedger(':memory:'),fetch:(async()=>{networkCalls++;throw new Error('fixture_network_forbidden');}) as unknown as typeof fetch};
  return{root,workspace,activation,activationPath,config,env,deps,networkCalls:()=>networkCalls};
}
test('actual main selects the real Hermes factory and an injected failure never invokes a legacy coding loop',async()=>{
  const f=fixture(); let launched=0, polls=0;
  const beforeSignals=process.listenerCount('SIGTERM');
  await main({...f.deps,launch:async manifest=>{launched++;return{taskId:manifest.taskId,requestId:manifest.requestId,status:'error',publicationApproved:false,reason:'offline_fixture_stop'};},
    runLoop:async args=>{
      polls++;expect([...args.allowedIssueIds!]).toEqual([issueId]);expect([...args.allowedActionTypes!]).toEqual(['classify','start_coding']);
      expect(typeof args.onCodePublication).toBe('function');expect(typeof args.createCodeVerification).toBe('function');expect(args.agentLoopTimeoutMs).toBe(9_000_000);
      expect(args.codingExecutorProfile).toBe(HERMES_CODING_RUNTIME_POLICY.executor);
      expect(args.codingBase).toEqual({branch:'main',commit:f.activation.policy.baseCommit});
      expect(args.review).toEqual({providerOrder:['deepseek'],maxRounds:1,iterationCap:6,timeoutMs:180_000});
      expect(f.config.review.iterationCap).toBe(5); // Legacy config cannot widen or shrink the fixed trial review contract.
      args.spend!.createCampaign('fixture',10);args.spend!.enrollTicket('fixture',issueId,10,{draftPr:true,codingReviewReserve:true});
      upsertTicket(args.db,{linearId:issueId,identifier:'ERT-1'});
      expect(args.codingTrial).toBeDefined();
      const admitted={issueId,fingerprint:'fixture-fp',humanSignature:'fixture-human',provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'};
      const classify=args.codingTrial!.admit({...admitted,actionType:'classify'});
      setClassification(args.db,{linearId:issueId,classification:'CODE',confidence:.99,scope:'S'});classify.complete(true,'handled');
      const trial=args.codingTrial!.admit({...admitted,actionType:'start_coding'}),actionId=trial.actionId;
      const issue={id:issueId,identifier:'ERT-1',teamId:'fixture-team',teamKey:'ERT'} as AssignedIssue;
      const binding=bindCanonicalCodeAction({db:args.db,ledger:args.spend!,actionId,fingerprint:'fixture-fp',issue,repo:'fixture/repo',provider:'deepseek',model:'deepseek-v4-pro'});
      try {
        const runner=args.createAdmittedCodeLoop!(binding.admission);
        const result=await runner({glm:args.glm,executor:new LocalExecutor(f.workspace),systemPrompt:'Offline Gary fixture',task:'Investigate fixture',
          maxIterations:50,maxTokensPerTurn:128,timeoutMs:30_000,deadlineMs:Date.now()+30_000,finishGateCommand:'bun run ci:full',disableSubagent:true});
        expect(result.status).toBe('error');
        expect(args.spend!.status(issueId)?.attemptCount).toBe(0);
      } finally {trial.complete(false,'error');binding.close();}
    }});
  expect({launched,polls,network:f.networkCalls()}).toEqual({launched:1,polls:1,network:0});
  expect(process.listenerCount('SIGTERM')).toBe(beforeSignals);
});
test('actual legacy main preserves the existing DeepSeek-only campaign and omits all canary hooks',async()=>{
  const f=fixture(); let polls=0;
  f.config.providers=[...f.config.providers,{name:'z.ai',apiKey:'fake-zai',baseUrl:'https://api.z.ai/api/anthropic',model:'glm-5.3',defaultBackoffMs:1000}];
  await main({...f.deps,env:{},runLoop:async args=>{polls++;expect(args.createAdmittedCodeLoop).toBeUndefined();expect(args.allowedIssueIds).toBeUndefined();expect(args.codingTrial).toBeUndefined();expect(args.codingExecutorProfile).toBeUndefined();expect(args.codingBase).toBeUndefined();
    expect(args.glm.chain.providers.map(p=>p.name)).toEqual(['deepseek']);expect(args.review).toEqual(f.config.review);}});
  expect(polls).toBe(1);expect(f.networkCalls()).toBe(0);
});
test('unsafe executor, missing activation and mismatched route stop before polling or network',async()=>{
  for(const kind of ['executor','missing','route'] as const){const f=fixture();let polls=0;
    if(kind==='executor')f.env.GARY_EXECUTOR='local';
    if(kind==='missing')f.env.GARY_HERMES_ACTIVATION_PATH=join(f.root,'missing.json');
    if(kind==='route')f.config.providers=[{...f.config.providers[0]!,baseUrl:'https://other.invalid'}];
    await expect(main({...f.deps,runLoop:async()=>{polls++;}})).rejects.toThrow();expect(polls).toBe(0);expect(f.networkCalls()).toBe(0);
  }
});
test('startup closes canonical handles and signal listeners on polling failure',async()=>{
  const f=fixture();let dbClosed=false,ledgerClosed=false;
  const signalCount=process.listenerCount('SIGTERM');
  const db=openDb(':memory:'),ledger=new SpendLedger(':memory:');
  const closeDb=db.close.bind(db),closeLedger=ledger.close.bind(ledger);
  db.close=()=>{dbClosed=true;closeDb();};ledger.close=()=>{ledgerClosed=true;closeLedger();};
  await expect(main({...f.deps,db:()=>db,ledger:()=>ledger,runLoop:async()=>{throw new Error('fixture');}})).rejects.toThrow('fixture');
  expect({dbClosed,ledgerClosed}).toEqual({dbClosed:true,ledgerClosed:true});expect(process.listenerCount('SIGTERM')).toBe(signalCount);
});

function slackFixture() {
  const f=fixture();
  const credentialsPath=join(f.root,'slack.env');
  writeFileSync(credentialsPath,'SLACK_BOT_TOKEN=xoxb-offline-fixture-only\nSLACK_APP_TOKEN=xapp-offline-fixture-only\n',{mode:0o600});
  const env={...f.env,GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:credentialsPath};
  let started=false,stopped=false,identityCalls=0,sends=0;
  const transport:SlackTransport={
    async start(){started=true;},async stop(){stopped=true;},socketHealthy:()=>started&&!stopped,
    async identity(){identityCalls++;return APPROVED_SLACK_IDENTITY;},
    async sendMessage(){sends++;return {ok:false,outcome:'definitely_not_sent',code:'fixture'};},
  };
  return {...f,env,credentialsPath,transport,stats:()=>({started,stopped,identityCalls,sends})};
}
test('actual main loads the private Slack file, connects before polling, refreshes after a tick, and never announces an unproven canary',async()=>{
  const f=slackFixture();let polls=0;
  await main({...f.deps,env:f.env,slackTransport:credentials=>{
    expect(credentials).toEqual({botToken:'xoxb-offline-fixture-only',appToken:'xapp-offline-fixture-only'});return f.transport;
  },runLoop:async args=>{
    polls++;expect(f.stats()).toMatchObject({started:true,stopped:false,identityCalls:1,sends:0});
    expect(typeof args.onTickComplete).toBe('function');
    await args.onTickComplete!({} as never);
    expect(f.stats()).toMatchObject({identityCalls:2,sends:0});
    expect(args.db.query('SELECT count(*) AS n FROM gary_slack_outbox').get()).toEqual({n:0});
  }});
  expect(polls).toBe(1);expect(f.stats()).toMatchObject({stopped:true,sends:0});expect(f.networkCalls()).toBe(0);
});
test('invalid Slack file and wrong authenticated identity fail before polling',async()=>{
  for(const kind of ['file','identity','start'] as const){
    const f=slackFixture();let polls=0,factories=0;
    if(kind==='file')chmodSync(f.credentialsPath,0o644);
    if(kind==='identity')f.transport.identity=async()=>({...APPROVED_SLACK_IDENTITY,botUserId:'UWRONG'});
    if(kind==='start')f.transport.start=async()=>{throw new Error('private transport failure');};
    await expect(main({...f.deps,env:f.env,slackTransport:()=>{factories++;return f.transport;},runLoop:async()=>{polls++;}})).rejects.toThrow();
    expect(polls).toBe(0);expect(f.networkCalls()).toBe(0);
    expect(factories).toBe(kind==='file'?0:1);if(kind!=='file')expect(f.stats().stopped).toBe(true);
  }
});
test('shutdown stops Slack before canonical handles close, including stop failure',async()=>{
  for(const failStop of [false,true]){
    const f=slackFixture(),order:string[]=[];
    const db=openDb(':memory:'),ledger=new SpendLedger(':memory:');
    const closeDb=db.close.bind(db),closeLedger=ledger.close.bind(ledger);
    db.close=()=>{order.push('db');closeDb();};ledger.close=()=>{order.push('ledger');closeLedger();};
    f.transport.stop=async()=>{expect(db.query('SELECT 1 AS n').get()).toEqual({n:1});order.push('slack');if(failStop)throw new Error('fixture_stop_failed');};
    const result=main({...f.deps,env:f.env,db:()=>db,ledger:()=>ledger,slackTransport:()=>f.transport,runLoop:async()=>{}});
    if(failStop)await expect(result).rejects.toThrow('slack_service_stop_failed');else await result;
    expect(order).toEqual(['slack','ledger','db']);expect(f.networkCalls()).toBe(0);
  }
});
test('cancellation closes Slack ingress immediately and completed-tick hook cannot send afterwards',async()=>{
  const f=slackFixture(),controller=new AbortController();
  await main({...f.deps,env:f.env,signal:controller.signal,slackTransport:()=>f.transport,runLoop:async args=>{
    controller.abort();expect(f.stats().stopped).toBe(true);expect(args.signal?.aborted).toBe(true);
    await args.onTickComplete!({} as never);expect(f.stats()).toMatchObject({identityCalls:1,sends:0});
  }});
  const second=slackFixture();let factories=0,polls=0;
  await main({...second.deps,env:second.env,signal:controller.signal,slackTransport:()=>{factories++;return second.transport;},runLoop:async()=>{polls++;}});
  expect({factories,polls}).toEqual({factories:0,polls:0});
});

test('coding journal reconciliation completes before adapters or admissions; failure closes all handles',async()=>{
 for(const rejected of [false,true]) {
  const f=fixture(),events:string[]=[];let directory='';
  const run=main({...f.deps,executorJobs:{create:options=>{events.push('create');directory=options.directory;return{directory,close(){events.push('close');}};},
    reconcile:async journal=>{expect(journal.directory).toBe(join(f.activation.traceDirectory,'executor-jobs'));events.push('reconcile');if(rejected)throw new Error('unreconciled');}},
    linear:()=>{events.push('linear');return {} as LinearAdapter;},runLoop:async()=>{events.push('loop');}});
  if(rejected)await expect(run).rejects.toThrow('unreconciled');else await run;
  expect(events).toEqual(rejected?['create','reconcile','close']:['create','reconcile','linear','loop','close']);expect(f.networkCalls()).toBe(0);
 }
});


test('actual main carries the protected stacked branch and commit to the dispatcher without I/O', async () => {
  const f = fixture(); f.activation.policy.baseBranch = 'codex/baseline-test-repairs-20261008';
  writeFileSync(f.activationPath, JSON.stringify(f.activation), { mode: 0o600 });
  let polls = 0;
  await main({ ...f.deps, runLoop: async args => {
    polls++;
    expect(args.codingBase).toEqual({ branch: f.activation.policy.baseBranch!, commit: f.activation.policy.baseCommit });
    expect(Object.isFrozen(args.codingBase)).toBe(true);
  } });
  expect(polls).toBe(1); expect(f.networkCalls()).toBe(0);
});

test('combined conversation source verification fails before credentials, ledger or polling',async()=>{
  const f=slackFixture();let verified=0,configured=0,polls=0;
  await expect(main({...f.deps,env:{...f.env,GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),
    GARY_SLACK_SHARED_CONVERSATION_CONFIG:'/private/shared/config.json'},
    verifyConversationRelease:expected=>{expect(expected).toBe('c'.repeat(40));verified++;throw new Error('fixture_release_mismatch');},
    config:()=>{configured++;return f.config;},runLoop:async()=>{polls++;}})).rejects.toThrow('fixture_release_mismatch');
  expect({verified,configured,polls,network:f.networkCalls()}).toEqual({verified:1,configured:0,polls:0,network:0});
});

test('combined startup separates private and shared contexts from coding publication readiness and drains both',async()=>{
  for(const metadataAvailable of [true,false]){
    const f=slackFixture(),ledger=new SpendLedger(':memory:'),db=openDb(':memory:');
    const dmDir=join(f.root,'private-dm'),sharedDir=join(f.root,'shared');
    mkdirSync(dmDir,{mode:0o700});mkdirSync(sharedDir,{mode:0o700});
    const dmPath=join(dmDir,'config.json'),sharedPath=join(sharedDir,'config.json');
    writeFileSync(dmPath,JSON.stringify({version:1,runId:'hermes-dm-20261008',campaignId:'hermes-dm-20261008',allocationId:'local:hermes-dm-20261008-tanner'}),{mode:0o600});
    writeFileSync(sharedPath,JSON.stringify({version:1,runId:'hermes-shared-20261008',campaignId:'hermes-shared-20261008',allocationId:'local:hermes-shared-20261008',
      teamId:'T0AA24R7VUZ',appId:'A0C7QFW3PEG',botUserId:'U0C7NPEUG1F',trigger:'explicit_mention'}),{mode:0o600});
    ledger.createCampaign('hermes-dm-20261008',5);ledger.enrollTicket('hermes-dm-20261008','local:hermes-dm-20261008-tanner',5);
    ledger.createCampaign('hermes-shared-20261008',5);ledger.enrollTicket('hermes-shared-20261008','local:hermes-shared-20261008',5);
    if(metadataAvailable){f.transport.memberInfo=async()=>{throw new Error('no_event_expected');};f.transport.channelInfo=async()=>{throw new Error('no_event_expected');};}
    let verified=0,polls=0,ledgerClosed=false;
    const originalClose=ledger.close.bind(ledger);ledger.close=()=>{ledgerClosed=true;originalClose();};
    await main({...f.deps,env:{...f.env,GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),GARY_SLACK_TANNER_DM_ENABLED:'1',
      GARY_SLACK_CONVERSATION_CONFIG:dmPath,GARY_SLACK_SHARED_CONVERSATION_CONFIG:sharedPath},verifyConversationRelease:()=>{verified++;},
      db:()=>db,ledger:()=>ledger,slackTransport:()=>f.transport,runLoop:async args=>{
        polls++;expect(verified).toBe(1);expect(f.stats()).toMatchObject({started:true,sends:0});
        expect(args.codingTrial).toBeDefined();expect([...args.allowedIssueIds!]).toEqual([issueId]);
        expect(ledger.status('local:hermes-dm-20261008-tanner')?.attemptCount).toBe(0);
        expect(ledger.status('local:hermes-shared-20261008')?.attemptCount).toBe(0);
        expect(db.query('SELECT count(*) n FROM gary_slack_outbox').get()).toEqual({n:0});
        await args.onTickComplete!({} as never);expect(f.stats().sends).toBe(0);
      }});
    expect({verified,polls,ledgerClosed,network:f.networkCalls()}).toEqual({verified:1,polls:1,ledgerClosed:true,network:0});
    expect(f.stats()).toMatchObject({stopped:true,sends:0});
  }
});

test('actual startup drafts a producer alert in its own ledger with no conversation spend or publication',async()=>{
 const f=slackFixture(),ledger=new SpendLedger(':memory:'),db=openDb(':memory:');
 const sharedDir=join(f.root,'shared'),alertDir=join(f.root,'alerts');mkdirSync(sharedDir,{mode:0o700});mkdirSync(alertDir,{mode:0o700});
 const sharedPath=join(sharedDir,'config.json'),alertPath=join(alertDir,'config.json');
 writeFileSync(sharedPath,JSON.stringify({version:1,runId:'hermes-shared-20261008',campaignId:'hermes-shared-20261008',allocationId:'local:hermes-shared-20261008',teamId:'T0AA24R7VUZ',appId:'A0C7QFW3PEG',botUserId:'U0C7NPEUG1F',trigger:'explicit_mention'}),{mode:0o600});
 const raw=JSON.stringify({version:1,mode:'draft',teamId:'T0AA24R7VUZ',channelId:'C0AKGTZM8KB',botId:'B0AJNH6K4LF',appId:'A0AK0JCN5PF'});writeFileSync(alertPath,raw,{mode:0o600});
 ledger.createCampaign('hermes-shared-20261008',5);ledger.enrollTicket('hermes-shared-20261008','local:hermes-shared-20261008',5);
 let receive:Parameters<SlackTransport['start']>[0]=()=>{};const originalStart=f.transport.start;
 f.transport.start=async(handler,signal)=>{receive=handler;await originalStart(handler,signal);};
 f.transport.memberInfo=async()=>{throw new Error('human_lookup_forbidden');};
 f.transport.channelInfo=async channel=>{expect(channel).toBe('C0AKGTZM8KB');return{id:channel,teamId:'T0AA24R7VUZ',isMember:true,isArchived:false,isPrivate:false,isShared:false,isExtShared:false,isOrgShared:false,isPendingExtShared:false,observedAt:Date.now()};};
 await main({...f.deps,env:{...f.env,GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),GARY_SLACK_SHARED_CONVERSATION_CONFIG:sharedPath,
  GARY_SLACK_ALERT_CONFIG:alertPath,GARY_SLACK_ALERT_CONFIG_SHA256:createHash('sha256').update(raw).digest('hex')},verifyConversationRelease:()=>{},db:()=>db,ledger:()=>ledger,slackTransport:()=>f.transport,
  runLoop:async()=>{
   const seconds=Math.floor(Date.now()/1000),ts=`${seconds}.000001`;
   const envelope={type:'events_api',envelope_id:'offline-alert-startup',payload:{type:'event_callback',api_app_id:'A0C7QFW3PEG',team_id:'T0AA24R7VUZ',event_id:'EvSTARTUP123',event_time:seconds,is_ext_shared_channel:false,
    event:{type:'message',channel:'C0AKGTZM8KB',channel_type:'channel',subtype:'bot_message',bot_id:'B0AJNH6K4LF',app_id:'A0AK0JCN5PF',ts,event_ts:ts,attachments:[{title:'🚨 Error Alert',fields:[{title:'Event',value:'runtime_failure'},{title:'Worker',value:'frontend'},{title:'Error',value:'Workers runtime outcome: exceededCpu'}]}]}}};
   await receive(envelope,{rawBytes:Buffer.byteLength(JSON.stringify(envelope))});
   const proof=new Database(join(alertDir,'alerts.sqlite'),{readonly:true});try{
    expect(proof.query('SELECT state FROM alert_messages').all()).toEqual([{state:'draft'}]);
    expect(proof.query('SELECT count(*) n FROM alert_outbox').get()).toEqual({n:0});
   }finally{proof.close();}
   expect(ledger.status('local:hermes-shared-20261008')?.attemptCount).toBe(0);
   expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'alert_%'").all()).toEqual([]);
  }});
 expect(f.networkCalls()).toBe(0);expect(f.stats()).toMatchObject({stopped:true,sends:0});
});

test('actual startup routes an authenticated Slack question through canonical current-work tools',async()=>{
 const f=slackFixture(),ledger=new SpendLedger(':memory:'),db=openDb(':memory:');
 f.activation.repo='707-Labs/mulligan-labs';writeFileSync(f.activationPath,JSON.stringify(f.activation));f.config.gary.repoMap=new Map([['ERT','707-Labs/mulligan-labs']]);
 const sharedDir=join(f.root,'shared'),projectDir=join(f.root,'projects');mkdirSync(sharedDir,{mode:0o700});mkdirSync(projectDir,{mode:0o700});
 const sharedPath=join(sharedDir,'config.json');writeFileSync(sharedPath,JSON.stringify({version:1,runId:'hermes-shared-20261008',campaignId:'hermes-shared-20261008',allocationId:'local:hermes-shared-20261008',teamId:'T0AA24R7VUZ',appId:'A0C7QFW3PEG',botUserId:'U0C7NPEUG1F',trigger:'explicit_mention'}),{mode:0o600});
 const projectPath=join(projectDir,'config.json'),raw=JSON.stringify({version:1,teamId:'T0AA24R7VUZ',ownerUserId:'U0A9M5W16F8',memoryPath:join(projectDir,'project-memory.sqlite'),projects:[{id:'mulligan-labs',repo:'707-Labs/mulligan-labs',teamKey:'ERT',label:'Mulligan Labs',summary:'A multiplayer tabletop; inspect canonical work for current status.',sharedChannelIds:['C0CHANNEL1']}]});
 writeFileSync(projectPath,raw,{mode:0o600});ledger.createCampaign('hermes-shared-20261008',5);ledger.enrollTicket('hermes-shared-20261008','local:hermes-shared-20261008',5);
 let receive:(envelope:unknown)=>void|Promise<void>=()=>{},providerCalls=0;const sent:string[]=[];
 const start=f.transport.start.bind(f.transport);f.transport.start=async(callback,signal)=>{receive=callback;await start(callback,signal);};
 f.transport.memberInfo=async id=>({id,teamId:'T0AA24R7VUZ',deleted:false,isBot:false,isAppUser:false,isRestricted:false,isUltraRestricted:false,isStranger:false,observedAt:Date.now()});
 f.transport.channelInfo=async id=>({id,teamId:'T0AA24R7VUZ',isMember:true,isArchived:false,isPrivate:false,isShared:false,isExtShared:false,isOrgShared:false,isPendingExtShared:false,observedAt:Date.now()});
 f.transport.sendMessage=async request=>{sent.push(request.text);return {ok:true,channel:request.channel,ts:'1791452000.000002'};};
 await main({...f.deps,env:{...f.env,GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),GARY_SLACK_SHARED_CONVERSATION_CONFIG:sharedPath,GARY_PROJECT_ASSISTANT_CONFIG:projectPath,GARY_PROJECT_ASSISTANT_CONFIG_SHA256:createHash('sha256').update(raw).digest('hex')},
  verifyConversationRelease:()=>{},db:()=>db,ledger:()=>ledger,slackTransport:()=>f.transport,
  fetch:(async request=>{providerCalls++;const body:any=await (request as Request).json();
   const content=providerCalls===1?[{type:'tool_use',id:'work_call',name:'current_work',input:{project:'mulligan-labs'}}]:[{type:'text',text:'ERT-2990 is recorded in progress; that record alone does not prove live execution.'}];
   if(providerCalls===2){expect(JSON.stringify(body.messages)).toContain('ERT-2990');expect(JSON.stringify(body.messages)).toContain('recorded_in_progress');}
   return Response.json({id:'msg_fixture',type:'message',role:'assistant',model:'deepseek-v4-pro',content,stop_reason:providerCalls===1?'tool_use':'end_turn',usage:{input_tokens:30,output_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
  }) as typeof fetch,
  launch:async(m,handle)=>{
   const history:any[]=[...(m.history??[]),{role:'user',content:m.prompt}];
   const rpc=(path:string,value:unknown)=>handle(new Request('http://127.0.0.1'+path,{method:'POST',headers:{authorization:'Bearer '+m.capability,'content-type':'application/json'},body:JSON.stringify(value)}));
   for(let i=0;i<2;i++){
    const response:any=await (await rpc('/v1/chat/completions',{model:m.model,messages:[{role:'system',content:m.systemPrompt},...history],max_tokens:m.maxTokens,temperature:m.temperature,tools:m.tools,stream:false})).json();
    const message=response.choices[0].message;history.push(message);
    for(const call of message.tool_calls??[]){const result:any=await (await rpc('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,callId:call.id,name:call.function.name,arguments:JSON.parse(call.function.arguments)})).json();history.push({role:'tool',tool_call_id:call.id,content:result.content});}
   }
   return {taskId:m.taskId,requestId:m.requestId,status:'no_finish',publicationApproved:false,history};
  },runLoop:async()=>{
   db.query("INSERT INTO tickets(linear_id,identifier) VALUES('active-ticket','ERT-2990')").run();
   db.query("INSERT INTO actions(ticket_linear_id,action_type,state_fingerprint,started_at,outcome) VALUES('active-ticket','start_coding','fixture','2026-10-08T09:20:24Z','unknown')").run();
   await receive({type:'events_api',payload:{type:'event_callback',team_id:'T0AA24R7VUZ',api_app_id:'A0C7QFW3PEG',event_id:'EvProjectFixture1',event:{type:'app_mention',user:'U0A9M5W16F8',channel:'C0CHANNEL1',ts:'1791452000.000001',text:'<@U0C7NPEUG1F> what are you working on now?'}}});
   expect(providerCalls).toBe(2);expect(sent).toEqual(['ERT-2990 is recorded in progress; that record alone does not prove live execution.']);
   expect(ledger.status('local:hermes-shared-20261008')).toMatchObject({attemptCount:2,unknownAttempts:0});
  }});
});

test('actual startup exposes scoped ticket/repository/controller tools, wakes its existing loop and keeps private memory out of shared replies',async()=>{
 const f=slackFixture(),ledger=new SpendLedger(':memory:'),db=openDb(':memory:'),stop=new AbortController();
 f.activation.repo='707-Labs/mulligan-labs';writeFileSync(f.activationPath,JSON.stringify(f.activation));
 f.config.gary.repoMap=new Map([['ERT',f.activation.repo]]);
 const projectDir=join(f.root,'projects'),dmDir=join(f.root,'dm'),sharedDir=join(f.root,'shared');
 for(const dir of [projectDir,dmDir,sharedDir])mkdirSync(dir,{mode:0o700});
 const dmPath=join(dmDir,'config.json'),sharedPath=join(sharedDir,'config.json'),projectPath=join(projectDir,'config.json');
 writeFileSync(dmPath,JSON.stringify({version:1,runId:'hermes-dm-20261008',campaignId:'hermes-dm-20261008',allocationId:'local:hermes-dm-20261008-tanner'}),{mode:0o600});
 writeFileSync(sharedPath,JSON.stringify({version:1,runId:'hermes-shared-20261008',campaignId:'hermes-shared-20261008',allocationId:'local:hermes-shared-20261008',
  teamId:'T0AA24R7VUZ',appId:'A0C7QFW3PEG',botUserId:'U0C7NPEUG1F',trigger:'explicit_mention'}),{mode:0o600});
 const raw=JSON.stringify({version:1,teamId:'T0AA24R7VUZ',ownerUserId:'U0A9M5W16F8',memoryPath:join(projectDir,'project-memory.sqlite'),projects:[{
  id:'mulligan-labs',repo:f.activation.repo,teamKey:'ERT',label:'Mulligan Labs',summary:'Fixture project.',sharedChannelIds:['C0CHANNEL1'],
  root:f.workspace,revision:f.activation.policy.baseCommit,readPaths:['task.ts']}]});
 writeFileSync(projectPath,raw,{mode:0o600});
 // The repository tool must return committed data, never a simultaneous editor's contents.
 writeFileSync(join(f.workspace,'task.ts'),'uncommitted fixture text must not be exposed\n');
 for(const [campaign,allocation] of [['hermes-dm-20261008','local:hermes-dm-20261008-tanner'],['hermes-shared-20261008','local:hermes-shared-20261008']]){
  ledger.createCampaign(campaign!,5);ledger.enrollTicket(campaign!,allocation!,5);
 }
 ledger.createCampaign('coding-fixture',10);ledger.enrollTicket('coding-fixture',issueId,10,{draftPr:true,codingReviewReserve:true});
 upsertTicket(db,{linearId:issueId,identifier:'ERT-1'});
 const ticket:AssignedIssue={id:issueId,identifier:'ERT-1',title:'Full fixture ticket',description:'Problem: missing context.\nAcceptance criteria:\n- Preserve all rows.\n- Do not start a duplicate job.',
  url:'https://linear.app/fixture/issue/ERT-1',stateName:'Todo',stateType:'unstarted',createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T01:00:00Z',
  creatorId:null,creatorName:null,teamId:'fixture-team',teamKey:'ERT',blockedBy:[]};
 let receive:(envelope:unknown)=>void|Promise<void>=()=>{},providerCalls=0,detailCalls=0,commentCalls=0,polls=0,launches=0;
 let wake:LoopWake|undefined;const receipts:Record<string,any>={},sent:Array<{channel:string;text:string}>=[];
 const originalStart=f.transport.start.bind(f.transport);
 f.transport.start=async(handler,signal)=>{receive=handler;await originalStart(handler,signal);};
 f.transport.memberInfo=async id=>({id,teamId:'T0AA24R7VUZ',deleted:false,isBot:false,isAppUser:false,isRestricted:false,isUltraRestricted:false,isStranger:false,observedAt:Date.now()});
 f.transport.channelInfo=async id=>({id,teamId:'T0AA24R7VUZ',isMember:true,isArchived:false,isPrivate:false,isShared:false,isExtShared:false,isOrgShared:false,isPendingExtShared:false,observedAt:Date.now()});
 f.transport.sendMessage=async request=>{sent.push({channel:request.channel,text:request.text});return{ok:true,channel:request.channel,ts:'1791452000.00000'+sent.length};};
 const emit=(privateDM:boolean)=>receive({type:'events_api',payload:{type:'event_callback',team_id:'T0AA24R7VUZ',api_app_id:'A0C7QFW3PEG',event_id:privateDM?'EvRichPrivate1':'EvRichShared1',
  event:privateDM?{type:'message',channel_type:'im',user:'U0A9M5W16F8',channel:'D0FIXTURE1',ts:'1791452100.000001',text:'Read ERT-1 and its source, remember my private note, then ask the existing controller to consider it.'}
   :{type:'app_mention',user:'U0A97PBGXE3',channel:'C0CHANNEL1',ts:'1791452200.000001',text:'<@U0C7NPEUG1F> Read ERT-1, its source and controller status. What notes are shared here?'}}});
 const tool=(id:string,name:string,args:Record<string,unknown>)=>({type:'tool_use',id,name,input:{project:'mulligan-labs',...args}});
 const timer=setTimeout(()=>stop.abort(),2500);
 try{await main({...f.deps,signal:stop.signal,env:{...f.env,GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),GARY_SLACK_TANNER_DM_ENABLED:'1',
  GARY_SLACK_CONVERSATION_CONFIG:dmPath,GARY_SLACK_SHARED_CONVERSATION_CONFIG:sharedPath,GARY_PROJECT_ASSISTANT_CONFIG:projectPath,
  GARY_PROJECT_ASSISTANT_CONFIG_SHA256:createHash('sha256').update(raw).digest('hex')},verifyConversationRelease:()=>{},
  db:()=>db,ledger:()=>ledger,slackTransport:()=>f.transport,
  linear:()=>({fetchAssignedIssues:async()=>[],fetchByIdentifier:async(identifier:string)=>{expect(identifier).toBe('ERT-1');detailCalls++;return ticket;},
   fetchComments:async(id:string,limit?:number)=>{expect(id).toBe(issueId);expect(limit).toBe(21);commentCalls++;return[{id:'comment-fixture',body:'Keep the acceptance criteria intact.',createdAt:'2026-10-10T01:00:00Z',userId:null,userName:'Fixture author'}];}} as unknown as LinearAdapter),
  fetch:(async request=>{
   providerCalls++;const body:any=await (request as Request).json();
   let content:any[];
   if(providerCalls===1)content=[tool('private_ticket','ticket_detail',{ticket:'ERT-1'}),tool('private_repo','repository_read',{path:'task.ts'}),
    tool('private_status','controller_status',{ticket:'ERT-1'}),tool('private_handoff','controller_handoff',{ticket:'ERT-1'}),
    tool('private_memory','remember_fact',{text:'Owner-private fixture note alpha.'})];
   else if(providerCalls===3)content=[tool('shared_ticket','ticket_detail',{ticket:'ERT-1'}),tool('shared_repo','repository_read',{path:'task.ts'}),
    tool('shared_status','controller_status',{ticket:'ERT-1'}),tool('shared_memory','recall_learning',{}),
    tool('shared_denied','ticket_detail',{project:'birdup',ticket:'BIRD-1'})];
   else{
    expect([2,4]).toContain(providerCalls);expect(JSON.stringify(body.messages)).toContain('Acceptance criteria:');
    expect(JSON.stringify(body.messages)).toContain('baseline');expect(JSON.stringify(body.messages)).not.toContain('uncommitted fixture text');
    if(providerCalls===4)expect(JSON.stringify(body)).not.toContain('Owner-private fixture note alpha.');
    content=[{type:'text',text:providerCalls===2?'Private fixture answer.':'Shared fixture answer.'}];
   }
   return Response.json({id:'fixture'+providerCalls,type:'message',role:'assistant',model:'deepseek-v4-pro',content,
    stop_reason:providerCalls%2?'tool_use':'end_turn',usage:{input_tokens:80,output_tokens:30,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
  }) as typeof fetch,
  launch:async(m,handle)=>{
   launches++;const names=m.tools.map(t=>t.function.name);
   for(const name of ['ticket_detail','repository_read','controller_status'])expect(names).toContain(name);
   expect(names.includes('controller_handoff')).toBe(launches===1);
   if(launches===2)expect(m.systemPrompt).not.toContain('Owner-private fixture note alpha.');
   const history:any[]=[...(m.history??[]),{role:'user',content:m.prompt}];
   const rpc=(path:string,value:unknown)=>handle(new Request('http://127.0.0.1'+path,{method:'POST',headers:{authorization:'Bearer '+m.capability,'content-type':'application/json'},body:JSON.stringify(value)}));
   for(let i=0;i<2;i++){
    const response=await rpc('/v1/chat/completions',{model:m.model,messages:[{role:'system',content:m.systemPrompt},...history],max_tokens:m.maxTokens,temperature:m.temperature,tools:m.tools,stream:false});
    expect(response.ok).toBe(true);const message=(await response.json() as any).choices[0].message;history.push(message);
    for(const call of message.tool_calls??[]){
     const result:any=await(await rpc('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,callId:call.id,name:call.function.name,arguments:JSON.parse(call.function.arguments)})).json();
     receipts[call.id]=JSON.parse(result.content);history.push({role:'tool',tool_call_id:call.id,content:result.content});
    }
   }
   return{taskId:m.taskId,requestId:m.requestId,status:'no_finish',publicationApproved:false,history};
  },runLoop:async args=>{
   wake=args.wake;expect(wake).toBeDefined();expect(wake!.request()).toBe(false);
   expect({providerCalls,detailCalls,commentCalls,launches}).toEqual({providerCalls:0,detailCalls:0,commentCalls:0,launches:0});
   // Existing DM delivery binds the private channel, as in the deployed store.
   // This is fixture evidence only; startup must not send another ready notice.
   db.query(`INSERT INTO gary_slack_outbox(delivery_key,kind,request_id,app_id,team_id,bot_user_id,recipient_id,
     content_sha256,target_channel,claim_id,claimed_at,status,slack_channel,slack_ts) VALUES(?,'ready',?,?,?,?,?,?,'U0A9M5W16F8','fixture','2026-10-10T00:00:00Z','sent','D0FIXTURE1','1791452000.000000')`)
     .run(`ready:${GARY_SLACK.readyRequest}:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${GARY_SLACK.tannerId}`,
       GARY_SLACK.readyRequest,GARY_SLACK.appId,GARY_SLACK.teamId,GARY_SLACK.botUserId,GARY_SLACK.tannerId,'0'.repeat(64));
   await runExistingLoop({...args,intervalMs:60_000,onTickComplete:async result=>{
    await args.onTickComplete?.(result);polls++;
    if(polls===1){await emit(true);expect(receipts.private_handoff).toMatchObject({ok:true,data:{status:'reconsideration_requested'}});}
    else{
     await emit(false);await emit(true); // Redelivery does not rerun model, tools or wake.
     expect(db.query("SELECT count(*) n FROM events WHERE event_type='conversation_controller_handoff'").get()).toEqual({n:1});
     expect(db.query('SELECT count(*) n FROM actions').get()).toEqual({n:0});
     expect(ledger.status(issueId)).toMatchObject({state:'active',attemptCount:0,chargedMicros:0});
     expect(ledger.status('local:hermes-dm-20261008-tanner')).toMatchObject({attemptCount:2,unknownAttempts:0});
     expect(ledger.status('local:hermes-shared-20261008')).toMatchObject({attemptCount:2,unknownAttempts:0});
     stop.abort();expect(wake!.request()).toBe(false);
    }
   }});
  }});}finally{clearTimeout(timer);stop.abort();}
 expect({polls,launches,providerCalls,detailCalls,commentCalls,network:f.networkCalls()}).toEqual({polls:2,launches:2,providerCalls:4,detailCalls:2,commentCalls:2,network:0});
 expect(sent).toEqual([{channel:'D0FIXTURE1',text:'Private fixture answer.'},{channel:'C0CHANNEL1',text:'Shared fixture answer.'}]);
 expect(receipts.private_ticket).toMatchObject({ok:true,data:{ticket:'ERT-1',description:{text:ticket.description},comments:[{text:'Keep the acceptance criteria intact.'}]}});
 expect(receipts.private_repo).toMatchObject({ok:true,data:{source:'local_committed_git',revision:f.activation.policy.baseCommit,text:'baseline\n',uncommittedChangesIncluded:false}});
 expect(receipts.private_status).toMatchObject({ok:true,data:{runtime:{loopState:'polling',dispatchReady:true},items:[{ticket:'ERT-1',workerState:'not_observed',admission:{handoffEligible:true}}]}});
 expect(receipts.shared_memory).toMatchObject({ok:true,data:{scopeRecordCount:0}});expect(receipts.shared_denied).toMatchObject({ok:false,error:'project_denied'});
 expect(wake!.request()).toBe(false);expect(f.stats().stopped).toBe(true);
});

function engineeringStartupFixture(continuation = false) {
  const f=slackFixture(),root=join(f.root,'engineering'),workspacesRoot=join(f.root,'engineering-workspaces'),dmDir=join(f.root,'private-dm');
  mkdirSync(root,{mode:0o700});mkdirSync(workspacesRoot,{mode:0o700});mkdirSync(dmDir,{mode:0o700});mkdirSync(f.config.gary.stateDir,{mode:0o700});
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  const dmPath=join(dmDir,'config.json');
  writeFileSync(dmPath,JSON.stringify({version:1,runId:'hermes-dm-20261008',campaignId:'hermes-dm-20261008',allocationId:'local:hermes-dm-20261008-tanner'}),{mode:0o600});
  const runtimeFiles=['gary_engineering_runtime.py','gary_engineering_environment.py'].map(name=>{const path=join(root,name);writeFileSync(path,'# offline fixture\n',{mode:0o600});return{path,sha256:hash('# offline fixture\n')};});
  const resourceLock={path:'/private/tmp/apple-release-xcode.lock',dev:16777232,ino:176033673,uid:501,mode:0o644,nlink:1,
    bootSessionUUID:'02D97A38-83D2-457D-967F-A01481D5EEFC',apfsVolumeUUID:'7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697'};
  const config:EngineeringRuntimeConfig={resourceLock,version:1,grantId:'grant',allocationId:'allocation',campaignId:'campaign',root,workspacesRoot,repository:'707-Labs/fixture',baseBranch:'main',baseCommit:'a'.repeat(40),
    allowedFiles:['src/fixture.ts'],requiredCommands:['bun test test/fixture.test.ts'],deadlineMs:1800000,
    workerImage:'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',executorImage:'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c',
    bunCacheVolume:'gary-bun-cache-20261010-mulligan-4bb2fdde-v2',dockerExecutable:'/usr/local/bin/docker',dockerSocketPath:'/Users/tanner/.colima/default/docker.sock',runtimeFiles,
    sourceRevision:'c'.repeat(40),publication:'patch_only',capMicros:5650000,budget:{aggregatePath:join(f.root,'aggregate.json'),auditDir:join(root,'budget-admission'),runId:'grant'}};
  const authority:EngineeringAuthorityReceipt={version:1,grantId:'grant',sourceThreadId:'01a0fa90-833c-71cc-907b-0b3fc0e1b02d',assistantMessageId:'Sentinel_668b96adaca8819199844e4bbb4f2971',
    userMessageId:'Sentinel_c0289b9b991c81918b40e3a04e870894',userApproval:'yes approve go ahead',requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',capMicros:5650000,
    scope:'707-Labs-existing-app-isolated-engineering',mergeAllowed:false,deploymentAllowed:false};
  if(continuation){
    const original={aggregatePath:config.budget.aggregatePath,ledgerPath:join(f.config.gary.stateDir,'spend.db'),auditDir:join(f.root,'predecessor','budget-admission'),
      grantId:'gary-native-engineering-20261010-01',runId:'gary-native-engineering-20261010-01',
      campaignId:'gary-native-engineering-20261010-01-campaign',allocationId:'gary-native-engineering-20261010-01-allocation',
      sourceRevision:'9b8b31e7a876e320432e6aead61d5cc5902ad587',runtimeConfigSha256:'cd5324697e222dd9f8e5bca88a7cd1a5795bb584e9048366f6c5919aeae9656d',
      authoritySha256:'883f2b010ddcf6e18793cb95aa1a921e0e6b2403a7b4cf0a77c336cff0724645'};
    config.grantId='gary-native-engineering-20261010-02';authority.grantId=config.grantId;
    config.campaignId=original.campaignId;config.allocationId=original.allocationId;
    config.budget={...config.budget,runId:config.grantId,continuation:{version:1,original,
      predecessorJournalPath:join(f.root,'predecessor','engineering.sqlite'),predecessorTaskId:'engineering-1683fa3a-bde9-4d73-b000-f84f88d67b4a',
      receiptPath:join(config.budget.auditDir,'continuation.json')}};
  }
  const configPath=join(root,'config.json'),authorityPath=join(root,'authority.json');
  writeFileSync(configPath,JSON.stringify(config),{mode:0o600});writeFileSync(authorityPath,JSON.stringify(authority),{mode:0o600});
  const ledger=new SpendLedger(join(f.config.gary.stateDir,'spend.db'));
  ledger.createCampaign('hermes-dm-20261008',5);ledger.enrollTicket('hermes-dm-20261008','local:hermes-dm-20261008-tanner',5);
  ledger.createCampaign(config.campaignId,5.65);ledger.enrollTicket(config.campaignId,config.allocationId,5.65);
  f.config.github={kind:'app',appId:'1',installationId:'2',privateKey:'fake-app-key',username:'fixture'};
  const env={...f.env,GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),GARY_SLACK_TANNER_DM_ENABLED:'1',GARY_SLACK_CONVERSATION_CONFIG:dmPath,
    GARY_ENGINEERING_CONFIG:configPath,GARY_ENGINEERING_CONFIG_SHA256:hash(JSON.stringify(config)),GARY_ENGINEERING_AUTHORITY_RECEIPT:authorityPath,GARY_ENGINEERING_AUTHORITY_RECEIPT_SHA256:hash(JSON.stringify(authority))};
  const budgets:boolean[]=[],order:string[]=[];let opts:EngineeringRuntimeOptions|undefined,busy=false,starts=0;
  const continuationChecks:boolean[]=[];let baselineChecks=0,continuationRevoked=false;
  const baseline={baselineAttemptCount:1,baselineChargedMicros:10,receiptSha256:'d'.repeat(64),
    assertCurrent(){baselineChecks++;if(continuationRevoked)throw Error('fixture_continuation_revoked');},assertPrefix(){},assertJournal(){}} as unknown as EngineeringContinuationBaseline;
  const receipts=new Set<string>();let latest:EngineeringReceipt|undefined;
  const originalClose=ledger.close.bind(ledger);ledger.close=()=>{order.push('ledger');originalClose();};
  const deps:StartupDependencies={...f.deps,env,verifyConversationRelease:()=>{},ledger:()=>ledger,slackTransport:()=>f.transport,
    github:()=>({engineeringInstallationCredential:async()=>{throw new Error('unexpected app request');}} as unknown as GitHubClient),
    engineering:{assertBudget:(binding,input)=>{budgets.push(input?.requireUnused===true);expect(binding).toMatchObject({grantId:'grant',campaignId:'campaign',allocationId:'allocation',ledgerPath:join(f.config.gary.stateDir,'spend.db'),runtimeConfigSha256:env.GARY_ENGINEERING_CONFIG_SHA256});
      if(continuation)throw Error('continuation_must_not_reenroll');
      return{holdId:'fixture',capMicros:5650000,aggregateCurrentSha256:'a'.repeat(64),runtimeHeldUsd:'5.650000000',runtimeUnallocatedUsd:'1.047006994',runtimeUnearmarkedUsd:'1.047006994',status:ledger.status('allocation')!};},
      assertContinuation:(binding,input)=>{continuationChecks.push(input?.requireUnused===true);
        expect(binding).toMatchObject({grantId:config.grantId,campaignId:config.campaignId,allocationId:config.allocationId,root,workspacesRoot,
          ledgerPath:join(f.config.gary.stateDir,'spend.db'),continuation:config.budget.continuation});
        if(continuationRevoked)throw Error('fixture_continuation_revoked');return baseline;},
      createRuntime:options=>{
        opts=options;expect(options.journalDb.filename).toBe(join(root,'engineering.sqlite'));expect(lstatSync(options.journalDb.filename).mode&0o777).toBe(0o600);
        expect(()=>options.spendDb.exec('CREATE TABLE forbidden(value)')).toThrow();expect(options.repository.binding).toEqual({appId:1,installationId:2});
        options.assertGrant();options.assertRuntime();let stopped:Promise<void>|undefined;
        return{ready:()=>true,busy:()=>busy,stop:()=>stopped??=(async()=>{expect(options.journalDb.query('SELECT 1').get()).toBeDefined();expect(options.spendDb.query('SELECT 1').get()).toBeDefined();order.push('engineering');})(),
          ingress:{async admit(request,_signal,available){expect(available()).toBe(true);options.assertBudget();busy=true;
            latest={requestId:request.requestId,taskId:'engineering-fixture',receiptId:'receipt:ack',phase:'admitted',status:'running',text:'Engineering task admitted.'};receipts.add(JSON.stringify(latest));return latest;},
            verifyReceipt:receipt=>receipts.has(JSON.stringify(receipt)),start(){starts++;}}};
      }}};
  return{...f,root,engineeringConfig:config,configPath,authorityPath,env,deps,ledger,budgets,order,baseline,continuationChecks,
    baselineChecks:()=>baselineChecks,revokeContinuation(){continuationRevoked=true;},get opts(){return opts;},get starts(){return starts;},setBusy(value:boolean){busy=value;},
    final(){const value:EngineeringReceipt={...latest!,receiptId:'receipt:final',phase:'final',status:'completed',text:'Verified engineering result.'};receipts.add(JSON.stringify(value));return value;}};
}

test('engineering startup binds private stores, signed config, App route, Slack receipts and dispatch lifetime',async()=>{
  const f=engineeringStartupFixture();let receive:Parameters<SlackTransport['start']>[0]=()=>{};
  const originalStart=f.transport.start;f.transport.start=async(handler,signal)=>{receive=handler;await originalStart(handler,signal);};
  const posts:string[]=[];f.transport.sendMessage=async(input)=>{posts.push(input.text);return{ok:true,channel:input.channel,ts:'1791676800.000010'};};
  await main({...f.deps,runLoop:async args=>{
    expect(f.budgets).toEqual([false,false]);expect(args.beginDispatch).toBeDefined();
    const release=args.beginDispatch!();expect(release).toBeFunction();expect(()=>f.opts!.assertBudget()).toThrow('engineering_host_dispatch_busy');release!();release!();
    f.opts!.assertBudget();expect(f.budgets).toEqual([false,false,true]);
    args.db.query(`INSERT INTO gary_slack_outbox(delivery_key,kind,request_id,app_id,team_id,bot_user_id,recipient_id,target_channel,content_sha256,claim_id,status,claimed_at,slack_channel)
      VALUES(?,'ready','fixture',?,?,?,?,?,'fixture','fixture','sent','fixture',?)`).run(`ready:${GARY_SLACK.readyRequest}:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${GARY_SLACK.tannerId}`,
      GARY_SLACK.appId,GARY_SLACK.teamId,GARY_SLACK.botUserId,GARY_SLACK.tannerId,'D0FIXTURE1','D0FIXTURE1');
    const seconds=Math.floor(Date.now()/1000),ts=`${seconds}.000001`;
    const envelope={type:'events_api',envelope_id:'offline-engineering-startup',payload:{type:'event_callback',api_app_id:GARY_SLACK.appId,team_id:GARY_SLACK.teamId,event_id:'EvEngineering1',event_time:seconds,is_ext_shared_channel:false,
      event:{type:'message',channel:'D0FIXTURE1',channel_type:'im',user:GARY_SLACK.tannerId,ts,event_ts:ts,text:'!engineer 707-Labs/fixture Make the scoped edit.'}}};
    await receive(envelope,{rawBytes:Buffer.byteLength(JSON.stringify(envelope))});
    expect(f.starts).toBe(1);expect(posts).toEqual(['Engineering task admitted.']);expect(args.beginDispatch!()).toBeNull();
    const ordinary=structuredClone(envelope);ordinary.payload.event_id='EvOrdinaryWhileBusy';ordinary.payload.event.text='ordinary chat while engineering runs';ordinary.payload.event.ts=`${seconds}.000002`;
    await receive(ordinary,{rawBytes:Buffer.byteLength(JSON.stringify(ordinary))});
    expect(f.ledger.status('local:hermes-dm-20261008-tanner')?.attemptCount).toBe(0);expect(f.networkCalls()).toBe(0);
    // Final delivery is independently authorized while ordinary chat admission remains paused.
    expect(await f.opts!.deliver(f.final())).toBe('sent');expect(posts).toHaveLength(2);
    f.setBusy(false);const next=args.beginDispatch!();expect(next).toBeFunction();next!();
    expect(f.ledger.status('allocation')?.attemptCount).toBe(0);
  }});
  expect(f.order).toEqual(['engineering','ledger']);expect(()=>f.opts!.journalDb.query('SELECT 1').get()).toThrow();expect(()=>f.opts!.spendDb.query('SELECT 1').get()).toThrow();
  expect(f.networkCalls()).toBe(0);
});

test('engineering startup rejects source, App and budget mismatches before ingress or execution',async()=>{
  for(const mode of ['source','app','budget'] as const){
    const f=engineeringStartupFixture();let factories=0,polls=0;
    const deps={...f.deps,engineering:{...f.deps.engineering,createRuntime:()=>{factories++;throw Error('must not execute');}}};
    if(mode==='source')deps.env={...f.env,GARY_CONVERSATION_RUNTIME_RELEASE:'d'.repeat(40)};
    if(mode==='app')f.config.github={kind:'pat',token:'fixture-only',username:'fixture'};
    if(mode==='budget')deps.engineering.assertBudget=()=>{throw new Error('fixture_budget_missing');};
    await expect(main({...deps,runLoop:async()=>{polls++;}})).rejects.toThrow();
    expect(factories).toBe(0);expect(polls).toBe(0);expect(f.stats().started).toBe(false);expect(f.networkCalls()).toBe(0);
    if(mode!=='budget')f.ledger.close();
  }
});

test('engineering continuation startup reuses an asserted baseline and rechecks unused continuation only at admission',async()=>{
  const f=engineeringStartupFixture(true);
  await main({...f.deps,runLoop:async args=>{
    expect(f.opts!.continuationBaseline).toBe(f.baseline);expect(f.budgets).toEqual([]);
    expect(f.continuationChecks).toEqual([false]);expect(f.baselineChecks()).toBe(1);
    f.opts!.assertGrant();expect(f.baselineChecks()).toBe(2);expect(f.continuationChecks).toEqual([false]);
    const release=args.beginDispatch!();expect(release).toBeFunction();
    expect(()=>f.opts!.assertBudget()).toThrow('engineering_host_dispatch_busy');expect(f.continuationChecks).toEqual([false]);release!();
    f.opts!.assertBudget();expect(f.continuationChecks).toEqual([false,true]);
    f.revokeContinuation();expect(()=>f.opts!.assertGrant()).toThrow('fixture_continuation_revoked');
    expect(()=>f.opts!.assertBudget()).toThrow('fixture_continuation_revoked');
    expect(f.ledger.status(f.engineeringConfig.allocationId)?.attemptCount).toBe(0);
  }});
  expect(f.budgets).toEqual([]);expect(f.networkCalls()).toBe(0);expect(f.order).toEqual(['engineering','ledger']);
});

test('engineering continuation rejects another ledger or invalid admission before opening its journal or ingress',async()=>{
  for(const mode of ['ledger','receipt'] as const){
    const f=engineeringStartupFixture(true);let factories=0,polls=0;
    const deps={...f.deps,engineering:{...f.deps.engineering,createRuntime:()=>{factories++;throw Error('must not execute');}}};
    if(mode==='ledger'){
      const config=structuredClone(f.engineeringConfig);config.budget.continuation!.original.ledgerPath=join(f.config.gary.stateDir+'-other','spend.db');
      const raw=JSON.stringify(config);writeFileSync(f.configPath,raw,{mode:0o600});
      deps.env={...f.env,GARY_ENGINEERING_CONFIG_SHA256:createHash('sha256').update(raw).digest('hex')};
    }else f.revokeContinuation();
    await expect(main({...deps,runLoop:async()=>{polls++;}})).rejects.toThrow(mode==='ledger'?'engineering_continuation_ledger_mismatch':'fixture_continuation_revoked');
    expect(factories).toBe(0);expect(polls).toBe(0);expect(f.stats().started).toBe(false);expect(f.budgets).toEqual([]);expect(f.networkCalls()).toBe(0);
    expect(()=>lstatSync(join(f.root,'engineering.sqlite'))).toThrow();
  }
});

/** Real config/funding/conversation composition, with only external execution mocked. */
function standingStartupFixture(enroll=true) {
  const f=engineeringStartupFixture(),hash=(text:string)=>createHash('sha256').update(text).digest('hex');
  const write=(path:string,value:unknown)=>{const text=JSON.stringify(value);writeFileSync(path,text,{mode:0o600});return hash(text);};
  const projectDir=join(f.root,'..','standing-projects');mkdirSync(projectDir,{mode:0o700});
  const projectPath=join(projectDir,'config.json'),projectSha=write(projectPath,{version:1,teamId:GARY_SLACK.teamId,ownerUserId:GARY_SLACK.tannerId,
    memoryPath:join(projectDir,'project-memory.sqlite'),projects:[{id:'gary-role',repo:'707-Labs/gary',teamKey:'GARY',label:'Gary',summary:'Synthetic context only.',sharedChannelIds:[]}]});
  const authoritySha=write(f.authorityPath,{version:1,kind:'standing_engineering_authority',grantId:'standing-grant',requesterId:GARY_SLACK.tannerId,teamId:GARY_SLACK.teamId,
    sourceThreadId:'offline-startup-fixture',userApprovalEvidenceSha256:'a'.repeat(64),scope:'707-Labs-existing-app-isolated-engineering',ordinaryOwnerDMTasks:true,mergeAllowed:false,deploymentAllowed:false});
  const aggregatePath=join(f.root,'aggregate.json'),fundingAuthorityPath=join(f.root,'funding.json'),fundingHoldReceiptPath=join(f.root,'hold.json');
  const ledgerPath=join(f.config.gary.stateDir,'spend.db');
  const funding={version:1 as const,poolId:'standing-engineering-startup',campaignId:'standing-engineering-startup-campaign',capMicros:6_000_000,taskCapMicros:3_000_000,
    authoritySha256:'',holdReceiptSha256:''};
  funding.authoritySha256=write(fundingAuthorityPath,{version:1,kind:'standing_engineering_funding',approved:true,poolId:funding.poolId,campaignId:funding.campaignId,
    capMicros:funding.capMicros,taskCapMicros:funding.taskCapMicros,aggregatePath,ledgerPath,approvalEvidenceSha256:'b'.repeat(64),aggregateBeforeRuntimePoolMicros:60_000_000,additionalRuntimePoolMicros:0});
  const before={schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,runtimeCommittedOrHeldUsd:50,runtimeUnallocatedUsd:10,
    totalCommittedOrHeldUsd:90,runtimeUnknownHoldsUsd:4.5,runtimeAuthorizationRetiredUsd:0,runtimeAllocations:[{id:'historical',amountUsd:50,retainedAmountUsd:50,
      retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:4.5,admission:{kind:'classifier_canary',commonfieldEarmarkMicros:3000000}}]};
  const beforePath=join(f.root,'funding-before.json'),beforeSha=write(beforePath,before);
  const hold={id:'standing-engineering:'+funding.poolId,amountUsd:6,state:'held_for_standing_engineering',retainedAmountUsd:6,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0,
    admission:{kind:'standing_engineering',poolId:funding.poolId,campaignId:funding.campaignId,capMicros:funding.capMicros,taskCapMicros:funding.taskCapMicros,
      authoritySha256:funding.authoritySha256,ledgerPath,auditRecord:fundingHoldReceiptPath,aggregateBeforeSha256:beforeSha}};
  const after={...before,runtimeAllocations:[...before.runtimeAllocations,hold],runtimeCommittedOrHeldUsd:56,runtimeUnallocatedUsd:4,totalCommittedOrHeldUsd:96,bookkeepingUpdatedAt:'2026-10-11T01:00:00Z'};
  const afterPath=join(f.root,'funding-after.json'),afterSha=write(afterPath,after);write(aggregatePath,after);
  funding.holdReceiptSha256=write(fundingHoldReceiptPath,{version:1,kind:'standing_engineering_hold',poolId:funding.poolId,campaignId:funding.campaignId,
    capMicros:funding.capMicros,taskCapMicros:funding.taskCapMicros,authoritySha256:funding.authoritySha256,aggregatePath,ledgerPath,
    before:{path:beforePath,sha256:beforeSha},after:{path:afterPath,sha256:afterSha},aggregateBeforeRuntimePoolMicros:60_000_000,additionalRuntimePoolMicros:0});
  const old=f.engineeringConfig;
  const config:StandingEngineeringRuntimeConfig={version:1,kind:'standing_engineering',grantId:'standing-grant',sourceRevision:old.sourceRevision,authoritySha256:authoritySha,
    requesterId:GARY_SLACK.tannerId,teamId:GARY_SLACK.teamId,organization:'707-Labs',surface:'private_dm',repositoryAccess:'current_existing_github_app',
    root:old.root,workspacesRoot:old.workspacesRoot,deadlineMs:old.deadlineMs,workerImage:ENGINEERING_WORKER_IMAGE,executorImage:old.executorImage,bunCacheVolume:old.bunCacheVolume,
    dockerExecutable:old.dockerExecutable,dockerSocketPath:old.dockerSocketPath,runtimeFiles:[...old.runtimeFiles],resourceLock:old.resourceLock!,
    funding,fundingAuthorityPath,fundingHoldReceiptPath,aggregatePath,publication:'patch_only',mergeAllowed:false,deploymentAllowed:false};
  const configSha=write(f.configPath,config);
  const {GARY_ENGINEERING_CONFIG:_config,GARY_ENGINEERING_CONFIG_SHA256:_sha,GARY_ENGINEERING_AUTHORITY_RECEIPT:_authority,
    GARY_ENGINEERING_AUTHORITY_RECEIPT_SHA256:_authoritySha,...prior}=f.env;
  const env={...prior,GARY_STANDING_ENGINEERING_CONFIG:f.configPath,GARY_STANDING_ENGINEERING_CONFIG_SHA256:configSha,
    GARY_STANDING_ENGINEERING_AUTHORITY:f.authorityPath,GARY_STANDING_ENGINEERING_AUTHORITY_SHA256:authoritySha,
    GARY_PROJECT_ASSISTANT_CONFIG:projectPath,GARY_PROJECT_ASSISTANT_CONFIG_SHA256:projectSha};
  if(enroll){const pool=createStandingEngineeringBudget({ledger:f.ledger,authority:funding,
    assertAuthority:createStandingEngineeringFundingGuard({authority:funding,fundingAuthorityPath,fundingHoldReceiptPath,aggregatePath,ledgerPath})});pool.enrollPool();pool.close();}
  f.ledger.markTerminal(old.allocationId,'historical_acceptance_closed');
  f.ledger.createCampaign('historical-ert',5.65);f.ledger.enrollTicket('historical-ert',issueId,5.65);f.ledger.markTerminal(issueId,'historical_ert_closed');
  let options:EngineeringRuntimeOptions|undefined,busy=false,starts=0,admissions=0,runtimeFactories=0;
  const receipts=new Set<string>();
  const deps:StartupDependencies={...f.deps,env,engineering:{createRuntime:value=>{
    runtimeFactories++;options=value;expect(value.standing).toBeDefined();expect(value.continuationBaseline).toBeUndefined();value.assertGrant();value.assertBudget();
    return{ready:()=>true,busy:()=>busy,async stop(){},ingress:{async admit(request,_signal,available){
      expect(available()).toBeTrue();value.assertBudget();expect(request.repository).toBe('707-Labs/unregistered-app');
      expect(request.task).toBe('Fix the login bug in 707-Labs/unregistered-app');
      value.standing!.budget.allocate({requestId:request.requestId,requestHash:hash(JSON.stringify(request)),taskId:'standing-startup-task'});
      busy=true;admissions++;const receipt:EngineeringReceipt={requestId:request.requestId,taskId:'standing-startup-task',receiptId:'standing-startup-admission',phase:'admitted',status:'queued',text:'Task queued.'};
      receipts.add(JSON.stringify(receipt));return receipt;},verifyReceipt:r=>receipts.has(JSON.stringify(r)),start(receipt){
        expect(receipts.has(JSON.stringify(receipt))).toBeTrue();value.assertExecutionReady!();starts++;
      }}};
  }}};
  return{...f,deps,env,standingConfig:config,get options(){return options;},counts:()=>({starts,admissions,runtimeFactories})};
}

test('standing startup never autoenrolls or ignores missing funding before ingress',async()=>{
  for(const mode of ['not_enrolled','missing_hold'] as const){
    const f=standingStartupFixture(false);if(mode==='missing_hold')rmSync(f.standingConfig.fundingHoldReceiptPath);
    let polls=0;await expect(main({...f.deps,runLoop:async()=>{polls++;}})).rejects.toThrow();
    expect(f.counts()).toEqual({starts:0,admissions:0,runtimeFactories:0});expect(polls).toBe(0);expect(f.stats().started).toBeFalse();
    const db=new Database(join(f.config.gary.stateDir,'spend.db'),{readonly:true});
    expect(db.query("SELECT 1 FROM spend_campaigns WHERE id=?").get(f.standingConfig.funding.campaignId)).toBeNull();
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name='standing_engineering_pools'").get()).toBeNull();db.close();
    expect(f.networkCalls()).toBe(0);
  }
});

test('standing startup admits beyond closed ERT history and drains both preexisting conversations before engineering start',async()=>{
  const f=standingStartupFixture(),deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
  const firstEntered=deferred(),firstRelease=deferred(),secondEntered=deferred(),secondRelease=deferred();
  let receive:Parameters<SlackTransport['start']>[0]=()=>{},launches=0,providerCalls=0;const posts:string[]=[];
  const originalStart=f.transport.start;f.transport.start=async(handler,signal)=>{receive=handler;await originalStart(handler,signal);};
  f.transport.sendMessage=async input=>{posts.push(input.text);return{ok:true,channel:input.channel,ts:'1791452000.000010'};};
  const modelReply=(content:unknown[])=>Response.json({id:'standing-fixture-'+providerCalls,type:'message',role:'assistant',model:'deepseek-v4-pro',content,
    stop_reason:providerCalls===1?'tool_use':'end_turn',usage:{input_tokens:30,output_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
  await main({...f.deps,fetch:(async()=>{providerCalls++;return modelReply(providerCalls===1
    ?[{type:'tool_use',id:'submit_task',name:'engineering_submit',input:{repository:'707-Labs/unregistered-app'}}]
    :[{type:'text',text:providerCalls===2?'Your task is queued.':'Second conversation complete.'}]);}) as unknown as typeof fetch,
    launch:async(m,handle)=>{
      launches++;const ordinal=launches;expect(m.tools.some(t=>t.function.name==='engineering_submit')).toBeTrue();
      if(ordinal===1){firstEntered.resolve();await firstRelease.promise;}else{secondEntered.resolve();await secondRelease.promise;}
      const history:any[]=[...(m.history??[]),{role:'user',content:m.prompt}];
      const rpc=(path:string,value:unknown)=>handle(new Request('http://127.0.0.1'+path,{method:'POST',headers:{authorization:'Bearer '+m.capability,'content-type':'application/json'},body:JSON.stringify(value)}));
      for(let i=0;i<(ordinal===1?2:1);i++){
        const reply=await rpc('/v1/chat/completions',{model:m.model,messages:[{role:'system',content:m.systemPrompt},...history],max_tokens:m.maxTokens,temperature:m.temperature,tools:m.tools,stream:false});
        expect(reply.ok).toBeTrue();const message=(await reply.json() as any).choices[0].message;history.push(message);
        for(const call of message.tool_calls??[]){const result:any=await(await rpc('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,
          callId:call.id,name:call.function.name,arguments:JSON.parse(call.function.arguments)})).json();expect(JSON.parse(result.content).ok).toBeTrue();history.push({role:'tool',tool_call_id:call.id,content:result.content});}
      }
      return{taskId:m.taskId,requestId:m.requestId,status:'no_finish',publicationApproved:false,history};
    },runLoop:async args=>{
      upsertTicket(args.db,{linearId:issueId,identifier:'ERT-3434'});expect(args.spend!.status(issueId)?.terminalReason).toBe('historical_ert_closed');
      expect(f.options!.standing!.budget.status()).toMatchObject({enrolled:true,committedCapMicros:0});
      args.db.query(`INSERT INTO gary_slack_outbox(delivery_key,kind,request_id,app_id,team_id,bot_user_id,recipient_id,target_channel,content_sha256,claim_id,status,claimed_at,slack_channel)
        VALUES(?,'ready','fixture',?,?,?,?,?,'fixture','fixture','sent','fixture',?)`).run(`ready:${GARY_SLACK.readyRequest}:${GARY_SLACK.appId}:${GARY_SLACK.teamId}:${GARY_SLACK.tannerId}`,
          GARY_SLACK.appId,GARY_SLACK.teamId,GARY_SLACK.botUserId,GARY_SLACK.tannerId,'D0FIXTURE1','D0FIXTURE1');
      const emit=(n:number,text:string)=>Promise.resolve(receive({type:'events_api',payload:{type:'event_callback',api_app_id:GARY_SLACK.appId,team_id:GARY_SLACK.teamId,event_id:'EvStanding'+n,
        event:{type:'message',channel:'D0FIXTURE1',channel_type:'im',user:GARY_SLACK.tannerId,ts:'1791452100.00000'+n,text}}}));
      const first=emit(1,'Fix the login bug in 707-Labs/unregistered-app');await firstEntered.promise;
      const second=emit(2,'How are you doing?');
      const context=new Database(join(f.env.GARY_SLACK_CONVERSATION_CONFIG,'..','context.sqlite'),{readonly:true});
      for(let tries=0;tries<100&&(context.query('SELECT count(*) n FROM events').get() as any).n!==2;tries++)await new Promise<void>(r=>setImmediate(r));
      expect((context.query('SELECT count(*) n FROM events').get() as any).n).toBe(2);context.close();
      firstRelease.resolve();await secondEntered.promise;await first;
      expect(f.counts()).toEqual({runtimeFactories:1,admissions:1,starts:0});
      expect(()=>f.options!.assertExecutionReady!()).toThrow('standing_engineering_conversation_not_drained');
      expect(args.beginDispatch!()).toBeNull();await emit(3,'Another message while busy');expect(launches).toBe(2);
      secondRelease.resolve();await second;expect(f.counts()).toEqual({runtimeFactories:1,admissions:1,starts:1});
      expect(f.options!.standing!.budget.status()).toMatchObject({committedCapMicros:3_000_000,uncommittedCapMicros:3_000_000});
      expect(args.spend!.status(issueId)?.terminalReason).toBe('historical_ert_closed');
      expect(args.spend!.status('allocation')?.terminalReason).toBe('historical_acceptance_closed');
    }});
  expect(providerCalls).toBe(3);expect(posts).toEqual(['Your task is queued.','Second conversation complete.']);expect(f.networkCalls()).toBe(0);
},15_000);


function routineStartupFixture(enroll = true) {
  const f = standingStartupFixture(enroll), scopedRoot = join(realpathSync(join(f.root, '..')), 'routine-scoped'); mkdirSync(scopedRoot, { mode: 0o700 });
  const integrityKeyPath = join(f.standingConfig.root, 'routine-key'); writeFileSync(integrityKeyPath, 'r'.repeat(32), { mode: 0o600 });
  const extra = join(f.standingConfig.root, 'gary_engineering_task_tools.py'); writeFileSync(extra, '# fixture task tools', { mode: 0o600 });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const config = { ...f.standingConfig, deadlineMs: 150 * 60_000,
    runtimeFiles: [...f.standingConfig.runtimeFiles, { path: extra, sha256: hash('# fixture task tools') }],
    routine: { version: 1 as const, toolsProfileSha256: ENGINEERING_ROUTINE_TOOLS_SHA256, scopedRoot, integrityKeyPath,
      integrityKeySha256: hash('r'.repeat(32)), dependencyDownloads: true as const, allowLifecycleScripts: false } as const };
  const bytes = JSON.stringify(config); writeFileSync(f.configPath, bytes, { mode: 0o600 });
  const env = { ...f.env, GARY_STANDING_ENGINEERING_CONFIG_SHA256: hash(bytes) };
  return { ...f, routineConfig: config, deps: { ...f.deps, env } };
}

test('routine startup owns scoped persistence and closes it only after engineering drain', async () => {
  const f = routineStartupFixture(), order: string[] = [];
  let service: ReturnType<typeof openEngineeringRoutineServices> | undefined;
  await main({ ...f.deps, engineering: { ...f.deps.engineering,
    createRoutine(input) { service = openEngineeringRoutineServices(input); const base = service;
      return { ...base, close() { order.push('scoped_close'); base.close(); } }; },
    createRuntime(input) {
      expect(input.routine).toBeDefined(); expect(input.config.deadlineMs).toBe(150 * 60_000);
      expect('routine' in input.config && input.config.routine).toEqual(f.routineConfig.routine);
      const runtime = f.deps.engineering!.createRuntime!(input);
      return { ...runtime, async stop() { order.push('engineering_drained'); await runtime.stop(); } };
    },
  }, runLoop: async () => { expect(service).toBeDefined(); service!.assertCurrent(); } });
  expect(order.at(-1)).toBe('scoped_close'); expect(order.slice(0, -1).every(value => value === 'engineering_drained')).toBeTrue();
  expect(() => service!.assertCurrent()).toThrow('closed'); expect(f.networkCalls()).toBe(0);
});

test('routine startup cannot open scoped services before standing funding is enrolled', async () => {
  const f = routineStartupFixture(false); let opened = 0;
  await expect(main({ ...f.deps, engineering: { ...f.deps.engineering, createRoutine(input) { opened++; return openEngineeringRoutineServices(input); } },
    runLoop: async () => { throw Error('unexpected loop'); } })).rejects.toThrow('funding_not_enrolled');
  expect(opened).toBe(0); expect(f.networkCalls()).toBe(0);
});

test('routine startup retains private and canonical handles when physical cleanup is unknown', async () => {
  const f = routineStartupFixture();
  let service: ReturnType<typeof openEngineeringRoutineServices> | undefined;
  let options: EngineeringRuntimeOptions | undefined;
  let canonicalDb: Database | undefined, scopedCloses = 0;
  try {
    await expect(main({ ...f.deps, engineering: { ...f.deps.engineering,
      createRoutine(input) { service = openEngineeringRoutineServices(input); const base = service;
        return { ...base, close() { scopedCloses++; base.close(); } }; },
      createRuntime(input) { options = input; const base = f.deps.engineering!.createRuntime!(input);
        return { ...base, async stop() { throw Error('engineering_runtime:shutdown_cleanup_unknown'); } }; },
    }, runLoop: async args => { canonicalDb = args.db; } })).rejects.toThrow('shutdown_cleanup_unknown');
    expect(scopedCloses).toBe(0); expect(f.order).not.toContain('ledger');
    expect(options!.journalDb.query('SELECT 1 n').get()).toEqual({ n: 1 });
    expect(options!.spendDb.query('SELECT 1 n').get()).toEqual({ n: 1 });
    expect(canonicalDb!.query('SELECT 1 n').get()).toEqual({ n: 1 });
  } finally {
    // This fixture never launches a writer; dispose only its temp handles after
    // proving production shutdown deliberately retained them.
    service?.close(); options?.journalDb.close(); options?.spendDb.close(); canonicalDb?.close(); f.ledger.close();
  }
});
