import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/state/db.ts';
import { upsertTicket,recordActionStart,recordActionEnd } from '../../src/state/queries.ts';
import { SpendLedger } from '../../src/spend.ts';
import { bindCanonicalCodeAction } from '../../src/hermes/canonical-admission.ts';
import { createHermesCodeLoopFactory, type ProductionRuntimeOptions } from '../../src/hermes/production-runtime.ts';
import { createDockerRuntimeLauncher } from '../../src/hermes/docker-launcher.ts';
import { createAuditTrace } from '../../src/hermes/audit-trace.ts';
import type { AgentLoopArgs } from '../../src/agent/loop.ts';
import type { AssignedIssue } from '../../src/adapters/linear.ts';
import type { Executor } from '../../src/executors/index.ts';
import { runProcess } from '../../src/executors/process.ts';
import type { GaryRuntimeLauncher } from '../../src/hermes/gary-loop-adapter.ts';

const dispose:Array<()=>void> = [];
afterEach(()=>{for(const close of dispose.splice(0).reverse()) close();});
const issue:AssignedIssue={id:'fixture-ticket',identifier:'ERT-1',title:'Fix fixture',description:'Update task.ts',
  url:'https://linear.invalid/ERT-1',stateName:'Todo',stateType:'unstarted',createdAt:'2026-10-07T00:00:00Z',
  updatedAt:'2026-10-07T00:00:00Z',creatorId:null,creatorName:null,teamId:'team-1',teamKey:'ERT',blockedBy:[]};
const CHECK='test "$(cat task.ts)" = updated';

