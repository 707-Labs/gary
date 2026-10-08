import {afterEach,expect,test,spyOn} from 'bun:test';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSessionHost,type SessionOptions} from '../../src/hermes/session-host.ts';
import {createGaryLoopAdapter} from '../../src/hermes/gary-loop-adapter.ts';
import {createGaryPhaseCoordinator} from '../../src/hermes/phase-coordinator.ts';
import {canonicalizeConversation,type ConversationMessage} from '../../src/hermes/conversation.ts';
import {createAuditTrace} from '../../src/hermes/audit-trace.ts';
import {CODING_VERIFICATION_POLICY} from '../../src/verification-policy.ts';
import {SpendLedger} from '../../src/spend.ts';
import type {Executor,ExecutorJobJournal,RunOpts} from '../../src/executors/index.ts';
import type {ProductiveProgressGuard} from '../../src/hermes/progress-guard.ts';
import type {AgentLoopArgs} from '../../src/agent/loop.ts';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const token='offline-long-test-capability-xxxxxxxxxxxxxxxxxx';
const request=(path:string,body:unknown)=>new Request('http://127.0.0.1'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
const execute=(id='gate',command='bun run ci:full')=>({taskId:'task',ownerEpoch:'owner',token,callId:id,name:'run_bash',arguments:{command}});
function fixture(overrides:Partial<SessionOptions>={}) {
 const ledger=new SpendLedger(':memory:');cleanup.push(()=>ledger.close());ledger.createCampaign('campaign',10);ledger.enrollTicket('campaign','ticket',5);
 let owner='owner',unknown=false,runs=0,observations=0,providers=0,cleaned=false,runOptions:RunOpts|undefined;
 let release:(error?:boolean)=>void=()=>{};
 const originalStatus=ledger.status.bind(ledger);ledger.status=(id)=>{const value=originalStatus(id);return value&&unknown?{...value,unknownAttempts:1}:value;};
 const executor:Executor={workspaceRoot:'/offline',readFile:async()=>'',writeFile:async()=>{},listFiles:async()=>[],grep:async()=>[],
  run:async(_command,opts)=>{runs++;runOptions=opts;return new Promise((resolve,reject)=>{
   let settled=false;const done=(error=false)=>{if(settled)return;settled=true;opts?.signal?.removeEventListener('abort',abort);cleaned=true;error?reject(new Error('private fake failure')):resolve({stdout:'checked\n',stderr:'',exitCode:0,timedOut:false});};
   const abort=()=>{setTimeout(()=>done(true),15);};release=done;opts?.signal?.addEventListener('abort',abort,{once:true});if(opts?.signal?.aborted)abort();
  });}};
 const progress={state:{stopReason:null},beforeModelRequest:async()=>{},observeSuccessfulTool:()=>{observations++;}} as unknown as ProductiveProgressGuard;
 const options:SessionOptions={admission:{taskId:'task',requestId:'request',ticketId:'ticket',actionId:'action',fingerprint:'fingerprint',ownerEpoch:'owner',deadlineMs:Date.now()+120_000},capabilityToken:token,ledger,
  provider:'deepseek',model:'deepseek-v4-pro',providerApiKey:'fake',executor,allowedTools:['run_bash','read_file','finish','report_blocked'],finishGateCommand:'bun run ci:full',
  currentOwnerEpoch:()=>owner,assertAdmission:()=>{},longTestPolicy:CODING_VERIFICATION_POLICY,executorJobJournal:{} as ExecutorJobJournal,progress,
  fetch:async()=>{providers++;return Response.json({id:'fake',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'text',text:'done'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}});},...overrides};
 const host=createSessionHost(options);cleanup.push(async()=>{await host.drain();host.dispose();});
 const start=async(id='gate',command='bun run ci:full')=>{const reply=await host.handle(request('/tools/execute',execute(id,command)));expect(reply.status).toBe(202);return reply.json();};
 const poll=(pending:any,changes:Record<string,unknown>={})=>host.handle(request('/tools/jobs/poll',{taskId:'task',requestId:'request',ownerEpoch:'owner',callId:pending.callId,jobId:pending.jobId,...changes}));
 return{host,options,ledger,executor,start,poll,release:(error=false)=>release(error),owner:()=>{owner='different';},unknown:()=>{unknown=true;},
  stats:()=>({runs,observations,providers,cleaned,runOptions})};
}
test('one start and one final receipt; polls carry no progress or additional executor invocation',async()=>{
 const f=fixture(),pending=await f.start();await Bun.sleep(1);
 expect(f.host.pendingTestJob).toBe(true);expect(f.host.state.runLog).toEqual([]);expect(f.stats()).toMatchObject({runs:1,observations:0,providers:0});
 expect(f.stats().runOptions!.timeoutMs).toBe(1800000);expect(f.stats().runOptions!.deadlineMs).toBe(pending.deadlineMs);
 expect(f.stats().runOptions!.testJob).toMatchObject({jobId:pending.jobId,taskId:'task',requestId:'request',actionId:'action',ownerEpoch:'owner'});
 const polling=f.poll(pending);let delivered=false;void polling.then(()=>{delivered=true;});await Bun.sleep(5);expect(delivered).toBe(false);
 f.release();const response=await polling,body=await response.json();expect(response.status).toBe(200);expect(body.kind).toBe('test_job_complete');
 expect(body.receipt).toMatchObject({tool_call_id:'gate',name:'run_bash',ok:true});expect(body.receipt.content).toContain('checked\n');
 expect(f.host.pendingTestJob).toBe(false);expect(f.host.state.runLog).toHaveLength(1);expect(f.stats()).toMatchObject({runs:1,observations:1,providers:0,cleaned:true});
 expect((await f.poll(pending)).status).toBe(409);expect(f.stats().observations).toBe(1);
});
test('fixed command recognition is exact and legacy omission keeps synchronous tools',async()=>{
 for(const command of ['bun run ci:full ','echo ok']) {
  const f=fixture();const response=f.host.handle(request('/tools/execute',execute('ordinary',command)));await Bun.sleep(1);f.release();expect((await response).status).toBe(200);expect(f.stats().runOptions!.testJob).toBeUndefined();
 }
 const f=fixture({longTestPolicy:undefined,executorJobJournal:undefined} as any);const result=f.host.handle(request('/tools/execute',execute()));await Bun.sleep(1);f.release();expect((await result).status).toBe(200);
});
test('smaller requested timeouts remain smaller and policy+journal pairing fails closed',async()=>{
 const f=fixture();const body=execute();Object.assign(body.arguments,{timeout_seconds:5});const response=await f.host.handle(request('/tools/execute',body));const pending=await response.json();await Bun.sleep(1);
 expect(f.stats().runOptions!.timeoutMs).toBe(5000);expect(pending.deadlineMs).toBeLessThanOrEqual(Date.now()+5000);f.release();await f.poll(pending);
 expect(()=>fixture({executorJobJournal:undefined} as any)).toThrow('invalid_long_test_binding');expect(()=>fixture({readOnly:true})).toThrow('invalid_long_test_binding');
 expect(()=>fixture({longTestPolicy:{...CODING_VERIFICATION_POLICY,maxPolls:100} as any})).toThrow();
});
test('pending job blocks model, other tools, finish and state before progress/provider work',async()=>{
 for(const [path,body] of [['/v1/chat/completions',{model:'deepseek-v4-pro',messages:[{role:'user',content:'task'}],max_tokens:32}],
  ['/tools/execute',{...execute('read'),name:'read_file',arguments:{path:'x'}}],['/tools/execute',{...execute('finish'),name:'finish',arguments:{summary:'done'}}],['/tools/state',{taskId:'task',ownerEpoch:'owner'}]] as const){
  const f=fixture();await f.start();expect((await f.host.handle(request(path,body))).status).toBe(409);await f.host.drain();expect(f.stats()).toMatchObject({providers:0,observations:0,cleaned:true});expect(f.host.result({status:'finished'}).status).toBe('error');
 }
});
test('foreign and concurrent polls disclose no job state and cannot deliver twice',async()=>{
 const f=fixture(),pending=await f.start();for(const changes of [{jobId:'foreign'},{callId:'foreign'},{requestId:'foreign'},{extra:'field'}]){
  const response=await f.poll(pending,changes);expect(response.status).toBe(409);expect(JSON.stringify(await response.json())).not.toContain(pending.jobId);
 }
 const first=f.poll(pending);await Bun.sleep(1);expect((await f.poll(pending)).status).toBe(409);expect((await first).status).toBe(409);await f.host.drain();expect(f.stats().observations).toBe(0);
});
test('concurrent slow execute bodies cannot overwrite the active job',async()=>{
 const f=fixture();let controller!:ReadableStreamDefaultController<Uint8Array>;
 const slow=f.host.handle(new Request('http://127.0.0.1/tools/execute',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:new ReadableStream({start(c){controller=c;}})}));
 const pending=await f.start();await Bun.sleep(1);controller.enqueue(new TextEncoder().encode(JSON.stringify(execute('second'))));controller.close();
 expect((await slow).status).toBe(409);await f.host.drain();expect(f.stats().runs).toBe(1);expect(f.stats().observations).toBe(0);expect((await f.poll(pending)).status).toBe(409);
});
test('ownership and unknown usage changes abort at fixed heartbeat without a poll',async()=>{
 for(const mutate of ['owner','unknown'] as const){const f=fixture();await f.start();f[mutate]();await Bun.sleep(1100);await f.host.drain();expect(f.stats()).toMatchObject({cleaned:true,observations:0,providers:0});expect(f.host.result({status:'finished'}).status).toBe('error');}
},4000);
test('unknown usage refuses job before spawning and deadline expiry awaits cleanup',async()=>{
 const f=fixture();f.unknown();expect((await f.host.handle(request('/tools/execute',execute()))).status).toBe(409);expect(f.stats().runs).toBe(0);
 const g=fixture({admission:{taskId:'task',requestId:'request',ticketId:'ticket',actionId:'action',fingerprint:'fingerprint',ownerEpoch:'owner',deadlineMs:Date.now()+80}});
 const pending=await g.start();expect((await g.poll(pending)).status).toBe(409);await g.host.drain();expect(g.stats().cleaned).toBe(true);expect(g.host.result({status:'finished'}).status).toBe('timeout');
});
test('executor failure cannot create a passing receipt or progress',async()=>{
 const f=fixture(),pending=await f.start();await Bun.sleep(1);f.release(true);const response=await f.poll(pending);expect(response.status).toBe(409);await f.host.drain();expect(f.host.result({status:'finished'}).status).toBe('error');expect(f.stats().observations).toBe(0);expect(f.host.state.finishGateMet).toBe(false);
});
test('native early return drains cleanup before terminal trace and cannot succeed',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'long-test-trace-')));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'trace.jsonl');const trace=createAuditTrace({path,binding:{taskId:'task',requestId:'request',ticketId:'ticket',actionId:'action',ownerEpoch:'owner'}});
 const f=fixture({trace});f.host.dispose(); // Adapter gets its own host; fixture executor remains fake.
 // A fresh trace is required because disposing the unused host finalizes the first one.
 const path2=join(dir,'adapter.jsonl');f.options.trace=createAuditTrace({path:path2,binding:{taskId:'task',requestId:'request',ticketId:'ticket',actionId:'action',ownerEpoch:'owner'}});
 const run=createGaryLoopAdapter({hostOptions:f.options,baseUrl:'http://127.0.0.1/',launch:async(m,h)=>{
  expect((await h(request('/tools/execute',execute()))).status).toBe(202);await Bun.sleep(1);
  return{taskId:m.taskId,requestId:m.requestId,status:'finished',publicationApproved:false};
 }});
 const args:AgentLoopArgs={glm:{} as any,executor:f.executor,systemPrompt:'Gary',task:'test',maxIterations:3,timeoutMs:5000,finishGateCommand:'bun run ci:full',disableSubagent:true};
 const result=await run(args);expect(result.status).toBe('error');expect(f.stats().cleaned).toBe(true);
 const events=readFileSync(path2,'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(events.at(-1).kind).toBe('terminal');expect(events.at(-1).status).toBe('error');expect(events.at(-1).pendingOperationIds).toEqual([]);
});
test('phase coordinator preserves one completed tool message between model requests',async()=>{
 const f=fixture();f.host.dispose();let modelCalls=0;const histories:unknown[]=[];
 f.options.fetch=async()=>{const first=++modelCalls===1;return Response.json({id:'fake-'+modelCalls,type:'message',role:'assistant',model:'deepseek-v4-pro',
  content:[{type:'tool_use',id:first?'gate':'finish',name:first?'run_bash':'finish',input:first?{command:'bun run ci:full'}:{summary:'verified'}}],stop_reason:'tool_use',
  usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}});};
 const run=createGaryPhaseCoordinator({hostOptions:f.options,baseUrl:'http://127.0.0.1/',launch:async(m,h)=>{
  let history=canonicalizeConversation([...(m.history??[]),{role:'user',content:m.prompt}]);
  for(let turn=0;turn<2;turn++){
  const modelReply=await h(request('/v1/chat/completions',{model:m.model,messages:[{role:'system',content:m.systemPrompt},...history],tools:m.tools,max_tokens:m.maxTokens,temperature:m.temperature,stream:false}));
  expect(modelReply.status).toBe(200);const assistant=(await modelReply.json()).choices[0].message;
  history=canonicalizeConversation([...history,assistant],{requireResolved:false});const call=assistant.tool_calls[0];
  const toolReply=await h(request('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,callId:call.id,name:call.function.name,arguments:call.function.arguments}));
  let receipt=await toolReply.json();
  if(toolReply.status===202){const pending=receipt;setTimeout(()=>f.release(),5);const result=await h(request('/tools/jobs/poll',{taskId:m.taskId,requestId:m.requestId,ownerEpoch:m.ownerEpoch,callId:call.id,jobId:pending.jobId}));expect(result.status).toBe(200);receipt=(await result.json()).receipt;}
  history=canonicalizeConversation([...history,{role:'tool',tool_call_id:call.id,content:receipt.content}]);
  if(call.function.name==='finish')return{taskId:m.taskId,requestId:m.requestId,status:'finished',publicationApproved:false,history};
  histories.push(history);
  }
  return{taskId:m.taskId,requestId:m.requestId,status:'iteration_cap',publicationApproved:false,history};
 }});
 const args:AgentLoopArgs={glm:{} as any,executor:f.executor,systemPrompt:'Gary',task:'check exact artifact',maxIterations:2,timeoutMs:5000,maxTokensPerTurn:128,finishGateCommand:'bun run ci:full',disableSubagent:true,
  phases:[{name:'implement',maxIter:2}]};
 const result=await run(args);expect(result.errorMessage??result.status).toBe('finished');expect(modelCalls).toBe(2);expect(result.iterations).toBe(2);expect(result.runLog).toHaveLength(1);
 const history=histories[0] as ConversationMessage[];expect(history.filter(m=>m.role==='tool')).toHaveLength(1);expect(JSON.stringify(history)).toContain('checked\\n');expect(JSON.stringify(history)).not.toContain('test_job');
 expect(f.stats().observations).toBe(2);
});

test('poll cancellation waits for cleanup and cannot expose a later success',async()=>{
 const f=fixture(),pending=await f.start(),abort=new AbortController();
 const input=request('/tools/jobs/poll',{taskId:'task',requestId:'request',ownerEpoch:'owner',callId:pending.callId,jobId:pending.jobId});
 const response=f.host.handle(new Request(input,{signal:abort.signal}));await Bun.sleep(1);abort.abort();
 expect((await response).status).toBe(409);await f.host.drain();expect(f.stats().cleaned).toBe(true);expect(f.stats().observations).toBe(0);
});
test('96 polls are allowed; a 97th aborts without another invocation or progress',async()=>{
 const realTimer=globalThis.setTimeout;
 const timer=spyOn(globalThis,'setTimeout').mockImplementation(((fn:Parameters<typeof setTimeout>[0],ms?:number,...args:unknown[])=>realTimer(fn,ms===20000?0:ms,...args)) as typeof setTimeout);
 try {
  const f=fixture(),pending=await f.start();
  for(let i=0;i<96;i++)expect((await f.poll(pending)).status).toBe(202);
  expect((await f.poll(pending)).status).toBe(409);await f.host.drain();expect(f.stats()).toMatchObject({runs:1,observations:0,providers:0,cleaned:true});
 } finally {timer.mockRestore();}
});
test('a progress stop or trace failure during a job cancels without completion credit',async()=>{
 for(const kind of ['progress','trace'] as const){
  const f=fixture();await f.start();await Bun.sleep(1);
  if(kind==='progress')Object.assign(f.options.progress!.state,{stopReason:'no_verified_progress'});
  else Object.assign(f.options,{trace:{failed:true}});
  // The options object was copied by fixture construction only; these are trusted host objects.
  await Bun.sleep(1100);await f.host.drain();
  expect(f.stats().observations).toBe(0);expect(f.stats().cleaned).toBe(true);expect(f.host.result({status:'finished'}).status).toBe('error');
 }
},3000);
test('late executor success after cancellation cannot restore finish or progress',async()=>{
 let release!:()=>void,started=false;
 const executor:Executor={workspaceRoot:'/offline',readFile:async()=>'',writeFile:async()=>{},listFiles:async()=>[],grep:async()=>[],
  run:async()=>{started=true;await new Promise<void>(resolve=>{release=resolve;});return{stdout:'late success',stderr:'',exitCode:0,timedOut:false};}};
 const f=fixture({executor});await f.start();await Bun.sleep(1);expect(started).toBe(true);
 const draining=f.host.drain();let settled=false;void draining.then(()=>{settled=true;});await Bun.sleep(5);expect(settled).toBe(false);
 release();await draining;expect(f.stats().observations).toBe(0);expect(f.host.state.finishGateMet).toBe(false);expect(f.host.result({status:'finished'}).status).toBe('error');
});

test('slow phase model body cannot overtake an admitted job or start provider spend',async()=>{
 const f=fixture();f.host.dispose();let providers=0;
 f.options.fetch=async()=>{providers++;return Response.json({id:'fake',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'tool_use',id:'gate',name:'run_bash',input:{command:'bun run ci:full'}}],stop_reason:'tool_use',usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}});};
 const run=createGaryPhaseCoordinator({hostOptions:f.options,baseUrl:'http://127.0.0.1/',launch:async(m,h)=>{
  const body={model:m.model,messages:[{role:'system',content:m.systemPrompt},{role:'user',content:m.prompt}],tools:m.tools,max_tokens:m.maxTokens,temperature:m.temperature,stream:false};
  const first=await h(request('/v1/chat/completions',body));expect(first.status).toBe(200);
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const slow=h(new Request('http://127.0.0.1/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:new ReadableStream({start(c){controller=c;}})}));
  const started=await h(request('/tools/execute',execute()));expect(started.status).toBe(202);await Bun.sleep(1);
  controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));controller.close();expect((await slow).ok).toBe(false);
  return{taskId:m.taskId,requestId:m.requestId,status:'finished',publicationApproved:false,history:[]};
 }});
 const result=await run({glm:{} as any,executor:f.executor,systemPrompt:'Gary',task:'test',maxIterations:3,timeoutMs:5000,finishGateCommand:'bun run ci:full',disableSubagent:true});
 expect(result.status).toBe('error');expect(result.iterations).toBe(1);expect(providers).toBe(1);expect(f.stats()).toMatchObject({runs:1,observations:0,cleaned:true});
});

test('drain fences retained handles while preserving already verified finish evidence',async()=>{
 const f=fixture(),pending=await f.start();await Bun.sleep(1);f.release();expect((await f.poll(pending)).status).toBe(200);
 expect((await f.host.handle(request('/tools/execute',{...execute('finish'),name:'finish',arguments:{summary:'checked'}}))).status).toBe(200);
 await f.host.drain();expect(f.host.result({status:'finished'}).status).toBe('finished');
 expect((await f.host.handle(request('/tools/execute',execute('late')))).status).toBe(409);expect(f.stats().runs).toBe(1);
 await f.host.drain();expect(f.host.finalizeTrace(f.host.result({status:'finished'}))).toBe(true);
});
