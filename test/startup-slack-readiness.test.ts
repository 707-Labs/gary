import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/index.ts';
import type { Config } from '../src/config.ts';
import type { StartupDependencies } from '../src/startup.ts';
import type { AssignedIssue, LinearAdapter } from '../src/adapters/linear.ts';
import type { GitHubClient } from '../src/adapters/github.ts';
import type { Executor } from '../src/executors/index.ts';
import { runProcess } from '../src/executors/process.ts';
import type { GaryRuntimeLauncher } from '../src/hermes/gary-loop-adapter.ts';
import { HERMES_CANARY_CHILD_IMAGE, HERMES_CANARY_WORKER_IMAGE, type HermesActivationConfig } from '../src/hermes/activation.ts';
import { bindCanonicalCodeAction } from '../src/hermes/canonical-admission.ts';
import type { CodePublicationReceipt } from '../src/handlers/code.ts';
import { openDb } from '../src/state/db.ts';
import { recordActionEnd, recordPr, setClassification, upsertTicket } from '../src/state/queries.ts';
import { SpendLedger } from '../src/spend.ts';
import { createSlackTransport, type SlackSocket } from '../src/slack/transport.ts';
import { GARY_SLACK, READY_DM_TEXT } from '../src/slack/service.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const ISSUE='11111111-1111-4111-8111-111111111111', REPO='fixture/repo', CHECK='bun run check';
const credentials={botToken:'xoxb-offline-startup-not-a-real-token',appToken:'xapp-offline-startup-not-a-real-token'};
const SOCKET_URL='wss://wss-primary.slack.com/link/?ticket=offline-fixture-ticket';
class FakeSocket implements SlackSocket {
  readyState=1; sent:string[]=[]; closes=0;
  listeners=new Map<string,Set<(event:unknown)=>void>>();
  addEventListener(type:string,listener:(event:unknown)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(listener);}
  removeEventListener(type:string,listener:(event:unknown)=>void){this.listeners.get(type)?.delete(listener);}
  send(data:string){this.sent.push(data);}
  close(){this.closes++;this.readyState=3;}
  frame(value:unknown){for(const fn of [...this.listeners.get('message')??[]])fn({data:JSON.stringify(value)});}
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const native:GaryRuntimeLauncher=async(m,handle)=>{
  const history:Record<string,unknown>[]=[...(m.history??[]),{role:'user',content:m.prompt}];
  const call=(path:string,body:unknown)=>handle(new Request(new URL(path,m.modelBaseUrl),{method:'POST',headers:{authorization:'Bearer '+m.capability,'content-type':'application/json'},body:JSON.stringify(body)}));
  for(let i=0;i<m.maxIterations;i++){
    const response=await call('/v1/chat/completions',{model:m.model,messages:[{role:'system',content:m.systemPrompt},...history],tools:m.tools,max_tokens:m.maxTokens,temperature:m.temperature,stream:false});
    if(!response.ok)throw new Error('offline_model_rpc_failed');
    const assistant=(await response.json()).choices[0].message;history.push(assistant);
    for(const tool of assistant.tool_calls??[]){
      const response=await call('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,callId:tool.id,name:tool.function.name,arguments:tool.function.arguments});
      const receipt=await response.json();history.push({role:'tool',tool_call_id:tool.id,content:receipt.content});
      if(!response.ok)throw new Error('offline_tool_rpc_failed');
      if(tool.function.name==='finish')return{taskId:m.taskId,requestId:m.requestId,status:'finished',publicationApproved:false,history};
    }
  }
  return{taskId:m.taskId,requestId:m.requestId,status:'iteration_cap',publicationApproved:false,history};
};
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'gary-startup-slack-')));roots.push(root);chmodSync(root,0o700);
  const workspace=join(root,'workspace'),traces=join(root,'traces');mkdirSync(workspace);mkdirSync(traces,{mode:0o700});
  const env={PATH:'/opt/homebrew/bin:/Users/tanner/.bun/bin:/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const run=(command:string)=>runProcess('/bin/bash',['-c',command],{cwd:workspace,env,timeoutMs:10_000});
  for(const command of ['git init -q','git config user.email fixture@example.invalid','git config user.name Fixture','git config core.hooksPath /dev/null'])expect((await run(command)).exitCode).toBe(0);
  writeFileSync(join(workspace,'task.ts'),'baseline\n');writeFileSync(join(workspace,'package.json'),JSON.stringify({scripts:{check:'test "$(cat task.ts)" = updated'}}));
  expect((await run('git add task.ts package.json && git commit -qm baseline')).exitCode).toBe(0);
  const activation:HermesActivationConfig={version:1,issueId:ISSUE,repo:REPO,provider:'deepseek',model:'deepseek-v4-pro',workerImage:HERMES_CANARY_WORKER_IMAGE,
    childImage:HERMES_CANARY_CHILD_IMAGE,dockerExecutable:'/usr/local/bin/docker',dockerHost:'unix:///Users/tanner/.colima/default/docker.sock',traceDirectory:traces,
    policy:{baseCommit:(await run('git rev-parse HEAD')).stdout.trim(),task:{allowedFiles:['task.ts'],criteria:[{id:'fix',description:'Exact scoped change',requiredCommands:[CHECK]}]},
      progress:{maxModelRequests:50,maxModelRequestsWithoutProgress:20,maxSuccessfulToolCalls:100,toolRepeatWindow:10,maxRepeatedToolCalls:5},instructions:[],voicePrinciples:'Use Gary voice.',
      readTicketIdentifiers:['ERT-1'],publicFetch:{policy:{kind:'urls',urls:[]}},cloudflare:{allowedServices:[],allowedDatabases:[]},preparationCommands:[]}};
  const activationPath=join(root,'activation.json'),credentialsPath=join(root,'slack.env');
  writeFileSync(activationPath,JSON.stringify(activation),{mode:0o600});
  writeFileSync(credentialsPath,`SLACK_BOT_TOKEN=${credentials.botToken}\nSLACK_APP_TOKEN=${credentials.appToken}\n`,{mode:0o600});
  const config:Config={gary:{name:'Offline Gary',linearUserId:'fixture-user',home:root,stateDir:join(root,'state'),reposDir:join(root,'repos'),workspacesDir:join(root,'workspaces'),
    dbPath:join(root,'state','gary.db'),repoMap:new Map([['ERT',REPO]]),allowlistedMentionUserIds:[]},linear:{apiKey:'fake-linear',teamId:'fixture-team',inProgressStateId:'fixture-progress'},
    github:{kind:'pat',token:'fake-github',username:'fixture'},providers:[{name:'deepseek',apiKey:'fake-provider-key',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-v4-pro',defaultBackoffMs:1000}],cloudflare:null,
    runtime:{pollIntervalMs:1,maxAttemptsPerTicket:1,circuitBreakerWindowHours:6,maxCiAttempts:1,agentLoopMaxIterations:50,agentLoopTimeoutMs:30_000,stalePrAfterMs:1000},
    review:{providerOrder:['deepseek'],maxRounds:1,iterationCap:5,timeoutMs:1000}};
  const executor:Executor={workspaceRoot:workspace,readFile:async path=>readFileSync(join(workspace,path),'utf8'),writeFile:async(path,content)=>{writeFileSync(join(workspace,path),content);},listFiles:async()=>[],grep:async()=>[],
    run:async(command,options)=>runProcess('/bin/bash',['-c',command],{...options,cwd:workspace,env,timeoutMs:options?.timeoutMs??10_000})};
  const sockets:FakeSocket[]=[],posts:Record<string,unknown>[]=[],methods:string[]=[];let modelCalls=0,launches=0,credentialLoads=0;
  const deps:StartupDependencies={config:()=>config,linear:()=>({} as LinearAdapter),github:()=>({} as GitHubClient),db:path=>openDb(path),ledger:path=>new SpendLedger(path),
    env:{GARY_RUNTIME_MODE:'hermes-canary',GARY_HERMES_ACTIVATION_PATH:activationPath,GARY_EXECUTOR:'docker',GARY_EXECUTOR_NETWORK:'none',GARY_EXECUTOR_IMAGE:HERMES_CANARY_CHILD_IMAGE,
      DOCKER_HOST:'unix:///Users/tanner/.colima/default/docker.sock',GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:credentialsPath},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init);expect(request.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
      const body=await request.json();expect(body.model).toBe('deepseek-v4-pro');expect(body.thinking).toEqual({type:'disabled'});modelCalls++;
      const steps=[['read_file',{path:'task.ts'}],['write_file',{path:'task.ts',content:'updated\n'}],['run_bash',{command:CHECK}],['finish',{summary:'Verified offline fixture'}]] as const;
      const step=steps[modelCalls-1]!;
      return Response.json({id:'reply-'+modelCalls,type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'tool_use',id:'tool-'+modelCalls,name:step[0],input:step[1]}],stop_reason:'tool_use',
        usage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
    }) as typeof fetch,
    launch:async(...args)=>{launches++;return native(...args);},
    slackTransport:loaded=>{credentialLoads++;expect(loaded).toEqual(credentials);expect(Object.isFrozen(loaded)).toBe(true);
      return createSlackTransport({credentials:loaded,maxReconnectAttempts:0,httpTimeoutMs:1000,helloTimeoutMs:1000,
        createSocket:url=>{expect(url).toBe(SOCKET_URL);const socket=new FakeSocket();sockets.push(socket);queueMicrotask(()=>socket.frame({type:'hello',connection_info:{app_id:GARY_SLACK.appId}}));return socket;},
        fetch:async(url,init)=>{
          const method=new URL(url).pathname.slice('/api/'.length);methods.push(method);
          expect(new URL(url).origin).toBe('https://slack.com');expect(init.redirect).toBe('error');
          expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+(method==='apps.connections.open'?credentials.appToken:credentials.botToken));
          if(method==='auth.test')return Response.json({ok:true,team_id:GARY_SLACK.teamId,user_id:GARY_SLACK.botUserId,bot_id:'BFAKE123'});
          if(method==='apps.connections.open')return Response.json({ok:true,url:SOCKET_URL});
          if(method==='chat.postMessage'){posts.push(JSON.parse(String(init.body)));return Response.json({ok:true,channel:'D0FIXTURE1',ts:'1791417600.000001'});}
          throw new Error('unexpected_fake_slack_method');
        }});
    }};
  return{root,workspace,traces,config,credentialsPath,executor,run,deps,sockets,posts,methods,counts:()=>({modelCalls,launches,credentialLoads})};
}
function mention(socket:FakeSocket,eventId:string){socket.frame({type:'events_api',envelope_id:'envelope-'+eventId,payload:{type:'event_callback',team_id:GARY_SLACK.teamId,api_app_id:GARY_SLACK.appId,event_id:'Ev'+eventId,
  event:{type:'app_mention',user:GARY_SLACK.tannerId,channel:'C0UNAPPROVED',ts:'1791417600.000002',text:`<@${GARY_SLACK.botUserId}> /exec ignored`}}});}