/** Executes actual authenticated host requests; only the provider itself is a deterministic fake. */
const fakeNative:GaryRuntimeLauncher=async(m,handle)=>{
  const history:Record<string,unknown>[]=[...(m.history??[]),{role:'user',content:m.prompt}];
  const request=(path:string,body:unknown)=>handle(new Request(new URL(path,m.modelBaseUrl),{method:'POST',headers:{authorization:'Bearer '+m.capability,'content-type':'application/json'},body:JSON.stringify(body)}));
  for(let n=0;n<m.maxIterations;n++){
    const response=await request('/v1/chat/completions',{model:m.model,messages:[{role:'system',content:m.systemPrompt},...history],tools:m.tools,max_tokens:m.maxTokens,temperature:m.temperature,stream:false});
    if(!response.ok)return{taskId:m.taskId,requestId:m.requestId,status:'error',publicationApproved:false,history};
    const assistant=(await response.json()).choices[0].message;history.push(assistant);
    if(!assistant.tool_calls?.length)return{taskId:m.taskId,requestId:m.requestId,status:'no_finish',publicationApproved:false,text:assistant.content??'',history};
    for(const call of assistant.tool_calls){
      const result=await request('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,callId:call.id,name:call.function.name,arguments:call.function.arguments});
      const body=await result.json();history.push({role:'tool',tool_call_id:call.id,content:body.content??JSON.stringify(body)});
      if(!result.ok)return{taskId:m.taskId,requestId:m.requestId,status:'error',publicationApproved:false,history};
      if(call.function.name==='finish'||call.function.name==='report_blocked')return{taskId:m.taskId,requestId:m.requestId,status:call.function.name==='finish'?'finished':'blocked',publicationApproved:false,history};
    }
  }
  return{taskId:m.taskId,requestId:m.requestId,status:'iteration_cap',publicationApproved:false,history};
};
async function fixture(launch:GaryRuntimeLauncher=fakeNative){
  const root=mkdtempSync(join(tmpdir(),'gary-production-runtime-'));dispose.push(()=>rmSync(root,{recursive:true,force:true}));
  const db=openDb(':memory:');dispose.push(()=>db.close());
  const ledger=new SpendLedger(':memory:');dispose.push(()=>ledger.close());ledger.createCampaign('offline',20);ledger.enrollTicket('offline',issue.id,10);
  upsertTicket(db,{linearId:issue.id,identifier:issue.identifier});
  const actionId=recordActionStart(db,{ticketLinearId:issue.id,stateFingerprint:'fingerprint',actionType:'start_coding',provider:'deepseek',model:'deepseek-v4-pro'});
  const binding=bindCanonicalCodeAction({db,ledger,actionId,fingerprint:'fingerprint',issue,provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'});
  const env={PATH:'/opt/homebrew/bin:/Users/tanner/.bun/bin:/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const run=(command:string)=>runProcess('/bin/bash',['-c',command],{cwd:root,env,timeoutMs:10_000});
  for(const command of ['git init -q','git config user.email fixture@example.invalid','git config user.name Fixture','git config core.hooksPath /dev/null'])expect((await run(command)).exitCode).toBe(0);
  writeFileSync(join(root,'task.ts'),'baseline\n');expect((await run('git add task.ts && git commit -qm baseline')).exitCode).toBe(0);
  const baseCommit=(await run('git rev-parse HEAD')).stdout.trim();
  const executor:Executor={workspaceRoot:root,readFile:async path=>readFileSync(join(root,path),'utf8'),writeFile:async(path,text)=>{writeFileSync(join(root,path),text);},listFiles:async()=>[],grep:async()=>[],run:async(command,opts)=>runProcess('/bin/bash',['-c',command],{...opts,cwd:root,env,timeoutMs:opts?.timeoutMs??10_000})};
  const traces:string[]=[];const traceDir=join(root,'.trace');mkdirSync(traceDir,{mode:0o700});
  // Trace files are outside admitted Git state, exactly as production requires.
  const traceRoot=realpathSync(mkdtempSync(join(tmpdir(),'gary-runtime-trace-')));dispose.push(()=>rmSync(traceRoot,{recursive:true,force:true}));rmSync(traceDir,{recursive:true});
  let calls=0,policies=0;const seen:any[]=[];
  const steps=[['read_file',{path:'task.ts'}],['write_file',{path:'task.ts',content:'updated\n'}],['run_bash',{command:CHECK}],['finish',{summary:'Verified fixture'}]] as const;
  const options:ProductionRuntimeOptions={route:{provider:'deepseek',model:'deepseek-v4-pro',providerApiKey:'offline-only',fetch:async request=>{
    const body=await request.json();seen.push(body);calls++;
    const used=body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content.filter((x:any)=>x.type==='tool_use').map((x:any)=>x.name):[]);
    const implementation=body.tools.some((tool:any)=>tool.name==='write_file');
    const done=used.includes('finish') || (!implementation && used.includes('read_file'));
    const step=used.includes('run_bash')?steps[3]:used.includes('write_file')?steps[2]:used.includes('read_file')?steps[1]:steps[0];
    return Response.json({id:'reply-'+calls,type:'message',role:'assistant',model:'deepseek-v4-pro',content:done?[{type:'text',text:'Verified fixture context.'}]:[{type:'tool_use',id:'call-'+calls,name:step[0],input:step[1]}],stop_reason:done?'end_turn':'tool_use',usage:{input_tokens:10,output_tokens:8,cache_creation_input_tokens:0,cache_read_input_tokens:0}});
  }},launch,createTrace:binding=>{const path=join(traceRoot,binding.requestId+'.jsonl');traces.push(path);return createAuditTrace({path,binding});},
    taskPolicy:()=>{policies++;return{baseCommit,task:{allowedFiles:['task.ts'],criteria:[{id:'fix',description:'Update fixture and pass the exact check',requiredCommands:[CHECK]}]},
      progress:{maxModelRequests:20,maxModelRequestsWithoutProgress:10,maxSuccessfulToolCalls:50,toolRepeatWindow:10,maxRepeatedToolCalls:5},
      instructions:[],voicePrinciples:'Use Gary’s existing voice.',readTicketIdentifiers:['ERT-1'],publicFetch:{policy:{kind:'urls',urls:[]}}};}};
  const args:AgentLoopArgs={executor,glm:{} as AgentLoopArgs['glm'],systemPrompt:'You are Gary.',task:'Update task.ts.',maxIterations:8,maxTokensPerTurn:128,timeoutMs:50_000,deadlineMs:Date.now()+50_000,finishGateCommand:CHECK,disableSubagent:true};
  return{root,db,ledger,actionId,binding,options,args,traces,seen,counts:()=>({calls,policies}),runner:()=>createHermesCodeLoopFactory(options)(binding.admission)};
}
test('production factory shares actual ledger and Git evidence, retains check gate, and durably traces terminal state',async()=>{
  const f=await fixture();const result=await f.runner()(f.args);
  expect({status:result.status,error:result.errorMessage,calls:f.counts()}).toEqual({status:'finished',error:undefined,calls:{calls:4,policies:1}});expect(result.summary).toBe('Verified fixture');
  expect(readFileSync(join(f.root,'task.ts'),'utf8')).toBe('updated\n');expect(f.ledger.status(issue.id)?.attemptCount).toBe(4);
  expect(f.counts()).toEqual({calls:4,policies:1});expect(JSON.stringify(f.seen[0].system)).toContain('You are Gary.');
  const trace=readFileSync(f.traces[0]!,'utf8');expect(trace).toContain('"kind":"terminal"');expect(trace).toContain('"status":"finished"');expect(trace).not.toContain('offline-only');
});
test('completed, superseded and closed action bindings are revoked without spending',async()=>{
  for(const mode of ['completed','superseded','closed']){
    const f=await fixture();const runner=f.runner();
    if(mode==='completed')recordActionEnd(f.db,{id:f.actionId,success:true});
    if(mode==='superseded')recordActionStart(f.db,{ticketLinearId:issue.id,stateFingerprint:'new',actionType:'start_coding',provider:'deepseek',model:'deepseek-v4-pro'});
    if(mode==='closed')f.binding.close();
    expect((await runner(f.args)).status).toBe('error');expect(f.counts().calls).toBe(0);expect(f.ledger.status(issue.id)?.attemptCount).toBe(0);
  }
});
test('wrong provider and absent canonical criteria never launch or open new spend authority',async()=>{
  const f=await fixture();expect(()=>createHermesCodeLoopFactory({...f.options,route:{...f.options.route,provider:'z.ai',model:'glm-5.3'}})(f.binding.admission)).toThrow('admitted_model_route_mismatch');
  const original=f.options.taskPolicy;f.options.taskPolicy=async(...args)=>({...await original(...args),task:{allowedFiles:['task.ts'],criteria:[{id:'wrong',description:'Wrong check',requiredCommands:['true']}]}});
  expect((await f.runner()(f.args)).status).toBe('error');expect(f.counts().calls).toBe(0);
});
test('fixup calls keep original baseline and evidence policy; changed workspace or extended deadline fails closed',async()=>{
  const f=await fixture();const runner=f.runner();expect((await runner(f.args)).status).toBe('finished');
  expect((await runner(f.args)).status).toBe('finished');expect(f.counts().policies).toBe(1);
  expect(f.ledger.status(issue.id)?.attemptCount).toBe(8);
  expect(JSON.stringify(f.seen[4].messages)).toContain('testEvidence\\\":\\\"pending');
  expect((await runner({...f.args,deadlineMs:f.args.deadlineMs!+60_000,timeoutMs:100_000})).status).toBe('error');expect(f.counts().calls).toBe(8);
});
test('failed deterministic preparation propagates pipeline status before any model or worker',async()=>{
  let launched=false;const f=await fixture(async()=>{launched=true;throw new Error('must not launch');});
  const original=f.options.taskPolicy;f.options.taskPolicy=async(...args)=>({...await original(...args),preparationCommands:['false | true']});
  expect((await f.runner()(f.args)).status).toBe('error');expect(launched).toBe(false);expect(f.counts().calls).toBe(0);
  expect(readFileSync(f.traces[0]!,'utf8')).toContain('"kind":"terminal"');
});

test('one durable action owner cannot be claimed twice, including through a second binding',async()=>{
  const f=await fixture();expect(()=>bindCanonicalCodeAction({db:f.db,ledger:f.ledger,actionId:f.actionId,fingerprint:'fingerprint',issue,provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'})).toThrow('canonical_action_already_claimed');
  f.binding.admission.assertActive();expect(f.ledger.status(issue.id)?.attemptCount).toBe(0);
});
test('current ticket and repository must match the canonical dispatch action',async()=>{
  for(const args of [{currentIssue:{id:'other-ticket',identifier:'ERT-2',teamId:'team-1'}},{defaultRepo:'other/repository'}]){
    const f=await fixture();expect((await f.runner()({...f.args,...args})).status).toBe('error');expect(f.counts().calls).toBe(0);
  }
});

test.skipIf(!process.env.GARY_HERMES_NATIVE_TEST_IMAGE)('actual immutable Hermes container completes production host phases with fake provider and real Git/check/ledger/trace',async()=>{
  const launch=createDockerRuntimeLauncher({imageDigest:process.env.GARY_HERMES_NATIVE_TEST_IMAGE!,
    dockerHost:process.env.GARY_HERMES_NATIVE_TEST_DOCKER_HOST??'unix:///var/run/docker.sock'});
  const f=await fixture(launch);
  const result=await f.runner()({...f.args,phases:[
    {name:'investigate',maxIter:3,allowedTools:new Set(['read_file','todo_write','report_blocked']),nudgeMessage:'Finish exploring.'},
    {name:'implement',maxIter:5,entryMessage:'Implement and verify the admitted task.'},
  ]});
  expect({status:result.status,error:result.errorMessage}).toEqual({status:'finished',error:undefined});
  expect(readFileSync(join(f.root,'task.ts'),'utf8')).toBe('updated\n');
  expect(f.ledger.status(issue.id)?.attemptCount).toBe(6);expect(result.iterations).toBe(6);
  expect(f.seen[2].messages.some((message:any)=>message.content.some?.((x:any)=>x.type==='tool_result'))).toBe(true);
  expect(readFileSync(f.traces[0]!,'utf8')).toContain('"status":"finished"');
},60_000);

test('out-of-scope patch cannot pass finish even when the shell check exits zero',async()=>{
  const f=await fixture();const write=f.args.executor.writeFile;
  f.args.executor.writeFile=async(path,text,opts)=>{await write(path,text,opts);writeFileSync(join(f.root,'outside.ts'),'unexpected');};
  const result=await f.runner()(f.args);expect(result.status).toBe('error');expect(result.summary).toBeNull();
  expect(readFileSync(f.traces[0]!,'utf8')).not.toContain('"status":"finished"');
});
test('progress policy must leave an implementation opportunity after read-only investigation',async()=>{
  const f=await fixture();const original=f.options.taskPolicy;
  f.options.taskPolicy=async(...args)=>{const policy=await original(...args);return {...policy,progress:{...policy.progress,maxModelRequestsWithoutProgress:3}};};
  const result=await f.runner()({...f.args,phases:[{name:'investigate',maxIter:3,allowedTools:new Set(['read_file','report_blocked'])},{name:'implement',maxIter:5}]});
  expect(result.status).toBe('error');expect(f.counts().calls).toBe(0);
});

test('another factory cannot run the same admitted action concurrently',async()=>{
  const f=await fixture();f.runner();expect(()=>f.runner()).toThrow('production_action_already_bound');expect(f.counts().calls).toBe(0);
});
