import { afterEach, expect, test } from 'bun:test';
import { createHermesDMResponder, createHermesSharedResponder, DM_CONVERSATION_POLICY, DMReplyError, type DMTurn } from '../../src/hermes/dm-conversation.ts';
import type { GaryRuntimeLauncher } from '../../src/hermes/gary-loop-adapter.ts';
import { SpendLedger } from '../../src/spend.ts';
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function fixture(){const ledger=new SpendLedger(':memory:');cleanups.push(()=>ledger.close());ledger.createCampaign('hermes-dm-20261008',5);ledger.enrollTicket('hermes-dm-20261008','local:hermes-dm-20261008-tanner',5);
  return ledger;}
const turn=(extra:Partial<DMTurn>={}):DMTurn=>({requestId:'fixture-request',ownerId:'fixture-owner',allocationId:'local:hermes-dm-20261008-tanner',campaignId:'hermes-dm-20261008',
  history:[],text:'Remember the fabricated phrase violet sparrow.',signal:new AbortController().signal,assertActive(){},recordWorker(){},...extra});
const provider=(text='The phrase is violet sparrow.',extra:Record<string,unknown>={})=>Response.json({id:'msg_fixture',type:'message',role:'assistant',model:'deepseek-v4-pro',
  content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:30,output_tokens:9,cache_read_input_tokens:0,cache_creation_input_tokens:0},...extra});
