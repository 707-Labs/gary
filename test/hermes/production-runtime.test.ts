import { createStdioLauncher } from '../../src/hermes/stdio-launcher.ts';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, spyOn, test } from 'bun:test';
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
import type { Executor, ExecutorJobJournal, RunOpts } from '../../src/executors/index.ts';
import { runProcess } from '../../src/executors/process.ts';
import type { GaryRuntimeLauncher, GaryRuntimeManifest } from '../../src/hermes/gary-loop-adapter.ts';
import * as readonlyChild from '../../src/hermes/readonly-child.ts';

import { createActionVerification, CODING_VERIFICATION_POLICY } from '../../src/verification-policy.ts';

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
      let result=await request('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,callId:call.id,name:call.function.name,arguments:call.function.arguments});
      let body=await result.json();
      let jobId:string|undefined;
      for(let polls=0;result.status===202;polls++){
        expect(polls).toBeLessThan(m.longTestPolicy?.maxPolls??0);
        expect(body).toMatchObject({kind:'test_job_pending',taskId:m.taskId,requestId:m.requestId,ownerEpoch:m.ownerEpoch,callId:call.id,name:'run_bash'});
        jobId??=body.jobId;expect(body.jobId).toBe(jobId);
        result=await request('/tools/jobs/poll',{taskId:m.taskId,requestId:m.requestId,ownerEpoch:m.ownerEpoch,callId:call.id,jobId});
        body=await result.json();
      }
      if(jobId && result.ok){
        expect(body).toMatchObject({kind:'test_job_complete',jobId,callId:call.id});
        body=body.receipt;
      }
      history.push({role:'tool',tool_call_id:call.id,content:body.content??JSON.stringify(body)});
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
    const step=body.tools.some((tool:any)=>tool.name==='dispatch_subagent') && !used.includes('dispatch_subagent')
      ? ['dispatch_subagent',{task:'Read task.ts and report the fixture baseline.'}] as const
      : used.includes('run_bash')?steps[3]:used.includes('write_file')?steps[2]:used.includes('read_file')?steps[1]:steps[0];
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
  expect(f.seen.every(body=>!Object.hasOwn(body,'thinking'))).toBe(true);
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
  let launched=false;const f=await fixture(async()=>{launched=true;throw new Error('must not launch');});f.options.thinking='disabled';
  const original=f.options.taskPolicy;f.options.taskPolicy=async(...args)=>({...await original(...args),preparationCommands:['false | true']});
  expect((await f.runner()(f.args)).status).toBe('error');expect(launched).toBe(false);expect(f.counts().calls).toBe(0);
  const trace=readFileSync(f.traces[0]!,'utf8');expect(trace).toContain('"kind":"terminal"');
  expect(JSON.parse(trace.trim().split('\n').at(-1)!).modelState.thinking).toBe('disabled');
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
  const f=await fixture(launch);f.options.thinking='disabled';
  const result=await f.runner()({...f.args,phases:[
    {name:'investigate',maxIter:3,allowedTools:new Set(['read_file','todo_write','report_blocked']),nudgeMessage:'Finish exploring.'},
    {name:'implement',maxIter:5,entryMessage:'Implement and verify the admitted task.'},
  ]});
  expect({status:result.status,error:result.errorMessage}).toEqual({status:'finished',error:undefined});
  expect(readFileSync(join(f.root,'task.ts'),'utf8')).toBe('updated\n');
  expect(f.ledger.status(issue.id)?.attemptCount).toBe(6);expect(result.iterations).toBe(6);
  expect(f.seen.map(body=>body.thinking)).toEqual(Array.from({length:6},()=>({type:'disabled'})));
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

test('trusted disabled thinking reaches upstream in both phases and successive check/reviewer repairs',async()=>{
  const f=await fixture();f.options.thinking='disabled';const runner=f.runner();
  const result=await runner({...f.args,phases:[
    {name:'investigate',maxIter:3,allowedTools:new Set(['read_file','todo_write','report_blocked'])},
    {name:'implement',maxIter:5,entryMessage:'Implement and verify the admitted task.'},
  ]});
  expect({status:result.status,error:result.errorMessage}).toEqual({status:'finished',error:undefined});
  const primaryCalls=f.seen.length;
  expect(f.seen.some(body=>!body.tools.some((tool:any)=>tool.name==='write_file'))).toBe(true);
  expect(f.seen.some(body=>body.tools.some((tool:any)=>tool.name==='write_file'))).toBe(true);
  for(const task of ['Repair the post-finish check failure in task.ts.','Address the independent reviewer finding in task.ts.']){
    const before=f.seen.length;
    const repaired=await runner({...f.args,task,maxIterations:15});
    expect({status:repaired.status,error:repaired.errorMessage}).toEqual({status:'finished',error:undefined});
    expect(f.seen.length-before).toBe(4);
  }
  expect(f.seen.length-primaryCalls).toBe(8);
  expect(f.seen.map(body=>body.thinking)).toEqual(Array.from({length:f.seen.length},()=>({type:'disabled'})));
  expect(f.ledger.status(issue.id)?.attemptCount).toBe(f.seen.length);
  expect(f.counts().policies).toBe(1);
},10_000);

test('invalid trusted thinking and non-DeepSeek thinking fail before binding or work',async()=>{
  let launches=0;const f=await fixture(async(...args)=>{launches++;return fakeNative(...args);});
  for(const thinking of ['enabled',null,{type:'disabled'},true]){
    expect(()=>createHermesCodeLoopFactory({...f.options,thinking} as unknown as ProductionRuntimeOptions))
      .toThrow('invalid_host_thinking_policy');
  }
  expect(()=>createHermesCodeLoopFactory({...f.options,thinking:'disabled',route:{...f.options.route,provider:'z.ai',model:'glm-5.3'}}))
    .toThrow('invalid_host_thinking_policy');
  expect({launches,...f.counts(),traces:f.traces.length}).toEqual({launches:0,calls:0,policies:0,traces:0});
  expect(f.ledger.status(issue.id)?.attemptCount).toBe(0);
  f.binding.admission.assertActive();
  f.options.thinking='disabled';expect((await f.runner()(f.args)).status).toBe('finished');
  expect(f.seen.every(body=>body.thinking?.type==='disabled')).toBe(true);
});

test('factory snapshots trusted thinking and provider before caller mutation',async()=>{
  const f=await fixture();f.options.thinking='disabled';
  const factory=createHermesCodeLoopFactory(f.options);
  delete f.options.thinking;f.options.route.provider='z.ai';f.options.route.model='glm-5.3';
  f.options.route.fetch=async()=>{throw new Error('mutated caller transport must not run');};
  const result=await factory(f.binding.admission)(f.args);
  expect({status:result.status,error:result.errorMessage}).toEqual({status:'finished',error:undefined});
  expect(f.seen).toHaveLength(4);
  expect(f.seen.map(body=>({model:body.model,thinking:body.thinking}))).toEqual(
    Array.from({length:4},()=>({model:'deepseek-v4-pro',thinking:{type:'disabled'}})));
});

test('trusted disabled thinking reaches actual child host requests and parent resumes after cleanup',async()=>{
  const f=await fixture();f.options.thinking='disabled';
  f.options.readonlyChildren={imageDigest:'sha256:'+'a'.repeat(64)};
  let closed=0,reads=0;
  const fetch=f.options.route.fetch!;
  f.options.route.fetch=async request=>{
    const body=await request.clone().json();
    const parent=body.tools.some((tool:any)=>tool.name==='dispatch_subagent');
    const resumed=body.messages.some((message:any)=>message.content?.some?.((block:any)=>block.type==='tool_use' && block.name==='dispatch_subagent'));
    if(parent && resumed)expect(closed).toBe(1);
    return fetch(request);
  };
  const executor:Executor={...f.args.executor,
    readFile:async(path,opts)=>{reads++;return f.args.executor.readFile(path,opts);},
    writeFile:async()=>{throw new Error('child write forbidden');},
    run:async()=>{throw new Error('child shell not required by this fixture');},
  };
  const createChild=spyOn(readonlyChild,'createReadonlyChildExecutor').mockImplementation(async options=>{
    expect(options.workspaceRoot).toBe(f.root);expect(options.parentDepth).toBe(0);
    expect(options.admission.ownerEpoch).toBe(f.binding.admission.ownerEpoch);
    options.assertActive(options.admission);
    return{executor,depth:1,admission:options.admission,close:async()=>{closed++;}};
  });
  try{
    const result=await f.runner()({...f.args,disableSubagent:false});
    expect({status:result.status,error:result.errorMessage}).toEqual({status:'finished',error:undefined});
    expect(createChild).toHaveBeenCalledTimes(1);expect(closed).toBe(1);expect(reads).toBe(1);
    const childCalls=f.seen.filter(body=>!body.tools.some((tool:any)=>tool.name==='dispatch_subagent'));
    const parentCalls=f.seen.filter(body=>body.tools.some((tool:any)=>tool.name==='dispatch_subagent'));
    expect(childCalls).toHaveLength(2);expect(parentCalls).toHaveLength(5);
    expect(childCalls.every(body=>!body.tools.some((tool:any)=>['write_file','edit_file','commit','finish'].includes(tool.name)))).toBe(true);
    expect(f.seen.map(body=>body.thinking)).toEqual(Array.from({length:7},()=>({type:'disabled'})));
    expect(f.ledger.status(issue.id)?.attemptCount).toBe(7);
    expect(readFileSync(join(f.root,'task.ts'),'utf8')).toBe('updated\n');
  }finally{createChild.mockRestore();}
});


test.skipIf(!process.env.GARY_HERMES_NATIVE_TEST_IMAGE)('actual native stdio retains the outer paid guard and rejects unknown usage before any tool or second request',async()=>{
  const launch=createDockerRuntimeLauncher({imageDigest:process.env.GARY_HERMES_NATIVE_TEST_IMAGE!,
    dockerExecutable:'/usr/local/bin/docker',dockerHost:process.env.GARY_HERMES_NATIVE_TEST_DOCKER_HOST??'unix:///var/run/docker.sock'});
  const f=await fixture(launch);f.options.thinking='disabled';
  const guardedPhases:string[]=[];let paidRequests=0;
  f.options.route.fetch=async request=>{
    const body=await request.json();paidRequests++;
    expect(body.thinking).toEqual({type:'disabled'});
    // A valid read tool request must remain unavailable when its usage receipt is unpriced.
    return Response.json({id:'offline-unknown-usage',type:'message',role:'assistant',model:'deepseek-v4-pro',
      content:[{type:'tool_use',id:'do-not-run',name:'read_file',input:{path:'task.ts'}}],stop_reason:'tool_use',usage:{}});
  };
  const result=await f.ledger.withPaidRequestGuard(phase=>{
    guardedPhases.push(phase);f.binding.admission.assertActive();
    if(f.ledger.status(issue.id)!.unknownAttempts>(phase==='before_send'?1:0))throw new Error('offline_unknown_usage_stop');
  },()=>f.runner()(f.args));
  expect(result.status).toBe('error');expect(result.summary).toBeNull();
  expect(paidRequests).toBe(1);
  expect(guardedPhases).toEqual(['before_request','before_send','after_response']);
  const status=f.ledger.status(issue.id)!;
  expect(status.attemptCount).toBe(1);expect(status.unknownAttempts).toBe(1);
  expect(status.chargedMicros).toBe(1_384_628);
  expect(f.traces).toHaveLength(1);
  const trace=readFileSync(f.traces[0]!,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(trace.filter(row=>row.kind==='model'&&row.stage==='start')).toHaveLength(1);
  expect(trace.filter(row=>row.kind==='tool')).toEqual([]);
  expect(trace.filter(row=>row.kind==='terminal')).toHaveLength(1);
  expect(trace.at(-1).status).toBe('error');
  expect(readFileSync(join(f.root,'task.ts'),'utf8')).toBe('baseline\n');
  expect(f.db.query('SELECT count(*) AS n FROM prs').get()).toEqual({n:0});
  f.ledger.markTerminal(issue.id,'offline_unknown_usage_stop');f.binding.close();
  expect(f.ledger.status(issue.id)).toMatchObject({state:'closed',unknownAttempts:1,chargedMicros:1_384_628});
},60_000);


function fullVerificationFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const verification = createActionVerification({ policy: CODING_VERIFICATION_POLICY, assertActive: () => f.binding.admission.assertActive() });
  let bindings = 0, pending = 0, polls = 0;
  const manifests: Readonly<GaryRuntimeManifest>[] = [];
  const executions: Array<{ command: string; opts: RunOpts }> = [];
  const journal: ExecutorJobJournal = { directory: '/offline-job-journal', close() {} };
  f.options.verificationForAction = action => {
    expect(action).toBe(f.binding.admission); bindings++; return verification;
  };
  f.options.executorJobJournal = journal;
  const taskPolicy = f.options.taskPolicy;
  f.options.taskPolicy = async (...args) => {
    const policy = await taskPolicy(...args);
    return { ...policy, task: { ...policy.task, criteria: [{ id: 'fix', description: 'Verify the changed fixture.', requiredCommands: ['bun run ci:full'] }] } };
  };
  const fetch = f.options.route.fetch!;
  f.options.route.fetch = async request => {
    const response = await fetch(request);
    const body = await response.json();
    for (const block of body.content ?? []) {
      if (block.type === 'tool_use' && block.name === 'run_bash' && block.input.command === CHECK) block.input.command = 'bun run ci:full';
    }
    return Response.json(body, { status: response.status });
  };
  const executor = f.args.executor;
  f.args.executor = { ...executor, run: async (command, opts = {}) => {
    executions.push({ command, opts });
    return executor.run(command === 'set -euo pipefail\n' + 'bun run ci:full' ? 'set -euo pipefail\n' + CHECK : command, opts);
  } };
  f.args.finishGateCommand = 'bun run ci:full';
  f.options.launch = async (manifest, handle, signal) => {
    manifests.push(manifest);
    return fakeNative(manifest, async request => {
      if (new URL(request.url).pathname === '/tools/jobs/poll') polls++;
      const response = await handle(request);
      if (response.status === 202) pending++;
      return response;
    }, signal);
  };
  return { verification, journal, manifests, executions, counts: () => ({ bindings, pending, polls }) };
}

test('opt-in production verification polls real host jobs, preserves one action state across repair, and propagates job capture context', async () => {
  const f = await fixture();
  const v = fullVerificationFixture(f);
  const runner = f.runner();
  for (let invocation = 1; invocation <= 2; invocation++) {
    const result = await runner(f.args);
    expect({ status: result.status, error: result.errorMessage }).toEqual({ status: 'finished', error: undefined });
    expect(v.verification.snapshot()).toEqual({ deadlineMs: f.args.deadlineMs!,
      counts: { 'bun run ci:full': invocation, 'bun run check': 0 } });
  }
  expect(v.counts()).toEqual({ bindings: 1, pending: 2, polls: 2 });
  expect(f.counts()).toEqual({ calls: 8, policies: 1 });
  expect(f.ledger.status(issue.id)?.attemptCount).toBe(8);
  expect(v.manifests).toHaveLength(2);
  expect(v.manifests.every(manifest => manifest.longTestPolicy?.commands['bun run ci:full'].timeoutMs === 1_800_000)).toBe(true);
  expect(v.manifests.every(manifest => manifest.longTestPolicy?.commands['bun run ci:full'].maxStarts === 4)).toBe(true);
  const jobs = v.executions.filter(call => call.opts.testJob);
  expect(jobs).toHaveLength(6);
  for (let invocation = 0; invocation < 2; invocation++) {
    const group = jobs.slice(invocation * 3, invocation * 3 + 3);
    const job = group[0]!.opts.testJob!;
    expect(group[0]!.command).toBe(group[2]!.command);
    expect(group[1]!.command).toBe('set -euo pipefail\nbun run ci:full');
    expect(job.journal).toBe(v.journal);
    expect(job.actionId).toBe(String(f.actionId));
    expect(job.ownerEpoch).toBe(f.binding.admission.ownerEpoch);
    expect(job.requestId).toBe(v.manifests[invocation]!.requestId);
    for (const call of group) {
      expect(call.opts.testJob).toBe(job);
      expect(call.opts.deadlineMs).toBe(f.args.deadlineMs);
    }
  }
  expect(jobs[0]!.opts.testJob!.jobId).not.toBe(jobs[3]!.opts.testJob!.jobId);
  expect(JSON.stringify(f.seen)).not.toContain('test_job_pending');
  expect(JSON.stringify(f.seen)).not.toContain('test_job_complete');
  expect(f.traces).toHaveLength(2);
  expect(f.traces.every(path => readFileSync(path, 'utf8').includes('"status":"finished"'))).toBe(true);
}, 10_000);

test('changed repair finish gate is rejected before another launch, test, trace or model spend', async () => {
  const f = await fixture();
  const v = fullVerificationFixture(f);
  const runner = f.runner();
  expect((await runner(f.args)).status).toBe('finished');
  const before = { modelCalls: f.counts().calls, attempts: f.ledger.status(issue.id)!.attemptCount,
    executions: v.executions.length, manifests: v.manifests.length, traces: f.traces.length, counters: v.verification.snapshot() };
  const result = await runner({ ...f.args, finishGateCommand: 'bun run check' });
  expect(result.status).toBe('error');
  expect(result.errorMessage).toBe('production_runtime_failed:admission');
  expect({ modelCalls: f.counts().calls, attempts: f.ledger.status(issue.id)!.attemptCount,
    executions: v.executions.length, manifests: v.manifests.length, traces: f.traces.length, counters: v.verification.snapshot() }).toEqual(before);
  expect(v.counts().bindings).toBe(1);
}, 10_000);

test('read-only children receive neither long-test policy nor executor job authority from an opted-in parent', async () => {
  const f = await fixture();
  const v = fullVerificationFixture(f);
  f.options.readonlyChildren = { imageDigest: 'sha256:' + 'a'.repeat(64) };
  let closed = 0, reads = 0;
  const childExecutor: Executor = { ...f.args.executor,
    readFile: async path => { reads++; return readFileSync(join(f.root, path), 'utf8'); },
    run: async () => { throw new Error('Read-only fixture must not run a long test'); } };
  const child = spyOn(readonlyChild, 'createReadonlyChildExecutor').mockImplementation(async options => {
    options.assertActive(options.admission);
    return { executor: childExecutor, depth: 1, admission: options.admission, close: async () => { closed++; } };
  });
  try {
    const result = await f.runner()({ ...f.args, disableSubagent: false });
    expect({ status: result.status, error: result.errorMessage }).toEqual({ status: 'finished', error: undefined });
    expect(child).toHaveBeenCalledTimes(1); expect(closed).toBe(1); expect(reads).toBe(1);
    const childManifest = v.manifests.find(manifest => !manifest.tools.some(tool => tool.function.name === 'write_file'))!;
    expect(childManifest).toBeDefined();
    expect(childManifest.longTestPolicy).toBeUndefined();
    expect(v.manifests.find(manifest => manifest.tools.some(tool => tool.function.name === 'write_file'))?.longTestPolicy).toBeDefined();
    expect(v.verification.snapshot().counts['bun run ci:full']).toBe(1);
    expect(v.executions.filter(call => call.opts.testJob).every(call => call.opts.testJob!.requestId !== childManifest.requestId)).toBe(true);
  } finally { child.mockRestore(); }
}, 10_000);

test('real Python wrapper and stdio preserve post-200 fault through phase, adapter, production and private trace',async()=>{
  let cleaned=0;
  const launch=createStdioLauncher({command:['/usr/bin/python3','-I',fileURLToPath(new URL('./fixtures/diagnostic-worker.py',import.meta.url)),
    fileURLToPath(new URL('../../hermes/python',import.meta.url))],cwd:'/tmp',env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},async cleanup(){cleaned++;}});
  const f=await fixture(launch);
  const result=await f.runner()({...f.args,phases:[{name:'investigate',maxIter:3,allowedTools:new Set(['read_file','report_blocked'])},{name:'implement',maxIter:5}]});
  const diagnostic={origin:'worker',code:'invalid_history_content',stage:'model_response',category:'none'} as const;
  expect(result.status).toBe('error');expect(result.diagnostic).toEqual(diagnostic);expect(cleaned).toBe(1);
  expect(f.counts().calls).toBe(1);expect(f.ledger.status(issue.id)?.unknownAttempts).toBe(0);
  expect(readFileSync(join(f.root,'task.ts'),'utf8')).toBe('baseline\n');
  const rows=readFileSync(f.traces[0]!,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(rows.map(row=>row.kind)).toEqual(['run_start','model','model','terminal']);
  expect(rows[2]).toMatchObject({stage:'result',httpStatus:200,iteration:1,phase:'investigation'});
  expect(rows[3]).toMatchObject({status:'error',errorCode:'native_runtime_error',diagnostic,pendingOperationIds:[],phase:'investigation',iteration:1});
  expect(readFileSync(f.traces[0]!,'utf8')).not.toContain('offline-only');
});
