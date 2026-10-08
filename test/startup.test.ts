import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
