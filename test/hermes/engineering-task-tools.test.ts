import {expect,test} from 'bun:test';
import {createEngineeringTaskTools,type EngineeringTaskToolOptions} from '../../src/hermes/engineering-task-tools.ts';

function fixture(delta:Partial<EngineeringTaskToolOptions>={}) {
  const children:any[]=[],codes:any[]=[],fences:string[]=[];let owned=true;
  const abort=new AbortController();
  const options:EngineeringTaskToolOptions={scope:{taskId:'task',sessionId:'session',ownerEpoch:'owner',deadlineMs:200,
    scopeKey:'scope',allocationId:'allocation',delegationDepth:0},signal:abort.signal,now:()=>100,allowedCodeTools:['terminal','read_file'],
    assertOwner:()=>{if(!owned)throw Error('owner lost');},fence:r=>fences.push(r),
    runChild:async r=>{children.push(r);return{cleanupConfirmed:true,result:{status:'completed'}};},
    runCode:async r=>{codes.push(r);return{cleanupConfirmed:true,result:{status:'success'}};},...delta};
  return{tool:createEngineeringTaskTools(options),children,codes,fences,abort,revoke:()=>{owned=false;}};
}
const call=(toolName:string,originalArgs:Record<string,unknown>,id='call')=>({toolCallId:id,admissionId:'admit',toolName,originalArgs});
test('native task delegation binds both separate children to the original task budget/scope/deadline',async()=>{
  const f=fixture(),context=call('delegate_task',{tasks:[{goal:'Implement A'},{goal:'Test B',context:'Only tests'}]});
  for(const taskIndex of [0,1])await f.tool.execute('delegate.run',{operationId:'op'+taskIndex,taskIndex,
    goal:taskIndex?'Test B':'Implement A',context:taskIndex?'Only tests':null},context);
  expect(f.children).toHaveLength(2);expect(f.children.map(r=>r.ordinal)).toEqual([1,2]);
  expect(f.children[0].childId).not.toBe(f.children[1].childId);
  for(const child of f.children){expect(child.scope).toEqual({taskId:'task',sessionId:'session',ownerEpoch:'owner',deadlineMs:200,scopeKey:'scope',allocationId:'allocation',delegationDepth:0});expect(child.delegationDepth).toBe(1);}
  await expect(f.tool.execute('delegate.run',{operationId:'third',taskIndex:0,goal:'More',context:null},call('delegate_task',{goal:'More'},'another'))).rejects.toThrow('child_replayed_or_limit');
});
test('native task tools reject changed content, invented scope, recursion and async before callbacks',async()=>{
  const f=fixture(),args={operationId:'op',taskIndex:0,goal:'Work',context:null};
  for(const [value,context] of [
    [{...args,goal:'Other'},call('delegate_task',{goal:'Work'})],
    [{...args,allocationId:'free'},call('delegate_task',{goal:'Work'})],
    [args,call('delegate_task',{goal:'Work',background:true})],
    [args,call('delegate_task',{goal:'Work',role:'orchestrator'})],
    [args,call('terminal',{goal:'Work'})],
  ] as const)await expect(f.tool.execute('delegate.run',value,context)).rejects.toThrow();
  expect(f.children).toHaveLength(0);
  const nested=fixture({scope:{taskId:'task',sessionId:'session',ownerEpoch:'owner',deadlineMs:200,scopeKey:'scope',allocationId:'allocation',delegationDepth:1}});
  await expect(nested.tool.execute('delegate.run',args,call('delegate_task',{goal:'Work'}))).rejects.toThrow('delegation_scope');
  expect(nested.children).toHaveLength(0);
});
test('native code inherits only host-selected nested tools and consumes exactly once',async()=>{
  const f=fixture(),args={operationId:'op',code:'print(1)'},context=call('execute_code',{code:'print(1)'});
  expect(await f.tool.execute('code.run',args,context)).toEqual({result:{status:'success'}});
  expect(f.codes[0].allowedTools).toEqual(['terminal','read_file']);expect(f.codes[0].parentCall).toEqual(context);
  await expect(f.tool.execute('code.run',args,context)).rejects.toThrow('operation_replayed_or_limit');
  await expect(f.tool.execute('code.run',{operationId:'op2',code:'print(2)'},context)).rejects.toThrow('code_request_changed');
  expect(f.codes).toHaveLength(1);
  expect(()=>fixture({allowedCodeTools:['delegate_task']})).toThrow('configuration');
});
test('native task execution is serialized; unknown cleanup permanently fences retries',async()=>{
  let resolve!:()=>void;const gate=new Promise<void>(r=>resolve=r);
  const f=fixture({runCode:async()=>{await gate;return{result:{status:'ok'},cleanupConfirmed:true};}}),context=call('execute_code',{code:'pass'});
  const pending=f.tool.execute('code.run',{operationId:'one',code:'pass'},context);
  await expect(f.tool.execute('code.run',{operationId:'two',code:'pass'},context)).rejects.toThrow('concurrent_operation');
  resolve();await pending;
  const lost=fixture({runChild:async()=>({result:{},cleanupConfirmed:false} as any)}),c=call('delegate_task',{goal:'Work'});
  await expect(lost.tool.execute('delegate.run',{operationId:'first',taskIndex:0,goal:'Work',context:null},c)).rejects.toThrow('result_or_cleanup');
  await expect(lost.tool.execute('delegate.run',{operationId:'retry',taskIndex:0,goal:'Work',context:null},c)).rejects.toThrow('fenced');
  expect(lost.fences).toEqual(['native_task_operation_uncertain']);
});
test('native task authority and fixed deadline are checked before effects and after await',async()=>{
  for(const mode of ['owner','abort','deadline'] as const){
    const f=fixture(mode==='deadline'?{now:()=>200}:{});if(mode==='owner')f.revoke();if(mode==='abort')f.abort.abort();
    await expect(f.tool.execute('code.run',{operationId:'op',code:'pass'},call('execute_code',{code:'pass'}))).rejects.toThrow();
    expect(f.codes).toHaveLength(0);
  }
  let now=100;const f=fixture({now:()=>now,runCode:async()=>{now=201;return{result:{},cleanupConfirmed:true};}});
  await expect(f.tool.execute('code.run',{operationId:'op',code:'pass'},call('execute_code',{code:'pass'}))).rejects.toThrow('deadline');
  expect(f.fences).toHaveLength(1);
});