const modes=['ready','native-error','incomplete-action','active-spend','unknown-spend','failed-check','unreviewed-head','mismatched-publication','missing-pr'] as const;
for(const mode of modes)test('actual startup Slack readiness: '+mode,async()=>{
  const f=await fixture();const launch=f.deps.launch!;
  if(mode==='native-error')f.deps.launch=async(...args)=>({...await launch(...args),status:'error',reason:'offline_negative_outcome'});
  await main({...f.deps,runLoop:async args=>{
    const refresh=async()=>{expect(typeof args.onTickComplete).toBe('function');await args.onTickComplete!({candidatesConsidered:0,actionsTaken:[]});};
    const noSend=()=>{expect(f.posts).toEqual([]);expect(args.db.query('SELECT count(*) AS n FROM gary_slack_outbox').get()).toEqual({n:0});};
    noSend();expect(f.counts()).toEqual({modelCalls:0,launches:0,credentialLoads:1});
    mention(f.sockets[0]!,'Before');await flush();noSend();expect(f.sockets[0]!.sent).toHaveLength(1);
    args.spend!.createCampaign('offline',10);args.spend!.enrollTicket('offline',ISSUE,10,{draftPr:true});upsertTicket(args.db,{linearId:ISSUE,identifier:'ERT-1'});
    const admitted={issueId:ISSUE,fingerprint:'fp',humanSignature:'fixture-human',provider:'deepseek',model:'deepseek-v4-pro',repo:REPO};
    const classify=args.codingTrial!.admit({...admitted,actionType:'classify'});
    setClassification(args.db,{linearId:ISSUE,classification:'CODE',confidence:.99,scope:'S'});classify.complete(true,'handled');
    const trial=args.codingTrial!.admit({...admitted,actionType:'start_coding'}),actionId=trial.actionId;
    const binding=bindCanonicalCodeAction({db:args.db,ledger:args.spend!,actionId,fingerprint:'fp',issue:{id:ISSUE,identifier:'ERT-1',teamKey:'ERT',teamId:'fixture-team'} as AssignedIssue,
      repo:REPO,provider:'deepseek',model:'deepseek-v4-pro'});
    try{
      const result=await args.createAdmittedCodeLoop!(binding.admission)({glm:args.glm,executor:f.executor,systemPrompt:'Offline Gary fixture',task:'Update task.ts',maxIterations:5,
        maxTokensPerTurn:128,timeoutMs:30_000,deadlineMs:Date.now()+30_000,finishGateCommand:CHECK,disableSubagent:true});
      expect(result.status).toBe(mode==='native-error'?'error':'finished');expect(f.counts().modelCalls).toBe(4);
      const files=readdirSync(f.traces);expect(files).toHaveLength(1);
      const terminal=readFileSync(join(f.traces,files[0]!),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.kind==='terminal');
      expect(terminal).toHaveLength(1);expect(terminal[0].status).toBe(mode==='native-error'?'error':'finished');
      await refresh();noSend(); // Native completion alone is insufficient.
      expect((await f.run('git add task.ts && git commit -qm task')).exitCode).toBe(0);expect((await f.run(CHECK)).exitCode).toBe(0);
      const head=(await f.run('git rev-parse HEAD')).stdout.trim();expect((await f.run('git status --porcelain=v1')).stdout).toBe('');
      const observation=()=>({headSha:head,worktreeClean:true});
      // The trusted handler callback is the test seam; reviewer and GitHub operations have their own handler tests.
      const receipt:CodePublicationReceipt={issueId:ISSUE,repo:REPO,branch:'gary/canary',prNumber:42,prUrl:'https://github.com/fixture/repo/pull/42',draft:true,admittedRuntime:true,
        requiredCheck:{command:CHECK,passed:true,exitCode:0,timedOut:false,afterCheck:observation()},review:{fingerprint:'offline-reviewed-head',verdict:'approve',afterApproval:observation()},
        publication:{beforePush:observation(),afterPush:observation(),remoteHeadSha:head},postRebaseCheck:'not_run'};
      if(mode==='failed-check')receipt.requiredCheck.passed=false;
      if(mode==='unreviewed-head')receipt.review.afterApproval.headSha='b'.repeat(40);
      if(mode==='mismatched-publication')receipt.publication.remoteHeadSha='c'.repeat(40);
      await args.onCodePublication!(binding.admission,receipt);await refresh();noSend();
      if(mode!=='missing-pr')recordPr(args.db,{githubId:42,ticketLinearId:ISSUE,repo:REPO,prNumber:42,branch:'gary/canary'});
      if(mode==='unknown-spend'){
        const guarded=args.spend!.guardedFetch('deepseek',(async()=>{throw new Error('offline_ambiguous_request');}) as unknown as typeof fetch);
        await expect(args.spend!.withSpendScope(ISSUE,()=>guarded('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({model:'deepseek-v4-pro',max_tokens:128,messages:[{role:'user',content:'offline'}]})}))).rejects.toThrow('offline_ambiguous_request');
        expect(args.spend!.status(ISSUE)?.unknownAttempts).toBe(1);
      }
      if(mode==='ready')trial.complete(true,'pr_opened');
      else {
        // Deliberately split negative fixture state to exercise action and allocation gates independently.
        if(mode!=='incomplete-action')recordActionEnd(args.db,{id:actionId,success:true,outcome:'pr_opened'});
        await refresh();noSend(); // Completed action and publication still require known closed spend.
        if(mode!=='active-spend')args.spend!.markTerminal(ISSUE,'pr_opened');
      }
      await refresh();await refresh();await refresh();
      if(mode==='ready'){
        expect(f.posts).toEqual([{channel:GARY_SLACK.tannerId,text:READY_DM_TEXT,unfurl_links:false,unfurl_media:false}]);
        const row=args.db.query('SELECT * FROM gary_slack_outbox').get() as Record<string,unknown>;
        expect(row).toMatchObject({kind:'ready',recipient_id:'U0A9M5W16F8',target_channel:'U0A9M5W16F8',slack_channel:'D0FIXTURE1',status:'sent'});
        expect(row.readiness_receipt_id).toMatch(/^sha256:[a-f0-9]{64}$/);
      }else noSend();
      mention(f.sockets[0]!,'After');await flush();await refresh();
      expect(f.posts).toHaveLength(mode==='ready'?1:0);expect(f.counts().modelCalls).toBe(4);
      expect(args.db.query("SELECT count(*) AS n FROM gary_slack_outbox WHERE kind='mention'").get()).toEqual({n:0});
    }finally{binding.close();}
  }});
  expect(f.methods.filter(method=>method==='chat.postMessage')).toHaveLength(mode==='ready'?1:0);
  expect(f.methods.every(method=>['auth.test','apps.connections.open','chat.postMessage'].includes(method))).toBe(true);
  expect(f.sockets).toHaveLength(1);expect(f.sockets[0]!.readyState).toBe(3);
  expect([...f.sockets[0]!.listeners.values()].every(set=>set.size===0)).toBe(true);
  const persisted=openDb(f.config.gary.dbPath);
  try{expect(persisted.query('SELECT count(*) AS n FROM gary_slack_outbox').get()).toEqual({n:mode==='ready'?1:0});}
  finally{persisted.close();}
},15_000);

test('actual startup rejects unprotected credentials before any Slack or model transport',async()=>{
  const f=await fixture();chmodSync(f.credentialsPath,0o644);let polls=0;
  await expect(main({...f.deps,runLoop:async()=>{polls++;}})).rejects.toThrow('slack_credentials_rejected');
  expect(polls).toBe(0);expect(f.methods).toEqual([]);expect(f.counts()).toEqual({modelCalls:0,launches:0,credentialLoads:0});
});
