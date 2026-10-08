import { expect, test } from 'bun:test';
import { CODING_VERIFICATION_POLICY as POLICY, createActionVerification, snapshotLongTestPolicy } from '../src/verification-policy.ts';
import type { ExecResult, RunOpts } from '../src/executors/index.ts';
const ok:ExecResult={stdout:'passed',stderr:'',exitCode:0,timedOut:false};
function fixture() {
  let owner=true;
  const verification=createActionVerification({policy:POLICY,assertActive(){if(!owner)throw new Error('owner_revoked');}});
  verification.bindDeadline(Date.now()+9_000_000);
  return {verification,revoke(){owner=false;}};
}
test('fixed policy snapshots are detached, immutable, exact and exclude host executable authority',()=>{
  const copy=structuredClone(POLICY),snapshot=snapshotLongTestPolicy(copy);
  (copy.commands['bun run ci:full'] as {timeoutMs:number}).timeoutMs=1;
  expect(snapshot.commands['bun run ci:full']).toEqual({timeoutMs:1_800_000,maxStarts:4});
  expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.commands['bun run check'])).toBe(true);
  expect(Object.hasOwn(snapshot,'publicationCommand')).toBe(false);
  let invoked=false;const getter=Object.defineProperty({...POLICY},'version',{get(){invoked=true;return 1;}});
  expect(()=>snapshotLongTestPolicy(getter)).toThrow('invalid_policy');expect(invoked).toBe(false);
  for(const key of ['pollWaitMs','heartbeatMs','maxPolls','version'] as const)expect(()=>snapshotLongTestPolicy({...POLICY,[key]:0} as never)).toThrow();
  expect(()=>snapshotLongTestPolicy({...POLICY,commands:{...POLICY.commands,alias:{timeoutMs:1,maxStarts:1}}} as never)).toThrow();
});
test('one action shares conservative finite starts across primary, host, repair and reviewer',async()=>{
  const {verification:v}=fixture();let starts=0;
  for(const role of ['primary','host','repair','reviewer'])await v.run('bun run ci:full',{},async opts=>{expect(opts.timeoutMs).toBe(1_800_000);starts++;return {...ok,stdout:role};});
  await expect(v.run('bun run ci:full',{},async()=>{starts++;return ok;})).rejects.toThrow('test_start_limit');
  for(let i=0;i<8;i++)await v.run('bun run check',{},async opts=>{expect(opts.timeoutMs).toBe(600_000);return ok;});
  await expect(v.run('bun run check',{},async()=>ok)).rejects.toThrow('test_start_limit');
  expect(starts).toBe(4);expect(v.snapshot().counts).toEqual({'bun run ci:full':4,'bun run check':8});
  v.bindDeadline(v.snapshot().deadlineMs!);await expect(v.run('bun run ci:full',{},async()=>ok)).rejects.toThrow('test_start_limit');
});
test('failed spawn consumes its start and cannot reset at repair boundaries',async()=>{
  const {verification:v}=fixture();await expect(v.run('bun run ci:full',{},async()=>{throw new Error('spawn_failed');})).rejects.toThrow('spawn_failed');
  expect(v.snapshot().counts['bun run ci:full']).toBe(1);
  await v.run('bun run ci:full',{},async()=>({...ok,exitCode:1}));expect(v.snapshot().counts['bun run ci:full']).toBe(2);
});
test('only exact original strings receive long ceilings; all aliases keep old generic bounds',async()=>{
  const {verification:v}=fixture();
  for(const command of ['bun run ci:full ',' bun run ci:full','bun run ci:full && true','set -euo pipefail\nbun run ci:full','bun run check\n','echo generic']) {
    await v.run(command,{},async opts=>{expect(opts.timeoutMs).toBe(120_000);return ok;});
    await v.run(command,{timeoutMs:9_000_000},async opts=>{expect(opts.timeoutMs).toBe(900_000);return ok;});
  }
  expect(v.snapshot().counts).toEqual({'bun run ci:full':0,'bun run check':0});
});
test('caller and action ceilings narrow commands without extending a bound action',async()=>{
  const {verification:v}=fixture();const now=Date.now(),action=now+2000;v.bindDeadline(action);
  await v.run('bun run ci:full',{timeoutMs:1000,deadlineMs:now+700},async opts=>{expect(opts.timeoutMs).toBe(1000);expect(opts.deadlineMs).toBe(now+700);return ok;});
  expect(()=>v.bindDeadline(action+1)).toThrow('invalid_action_deadline');
  for(const opts of [{timeoutMs:Infinity},{timeoutMs:0},{deadlineMs:NaN},{cwd:'.'},{env:{PATH:'/tmp'}}])await expect(v.run('bun run check',opts,async()=>ok)).rejects.toThrow();
  expect(v.snapshot().counts['bun run check']).toBe(0);
});
test('unbound, cancelled and superseded actions cannot spawn or accept a result',async()=>{
  const unbound=createActionVerification({policy:POLICY,assertActive(){}});
  await expect(unbound.run('bun run check',{},async()=>ok)).rejects.toThrow('unbound_action');
  const f=fixture();await expect(f.verification.run('bun run check',{},async()=>{f.revoke();return ok;})).rejects.toThrow('owner_revoked');
  const v=createActionVerification({policy:POLICY,assertActive(){}}),controller=new AbortController();v.bindDeadline(Date.now()+1000,controller.signal);controller.abort();
  await expect(v.run('bun run check',{},async()=>ok)).rejects.toThrow();expect(v.snapshot().counts['bun run check']).toBe(0);
});
test('one active lifecycle cannot overlap a second command',async()=>{
  const {verification:v}=fixture();let release!:()=>void;const pending=v.run('bun run ci:full',{},async()=>{await new Promise<void>(r=>release=r);return ok;});
  await expect(v.run('bun run check',{},async()=>ok)).rejects.toThrow('concurrent_verification');release();await pending;
  expect(v.snapshot().counts['bun run check']).toBe(0);
});
test('host and native long jobs carry the same immutable action/journal binding',async()=>{
  const journal={directory:'/tmp/offline-journal',close(){}};
  const context={taskId:'task',actionId:'1',ownerEpoch:'epoch',journal};
  const v=createActionVerification({policy:POLICY,assertActive(){},testJobContext:context});v.bindDeadline(Date.now()+10_000);
  let first:RunOpts['testJob'];
  await v.run('bun run ci:full',{},async opts=>{first=opts.testJob;expect(first).toMatchObject(context);expect(Object.isFrozen(first)).toBe(true);return ok;});
  const native={...context,jobId:'native-job',requestId:'native-request'};
  await v.run('bun run check',{testJob:native},async opts=>{expect(opts.testJob).toEqual(native);expect(opts.testJob).not.toBe(native);expect(Object.isFrozen(opts.testJob)).toBe(true);return ok;});
  await expect(v.run('bun run check',{testJob:{...native,ownerEpoch:'other'}},async()=>ok)).rejects.toThrow('test_job_binding');
  expect(v.snapshot().counts['bun run check']).toBe(1);
});

