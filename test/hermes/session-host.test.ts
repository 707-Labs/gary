import { afterEach, expect, test } from 'bun:test';
import { createSessionHost, type SessionOptions } from '../../src/hermes/session-host.ts';
import { SpendLedger } from '../../src/spend.ts';
import type { Executor } from '../../src/executors/index.ts';
import { createProgressGuard, type ProductiveProgressGuard, type TrustedProgressSnapshot } from '../../src/hermes/progress-guard.ts';
import { createAuditTrace, type AuditTrace } from '../../src/hermes/audit-trace.ts';
import {mkdtempSync,realpathSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const resources: Array<()=>void> = [];
afterEach(()=>{for(const cleanup of resources.splice(0).reverse()) cleanup();});
const token = 'test-capability-000000000000000000000000';
function fixture(progress?: ProductiveProgressGuard, cap = 5, trace?:AuditTrace, overrides:Partial<SessionOptions>={}) {
  const ledger = new SpendLedger(':memory:'); resources.push(()=>ledger.close());
  ledger.createCampaign('fixture', 10); ledger.enrollTicket('fixture','ticket-1',cap,{draftPr:true});
  let epoch = 'epoch-1', admitted = true, providerCalls = 0, executorCalls = 0;
  const executor: Executor = { workspaceRoot:'/fixture', readFile:async()=>{executorCalls++;return 'content';},
    writeFile:async()=>{executorCalls++;}, listFiles:async()=>[],grep:async()=>[],
    run:async()=>{executorCalls++;return {stdout:'ok',stderr:'',exitCode:0,timedOut:false};} };
  const options: SessionOptions = {
    admission:{taskId:'task-1',requestId:'request-1',ticketId:'ticket-1',actionId:'action-1',fingerprint:'fp-1',ownerEpoch:'epoch-1',deadlineMs:Date.now()+60_000},
    capabilityToken:token,ledger,provider:'deepseek',model:'deepseek-v4-pro',providerApiKey:'fixture-provider-key',
    fetch:(async()=>{providerCalls++; return Response.json({id:'msg-fixture',type:'message',role:'assistant',model:'deepseek-v4-pro',
      content:[{type:'text',text:'completed in prose only'}],stop_reason:'end_turn',stop_sequence:null,
      usage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0}});}),
    executor,allowedTools:['read_file','run_bash','finish','report_blocked'],finishGateCommand:'bun run check',
    currentOwnerEpoch:()=>epoch,assertAdmission:()=>{if(!admitted)throw new Error('revoked');},
    ...(progress ? {progress} : {}),
    ...(trace ? {trace} : {}),
    ...overrides,
  };
  const host=createSessionHost(options);resources.push(()=>host.dispose());
  const request=(path:string,body:unknown,auth=token)=>new Request('http://127.0.0.1:1234'+path,{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(body)});
  const invoke=(name:string,args:unknown,id=name)=>host.handle(request('/tools/execute',{taskId:'task-1',token,ownerEpoch:'epoch-1',callId:id,name,arguments:args}));
  return {host,ledger,request,invoke,options,counts:()=>({providerCalls,executorCalls}),revoke:()=>{admitted=false;},changeOwner:()=>{epoch='epoch-2';}};
}
test('unauthenticated and cross-task routes never expose state or execute',async()=>{
 const f=fixture();expect((await f.host.handle(f.request('/tools/state',{taskId:'task-1',ownerEpoch:'epoch-1'},'bad'))).status).toBe(401);
 expect((await f.host.handle(f.request('/tools/state',{taskId:'task-2',ownerEpoch:'epoch-1'}))).status).toBe(403);
 expect(f.counts().executorCalls).toBe(0);expect(f.counts().providerCalls).toBe(0);
});
test('real ledger is shared by model endpoint; model prose cannot finish',async()=>{
 const f=fixture();const response=await f.host.handle(f.request('/v1/chat/completions',{model:'deepseek-v4-pro',messages:[{role:'user',content:'hello'}],max_tokens:32,stream:false}));
 expect(response.status).toBe(200);expect(f.ledger.status('ticket-1')!.attemptCount).toBe(1);
 expect(f.host.result({status:'finished',iterations:1}).status).toBe('no_finish');expect(f.host.result({}).publicationApproved).toBe(false);
});
test('actual Gary finish gate governs result across RPC requests',async()=>{
 const f=fixture();await f.invoke('finish',{summary:'done'},'finish-early');
 expect(f.host.result({status:'finished'}).status).toBe('no_finish');
 await f.invoke('run_bash',{command:'bun run check'},'check');await f.invoke('finish',{summary:'verified'},'finish-after-check');
 const result=f.host.result({status:'finished',iterations:3});expect(result.status).toBe('finished');expect(result.summary).toBe('verified');
 expect(result.runLog).toHaveLength(1);expect(result.publicationApproved).toBe(false);expect(f.host.result({status:'error'}).status).toBe('error');
 const state=await (await f.host.handle(f.request('/tools/state',{taskId:'task-1',ownerEpoch:'epoch-1'}))).json();expect(state.runLog).toEqual([]);expect(state.runLogCount).toBe(1);
});
test('revoked canonical admission and ownership fence all routes and completion',async()=>{
 for(const kind of ['revoke','changeOwner'] as const){const f=fixture();f[kind]();
  expect((await f.invoke('read_file',{path:'x'})).status).toBe(409);
  expect((await f.host.handle(f.request('/tools/state',{taskId:'task-1',ownerEpoch:'epoch-1'}))).status).toBe(409);
  expect(f.host.result({status:'finished'}).status).toBe('error');expect(f.counts().executorCalls).toBe(0);}
});
test('prior finish state cannot upgrade an incomplete or failed native result',async()=>{
 const f=fixture();await f.invoke('run_bash',{command:'bun run check'},'check');await f.invoke('finish',{summary:'verified'},'finish-after-check');
 for(const status of ['no_finish','blocked',undefined]) expect(f.host.result(status ? {status} : {}).status).toBe('no_finish');
 expect(f.host.result({status:'iteration_cap'}).status).toBe('iteration_cap');
 expect(f.host.result({status:'error'}).status).toBe('error');expect(f.host.result({status:'timeout'}).status).toBe('timeout');
 expect(f.host.result({status:'finished'}).status).toBe('finished');
});
test('terminal allocation prevents tool work and creates no new attempts',async()=>{
 const f=fixture();f.ledger.markTerminal('ticket-1','fixture_closed');
 expect((await f.invoke('read_file',{path:'x'})).status).toBe(409);expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);
});
test('manifest excludes provider secret and rejects unreviewed endpoint',()=>{
 const f=fixture();const task={prompt:'task',systemPrompt:'Gary voice',maxIterations:4,maxTokens:32};
 const m=f.host.manifest('http://127.0.0.1:1234/',task);expect(m.tools.map(t=>t.function.name)).toEqual(['read_file','run_bash','finish','report_blocked']);
 expect(JSON.stringify(m)).not.toContain('fixture-provider-key');expect(m.systemPrompt).toBe('Gary voice');
 expect(()=>f.host.manifest('https://external.example/',task)).toThrow();expect(()=>f.host.manifest('http://127.0.0.1:1234/',{...task,maxIterations:100})).toThrow();
});
test('dispose revokes scope without resetting any allocation',async()=>{
 const f=fixture();f.host.dispose();expect((await f.invoke('read_file',{path:'x'})).status).toBe(409);
 expect(f.ledger.status('ticket-1')!.state).toBe('active');expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);
});
test('disposal cancels stalled tool request body instead of leaving I/O pending',async()=>{
 const f=fixture();let canceled=false;
 const body=new ReadableStream<Uint8Array>({start(){},cancel(){canceled=true;}});
 const pending=f.host.handle(new Request('http://127.0.0.1:1234/tools/execute',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body}));
 await Bun.sleep(1);f.host.dispose();const reply=await pending;
 expect(reply.status).toBe(409);expect(canceled).toBe(true);expect(f.counts().executorCalls).toBe(0);
});
function progressFixture(read?: (signal?: AbortSignal) => TrustedProgressSnapshot | Promise<TrustedProgressSnapshot>) {
 const baseline:TrustedProgressSnapshot={scope:{taskId:'task-1',workspaceId:'fixture',ownerEpoch:'epoch-1',allocationId:'ticket-1'},sequence:0,allocationState:'active',
  workspace:{baselineDigest:'a'.repeat(64),currentDigest:'a'.repeat(64),taskDiff:null},
  testRuns:[{runId:'baseline-tests',origin:'baseline',status:'passed',workspaceDigest:'a'.repeat(64),taskDiffDigest:null,acceptanceIds:['feature']} ]};
 let sequence=0;
 const guard=createProgressGuard({scope:baseline.scope,acceptanceIds:['feature'],baseline,
  policy:{maxModelRequests:10,maxModelRequestsWithoutProgress:2,maxSuccessfulToolCalls:10,toolRepeatWindow:2,maxRepeatedToolCalls:2},
  readTrustedSnapshot:read ?? (()=>({...structuredClone(baseline),sequence:++sequence}))});
 const f=fixture(guard);
 const model=()=>f.host.handle(f.request('/v1/chat/completions',{model:'deepseek-v4-pro',messages:[{role:'user',content:'task'}],max_tokens:32,stream:false}));
 return {...f,guard,model};
}
test('configured progress stop runs before spending and cannot release or reopen an allocation',async()=>{
 const f=progressFixture();
 expect((await f.model()).status).toBe(200);expect((await f.model()).status).toBe(200);
 expect((await f.model()).status).toBe(409);
 expect(f.guard.state.stopReason).toBe('no_verified_progress');expect(f.counts().providerCalls).toBe(2);
 expect(f.ledger.status('ticket-1')!.attemptCount).toBe(2);expect(f.ledger.status('ticket-1')!.state).toBe('active');
 expect(f.host.result({status:'finished'}).status).toBe('error');
 expect((await f.model()).status).toBe(409);expect(f.ledger.status('ticket-1')!.attemptCount).toBe(2);
});
test('successful repeated tool calls are observations, not progress evidence',async()=>{
 const f=progressFixture();expect((await f.model()).status).toBe(200);
 expect((await f.invoke('read_file',{path:'same'},'read1')).status).toBe(200);
 expect((await f.invoke('read_file',{path:'same'},'read2')).status).toBe(200);
 expect((await f.model()).status).toBe(409);expect(f.guard.state.stopReason).toBe('repetitive_tool_calls');
 expect(f.guard.state.counters.progressAdvances).toBe(0);expect(f.counts().providerCalls).toBe(1);
});
test('invalid model schemas never consume progress allowance',async()=>{
 const f=progressFixture();
 expect((await f.host.handle(f.request('/v1/chat/completions',{model:'deepseek-v4-pro',messages:[],max_tokens:32}))).status).toBe(400);
 expect(f.guard.state.counters.modelRequests).toBe(0);expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);
});
test('request cancellation releases a stalled progress snapshot without reserving spend',async()=>{
 let snapshotSignal:AbortSignal|undefined;
 const f=progressFixture(signal=>{snapshotSignal=signal;return new Promise(()=>{});});
 const cancellation=new AbortController();
 const request=new Request(f.request('/v1/chat/completions',{model:'deepseek-v4-pro',messages:[{role:'user',content:'task'}],max_tokens:32}),{signal:cancellation.signal});
 const pending=f.host.handle(request);await Bun.sleep(2);cancellation.abort();
 expect((await pending).status).toBe(408);expect(snapshotSignal?.aborted).toBe(true);
 expect(f.guard.state.stopReason).toBe('cancelled');expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);expect(f.counts().providerCalls).toBe(0);
});
test('budget refusal remains distinct from a native transport error',async()=>{
 const f=fixture(undefined,0.01);
 const response=await f.host.handle(f.request('/v1/chat/completions',{model:'deepseek-v4-pro',messages:[{role:'user',content:'task'}],max_tokens:32}));
 expect(response.status).toBe(402);expect(f.counts().providerCalls).toBe(0);
 const result=f.host.result({status:'error'});expect(result.status).toBe('error');expect(result.terminationReason).toBe('budget_exhausted');expect(result.errorMessage).toBe('budget_exhausted');
 expect(f.ledger.status('ticket-1')!.state).toBe('exhausted');expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);
});
function tracedFixture(cap=5,overrides:Partial<SessionOptions>={}){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'gary-session-trace-')));resources.push(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'trace.jsonl');
 const trace=createAuditTrace({path,binding:{taskId:'task-1',requestId:'request-1',actionId:'action-1',ownerEpoch:'epoch-1',ticketId:'ticket-1'}});
 const f=fixture(undefined,cap,trace,overrides);
 const events=()=>readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 return {...f,trace,path,events};
}
test('private durable trace retains tool exits and hashes on failed native completion',async()=>{
 const f=tracedFixture();
 f.options.executor.run=async()=>({stdout:'private output fixture',stderr:'private error fixture',exitCode:7,timedOut:false});
 await f.invoke('run_bash',{command:'printf private-command'},'failed-check');
 const outcome=f.host.result({status:'error'});expect(f.host.finalizeTrace(outcome)).toBe(true);
 const events=f.events(),raw=readFileSync(f.path,'utf8');
 const executed=events.find(e=>e.operationId?.startsWith('executor-')&&e.stage==='result');
 expect(executed.exitCode).toBe(7);expect(executed.stdout.bytes).toBe(22);expect(executed.stderr.bytes).toBe(21);
 expect(executed.command.sha256).toHaveLength(64);expect(executed.parentOperationId).toStartWith('tool-');
 expect(events.at(-1).status).toBe('error');expect(events.at(-1).pendingOperationIds).toEqual([]);
 for(const secret of ['private output fixture','private error fixture','printf private-command',token,'fixture-provider-key'])expect(raw).not.toContain(secret);
 expect(events.at(-1).modelState.thinking).toBe('unknown');expect(events.at(-1).modelState.effort).toBe('unknown');
});
test('executor exceptions are durably recorded without raw error text',async()=>{
 const f=tracedFixture();f.options.executor.run=async()=>{throw new Error('sensitive exception fixture');};
 expect((await f.invoke('run_bash',{command:'fixture'},'throws')).status).toBe(400);
 expect(f.host.finalizeTrace(f.host.result({status:'error'}))).toBe(true);
 expect(f.events().filter(e=>e.stage==='error')).toHaveLength(2);
 expect(readFileSync(f.path,'utf8')).not.toContain('sensitive exception fixture');
});
test('trace persistence failure prevents subsequent model spend and cannot become success',async()=>{
 const f=tracedFixture();chmodSync(f.path,0o640);
 const response=await f.host.handle(f.request('/v1/chat/completions',{model:'deepseek-v4-pro',messages:[{role:'user',content:'privateprompt'}],max_tokens:32}));
 expect(response.status).toBe(409);expect(f.trace.failed).toBe(true);expect(f.counts().providerCalls).toBe(0);expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);
 const result=f.host.result({status:'finished'});expect(result.status).toBe('error');expect(result.terminationReason).toBe('trace_failed');expect(f.host.finalizeTrace(result)).toBe(false);
});
test('durable terminal trace identifies budget exhaustion without a provider request',async()=>{
 const f=tracedFixture(0.01);
 expect((await f.host.handle(f.request('/v1/chat/completions',{model:'deepseek-v4-pro',messages:[{role:'user',content:'task'}],max_tokens:32}))).status).toBe(402);
 const result=f.host.result({status:'error'});expect(f.host.finalizeTrace(result)).toBe(true);
 expect(f.events().at(-1).status).toBe('budget_exhausted');expect(f.events().at(-1).errorCode).toBe('reservation_exhausted');
 expect(f.counts().providerCalls).toBe(0);
});