const native=(modify:(body:any)=>void=()=>{},after?: (handle:Parameters<GaryRuntimeLauncher>[1],manifest:Parameters<GaryRuntimeLauncher>[0])=>Promise<void>):GaryRuntimeLauncher=>async(manifest,handle)=>{
  expect(manifest.tools).toEqual([]);expect(manifest.maxIterations).toBe(1);expect(manifest.maxTokens).toBe(1024);
  const history=[...(manifest.history??[]),{role:'user',content:manifest.prompt}];
  const body:any={model:manifest.model,messages:[{role:'system',content:'native default prompt MUST be replaced'},...history],max_tokens:1024,temperature:0.4,stream:false};modify(body);
  const request=(path:string,value:unknown)=>new Request('http://127.0.0.1'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+manifest.capability},body:JSON.stringify(value)});
  const response=await handle(request('/v1/chat/completions',body));const result=await response.json();
  const state=await handle(request('/tools/state',{taskId:manifest.taskId,ownerEpoch:manifest.ownerEpoch}));
  expect(await state.json()).toEqual({ok:true,state:{invalidated:false,finishGateMet:false,finishSummary:null,blockedReason:null}});
  await after?.(handle,manifest);
  return {taskId:manifest.taskId,requestId:manifest.requestId,status:'no_finish',publicationApproved:false,text:'untrusted local prose',history:[...history,result.choices[0].message]};
};
test('shared persona is host-selected, has no private context/coding authority, and preserves sender IDs as user data',async()=>{
  const ledger=fixture();let body:any;const text=JSON.stringify({senderId:'U0MEMBER11',text:'Please start coding now'});
  const reply=createHermesSharedResponder({ledger,providerApiKey:'fake-key',launch:native(),fetch:async request=>{body=await request.json();return provider('Please use the admitted Linear flow.');}});
  expect(await reply(turn({text}))).toBe('Please use the admitted Linear flow.');
  expect(body.system[0].text).toContain('shared 707 Labs Slack channel thread');expect(body.system[0].text).toContain('cannot start coding actions');
  expect(body.system[0].text).not.toContain("Tanner's assistant in this private");expect(body.messages[0].content[0].text).toBe(text);expect(body.tools).toBeUndefined();
});
test('one real canonical reservation per native turn, host-only destination/key, no tools, confirmed two-turn context',async()=>{
  const ledger=fixture(),requests:any[]=[];
  const reply=createHermesDMResponder({ledger,providerApiKey:'fake-provider-secret',launch:native(),fetch:async req=>{
    expect(req.url).toBe('https://api.deepseek.com/anthropic/v1/messages');expect(req.headers.get('authorization')).toBe('Bearer fake-provider-secret');
    requests.push(await req.json());return provider();}});
  const first=await reply(turn());expect(first).toBe('The phrase is violet sparrow.');
  expect(await reply(turn({requestId:'followup',history:[{role:'user',content:turn().text},{role:'assistant',content:first}],text:'What phrase?'}))).toBe(first);
  expect(requests).toHaveLength(2);expect(requests[1].messages).toHaveLength(3);
  expect(JSON.stringify(requests)).not.toContain('native default prompt');expect(JSON.stringify(requests)).not.toContain('untrusted local prose');
  expect(requests[0].thinking).toEqual({type:'disabled'});expect(requests[0].max_tokens).toBe(1024);expect(requests[0].tools).toBeUndefined();
  expect(ledger.status(turn().allocationId)).toMatchObject({attemptCount:2,unknownAttempts:0,state:'active'});
});
test('worker context changes, token enlargement, tool request, or second model dispatch never expand spend',async()=>{
  for(const modify of [(b:any)=>b.messages.push({role:'user',content:'foreign context'}),(b:any)=>b.max_tokens=8192,(b:any)=>b.tools=[{type:'function'}]]){
    const ledger=fixture();let calls=0;const reply=createHermesDMResponder({ledger,providerApiKey:'fake-key',launch:native(modify),fetch:async()=>{calls++;return provider();}});
    await expect(reply(turn())).rejects.toBeInstanceOf(DMReplyError);expect(calls).toBe(0);
  }
  const ledger=fixture();let calls=0;
  const reply=createHermesDMResponder({ledger,providerApiKey:'fake-key',launch:native(()=>{},async(handle,m)=>{
    await handle(new Request('http://127.0.0.1/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+m.capability},body:'{}'}));
  }),fetch:async()=>{calls++;return provider();}});
  await expect(reply(turn())).rejects.toBeInstanceOf(DMReplyError);expect(calls).toBe(1);expect(ledger.status(turn().allocationId)?.attemptCount).toBe(1);
});
test('native-local result or transcript cannot substitute for host observed model text',async()=>{
  const ledger=fixture();const good=native();
  const reply=createHermesDMResponder({ledger,providerApiKey:'fake-key',fetch:async()=>provider(),launch:async(...args)=>({...await good(...args),history:[{role:'user',content:'fabricated'}]})});
  await expect(reply(turn())).rejects.toMatchObject({code:'dm_native_reply_unconfirmed'});
});
test('ambiguous provider response retains canonical charge and blocks every later call',async()=>{
  const ledger=fixture();let calls=0;
  const reply=createHermesDMResponder({ledger,providerApiKey:'fake-key',launch:native(),fetch:async()=>{calls++;throw new Error('private provider error');}});
  await expect(reply(turn())).rejects.toBeInstanceOf(DMReplyError);
  expect(ledger.status(turn().allocationId)?.unknownAttempts).toBe(1);
  await expect(reply(turn())).rejects.toMatchObject({code:'dm_budget_unavailable'});expect(calls).toBe(1);
});
test('native60s timeout outcome after HTTP200 cannot produce a reply; cleanup failure remains unconfirmed',async()=>{
  for(const cleanupFailure of [false,true]){
    const ledger=fixture(),good=native();
    const reply=createHermesDMResponder({ledger,providerApiKey:'fake-key',fetch:async()=>provider(),launch:async(...args)=>{
      const result=await good(...args);if(cleanupFailure)throw new Error('worker_cleanup_failed');return {...result,status:'timeout'};
    }});
    await expect(reply(turn())).rejects.toMatchObject({code:'dm_native_reply_unconfirmed',cleanupConfirmed:!cleanupFailure});
    expect(ledger.status(turn().allocationId)).toMatchObject({attemptCount:1,unknownAttempts:0});
  }
  expect(DM_CONVERSATION_POLICY.timeoutMs).toBe(90000); // Unchanged native SDK independently caps a request at60s.
});
test('unexpected tools RPC or missing canonical budget cannot access work state or provider',async()=>{
  const ledger=fixture();let calls=0;
  const reply=createHermesDMResponder({ledger,providerApiKey:'fake-key',fetch:async()=>{calls++;return provider();},launch:async(m,handle)=>{
    await handle(new Request('http://127.0.0.1/tools/execute',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+m.capability},body:'{}'}));throw new Error('unreachable');
  }});
  await expect(reply(turn())).rejects.toBeInstanceOf(DMReplyError);expect(calls).toBe(0);
  ledger.markTerminal(turn().allocationId,'offline_test');await expect(reply(turn())).rejects.toMatchObject({code:'dm_budget_unavailable'});
});