test('actual elapsed command deadline and cancellation reject late successful results',async()=>{
 const {verification:v}=fixture();await expect(v.run('bun run check',{timeoutMs:5},async()=>{await new Promise(r=>setTimeout(r,15));return ok;})).rejects.toThrow();
 expect(v.snapshot().counts['bun run check']).toBe(1);
 const controller=new AbortController();await expect(v.run('bun run ci:full',{signal:controller.signal},async opts=>{controller.abort();expect(opts.signal?.aborted).toBe(true);return ok;})).rejects.toThrow();
});

for(const reason of ['owner_revoked','unknown_usage'])test('host heartbeat aborts '+reason+' and awaits cleanup',async()=>{
 let active=true,cleaned=false;
 const v=createActionVerification({policy:POLICY,assertActive(){if(!active)throw new Error(reason);}});v.bindDeadline(Date.now()+10_000);
 const running=v.run('bun run ci:full',{},async opts=>{
  await new Promise<void>(resolve=>opts.signal!.addEventListener('abort',()=>resolve(),{once:true}));
  await new Promise(r=>setTimeout(r,10));cleaned=true;return {...ok,exitCode:137};
 });
 active=false;await expect(running).rejects.toThrow(reason);expect(cleaned).toBe(true);
});

test('verification busy lease remains held after cancellation until cleanup resolves, then releases once',async()=>{
 const {verification:v}=fixture(),abort=new AbortController();
 let release!:()=>void,entered!:()=>void,settled=false,starts=0;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const hold=new Promise<void>(resolve=>{release=resolve;});
 const running=v.run('bun run ci:full',{signal:abort.signal},async opts=>{
  starts++;entered();await hold;expect(opts.signal!.aborted).toBe(true);return ok;
 });
 // Observe the rejection immediately so the intentional late cancellation cannot
 // appear as an unhandled test rejection when cleanup is released below.
 const outcome=running.then(value=>({value,error:undefined}),error=>({value:undefined,error})).finally(()=>{settled=true;});
 try {
 await ready;abort.abort();
 await expect(v.run('bun run check',{},async()=>{starts++;return ok;})).rejects.toThrow('concurrent_verification');
 expect(settled).toBe(false);expect(starts).toBe(1);expect(v.snapshot().counts['bun run check']).toBe(0);
 release();const result=await outcome;expect(result.value).toBeUndefined();expect(result.error).toBeInstanceOf(Error);
 await expect(v.run('bun run check',{},async()=>{starts++;return ok;})).resolves.toEqual(ok);
 expect(starts).toBe(2);expect(v.snapshot().counts).toEqual({'bun run ci:full':1,'bun run check':1});
 } finally {release();await outcome;}
});
