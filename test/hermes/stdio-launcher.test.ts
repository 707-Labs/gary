import { describe, test, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createStdioLauncher } from '../../src/hermes/stdio-launcher.ts';
import type { GaryRuntimeManifest } from '../../src/hermes/gary-loop-adapter.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/stdio-worker-fixture.py', import.meta.url));
const manifest = (timeout = 5000): GaryRuntimeManifest => ({
  taskId:'fixture-task',requestId:'fixture-request',ownerEpoch:'fixture-owner',capability:'x'.repeat(40),
  modelBaseUrl:'http://127.0.0.1/v1',executorUrl:'http://127.0.0.1/tools/execute',stateUrl:'http://127.0.0.1/tools/state',
  model:'glm-5.3',prompt:'offline',systemPrompt:'Gary',tools:[],maxIterations:3,maxTokens:100,
  temperature:0.3,deadlineMs:Date.now()+timeout,
});
function setup(mode: string, cleanup?:()=>Promise<void>) {
  let cleanups = 0, calls = 0;
  const launch = createStdioLauncher({ command:['/usr/bin/python3','-I',fixture,mode], cwd:root,env:{PATH:'/usr/bin:/bin'},
    async cleanup() { cleanups++; await cleanup?.(); } });
  const handle = async (req: Request) => { calls++; expect(req.method).toBe('POST');
    expect(new URL(req.url).pathname).toBe('/tools/state'); expect(req.headers.get('authorization')).toBe('Bearer '+'x'.repeat(40));
    return Response.json({ok:true}); };
  return {launch,handle,get cleanups(){return cleanups;},get calls(){return calls;}};
}
describe('stdio launcher with real offline child and fake host',()=>{
  test('round trip binds outcome and awaits cleanup',async()=>{
    let cleaned = false;
    const f=setup('valid',async()=>{await new Promise(r=>setTimeout(r,15));cleaned=true;});
    const m=manifest();
    expect(await f.launch(m,f.handle,new AbortController().signal)).toEqual({taskId:m.taskId,requestId:m.requestId,status:'no_finish',publicationApproved:false});
    expect(f.calls).toBe(1);expect(f.cleanups).toBe(1);expect(cleaned).toBe(true);
  });
  test('does not inherit operator environment',async()=>{
    process.env.GARY_TEST_OPERATOR_SECRET='do-not-inherit';
    const f=setup('env');
    try {await f.launch(manifest(),async req=>{expect((await req.json() as any).secretInherited).toBe(false);return Response.json({ok:true});},new AbortController().signal);}
    finally {delete process.env.GARY_TEST_OPERATOR_SECRET;}
    expect(f.cleanups).toBe(1);
  });
  test('preserves bounded untrusted phase text with capability redaction',async()=>{
    const f=setup('text'),m=manifest();
    const result=await f.launch(m,f.handle,new AbortController().signal);
    expect(result.text).toStartWith('[REDACTED]');expect(result.text).not.toContain(m.capability);
    expect(Buffer.byteLength(result.text!)).toBeLessThanOrEqual(65536);expect(result.publicationApproved).toBe(false);
  });
  for(const mode of ['garbage','huge','partial','missing','bad_result','publish','auth','path','header','id','duplicate','after','exit1','overflow','secret_history']) {
    test('rejects '+mode+' and completes cleanup',async()=>{
      const f=setup(mode);
      await expect(f.launch(manifest(),f.handle,new AbortController().signal)).rejects.toThrow('worker_protocol_or_lifetime_rejected');
      expect(f.cleanups).toBe(1);
      if(['auth','path','header','id','garbage','huge','partial','missing','bad_result','publish','overflow','secret_history'].includes(mode)) expect(f.calls).toBe(0);
    });
  }
  for(const mode of ['sleep','sleep_after']) {
    test('shared deadline kills '+mode+' before returning',async()=>{
      const f=setup(mode); const start=Date.now();
      await expect(f.launch(manifest(350),f.handle,new AbortController().signal)).rejects.toThrow();
      expect(Date.now()-start).toBeLessThan(3000);expect(f.cleanups).toBe(1);
    });
  }
  test('abort kills child and awaits cleanup',async()=>{
    const f=setup('sleep'),signal=new AbortController();
    const result=f.launch(manifest(),f.handle,signal.signal);
    setTimeout(()=>signal.abort(),100);
    await expect(result).rejects.toThrow();expect(f.cleanups).toBe(1);
  });
  test('cancels a stalled response stream',async()=>{
    const f=setup('valid');let cancelled=false;
    await expect(f.launch(manifest(350),async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),new AbortController().signal)).rejects.toThrow();
    expect(cancelled).toBe(true);expect(f.cleanups).toBe(1);
  });
  test('rejects numeric overflow in host responses instead of rewriting it to null',async()=>{
    const f=setup('valid');
    await expect(f.launch(manifest(),async()=>new Response('{"nested":[{"value":1e309}]}',{
      headers:{'content-type':'application/json'},
    }),new AbortController().signal)).rejects.toThrow('worker_protocol_or_lifetime_rejected');
    expect(f.cleanups).toBe(1);
  });
  test('spawn failure still awaits cleanup',async()=>{
    let cleanup=false;
    const launch=createStdioLauncher({command:['/not-an-executable'],cwd:root,env:{},async cleanup(){cleanup=true;}});
    await expect(launch(manifest(),async()=>Response.json({}),new AbortController().signal)).rejects.toThrow();expect(cleanup).toBe(true);
  });
  test('cleanup failure prevents success without exposing raw diagnostics',async()=>{
    const f=setup('valid',async()=>{throw new Error('synthetic-capability-in-cleanup-diagnostics');});
    try {await f.launch(manifest(),f.handle,new AbortController().signal);throw new Error('unexpected success');}
    catch(error){expect((error as Error).message).toBe('worker_cleanup_failed');}
    expect(f.cleanups).toBe(1);
  });
  test('abort invokes exact-worker cleanup before inherited stdout can delay EOF',async()=>{
    const signal=new AbortController();
    let descendantPid:number|undefined,readyAt=0;
    const f=setup('descendant_stdout',async()=>{
      if(descendantPid) try {process.kill(descendantPid,'SIGKILL');} catch { /* Fixture already exited. */ }
    });
    try {
      await expect(f.launch(manifest(),async request=>{
        const body=await request.json();
        descendantPid=body.descendantPid;
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        readyAt=Date.now();setTimeout(()=>signal.abort(),100);
        return Response.json({ok:true});
      },signal.signal)).rejects.toThrow('worker_protocol_or_lifetime_rejected');
      expect(readyAt).toBeGreaterThan(0);
      expect(Date.now()-readyAt).toBeLessThan(800);
      expect(f.cleanups).toBe(1);
    } finally {
      // Even if this regression returns, the fixture cannot leave an orphan.
      if(descendantPid) try {process.kill(descendantPid,'SIGKILL');} catch { /* Fixture already exited. */ }
    }
  });
  test('already-aborted session starts nothing',async()=>{
    const f=setup('valid'),signal=new AbortController();signal.abort();
    await expect(f.launch(manifest(),f.handle,signal.signal)).rejects.toThrow();expect(f.cleanups).toBe(0);
  });
});