const modelRequestBody={model:'deepseek-v4-pro',messages:[{role:'user',content:'private-prompt'}],max_tokens:32};
function rejectedProviderBody(){return {id:'private-response-id',type:'message',role:'assistant',model:'deepseek-v4-pro',
 content:[{type:'thinking',thinking:'private-reasoning',signature:'private-signature'},
  {type:'tool_use',id:'private-call-id',name:'read_file',input:{path:'private-path'}}],stop_reason:'tool_use',
 usage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0}};}
test('model trace preserves precise fixed rejection metadata without provider content',async()=>{
 const f=tracedFixture(5,{thinking:'disabled',fetch:async request=>{
  expect((await request.json()).thinking).toEqual({type:'disabled'});return Response.json(rejectedProviderBody());}});
 const request=f.request('/v1/chat/completions',{...modelRequestBody,tools:f.host.manifest('http://127.0.0.1:1234/',{prompt:'task',systemPrompt:'Gary',maxIterations:2,maxTokens:32}).tools});
 expect((await f.host.handle(request)).status).toBe(502);
 const result=f.host.result({status:'error'});expect(f.host.finalizeTrace(result)).toBe(true);
 const events=f.events(),failure=events.find(event=>event.kind==='model'&&event.stage==='error');
 expect(failure.errorCode).toBe('unsupported_provider_response');
 expect(failure.responseRejection).toEqual({category:'unsupported_block_type',blockTypes:['thinking','tool_use'],blockCount:2,stopReason:'tool_use',modelMatches:true});
 expect(events.filter(event=>event.kind==='model'&&event.stage==='error')).toHaveLength(1);
 expect(events.find(event=>event.kind==='model'&&event.stage==='start').modelState.thinking).toBe('disabled');
 expect(events.at(-1).modelState.thinking).toBe('disabled');
 const raw=readFileSync(f.path,'utf8');
 for(const secret of ['private-prompt','private-response-id','private-reasoning','private-signature','private-call-id','private-path',token,'fixture-provider-key'])expect(raw).not.toContain(secret);
 expect(f.ledger.status('ticket-1')!.attemptCount).toBe(1);
});
test('model trace keeps local invalid-request code and unknown policy without a provider call',async()=>{
 const f=tracedFixture();
 expect((await f.host.handle(f.request('/v1/chat/completions',{...modelRequestBody,thinking:{type:'disabled'}}))).status).toBe(400);
 const failed=f.events().find(event=>event.kind==='model'&&event.stage==='error');
 expect(failed.errorCode).toBe('unsupported_request');expect(failed.responseRejection).toBeUndefined();
 expect(failed.modelState.thinking).toBe('unknown');
 expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);
});
test('concurrent rejected requests cannot exchange diagnostic contexts',async()=>{
 let release!:()=>void,started!:()=>void;
 const upstreamStarted=new Promise<void>(resolve=>{started=resolve;}),unblock=new Promise<void>(resolve=>{release=resolve;});
 const f=tracedFixture(5,{fetch:async()=>{started();await unblock;return Response.json(rejectedProviderBody());}});
 const first=f.host.handle(f.request('/v1/chat/completions',modelRequestBody));
 await upstreamStarted;
 expect((await f.host.handle(f.request('/v1/chat/completions',modelRequestBody))).status).toBe(409);
 release();expect((await first).status).toBe(502);
 const errors=f.events().filter(event=>event.kind==='model'&&event.stage==='error');
 expect(errors.map(event=>[event.operationId,event.errorCode])).toEqual([['model-2','request_in_flight'],['model-1','unsupported_provider_response']]);
 expect(errors[0].responseRejection).toBeUndefined();expect(errors[1].responseRejection.category).toBe('unsupported_block_type');
 expect(f.ledger.status('ticket-1')!.attemptCount).toBe(1);
});
test('failure diagnostic persistence failure cancels the session after one accounted provider call',async()=>{
 let path='';
 const f=tracedFixture(5,{fetch:async()=>{chmodSync(path,0o640);return Response.json(rejectedProviderBody());}});path=f.path;
 expect((await f.host.handle(f.request('/v1/chat/completions',modelRequestBody))).status).toBe(409);
 expect(f.trace.failed).toBe(true);expect(f.ledger.status('ticket-1')!.attemptCount).toBe(1);
 expect((await f.host.handle(f.request('/v1/chat/completions',modelRequestBody))).status).toBe(409);
 expect(f.ledger.status('ticket-1')!.attemptCount).toBe(1);
 expect(f.host.result({status:'finished'}).terminationReason).toBe('trace_failed');
});
test('session rejects non-DeepSeek or invalid trusted thinking policy before transport',()=>{
 const f=fixture();
 expect(()=>createSessionHost({...f.options,provider:'z.ai',model:'glm-5.3',thinking:'disabled'})).toThrow('invalid host thinking policy');
 for(const thinking of ['enabled',null,{type:'disabled'}])expect(()=>createSessionHost({...f.options,thinking} as unknown as SessionOptions)).toThrow('invalid host thinking policy');
 expect(f.ledger.status('ticket-1')!.attemptCount).toBe(0);
});
