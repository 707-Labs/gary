import {expect,test} from 'bun:test';
import {createStdioLauncher} from '../../src/hermes/stdio-launcher.ts';
import type {GaryRuntimeManifest} from '../../src/hermes/gary-loop-adapter.ts';
import {CODING_VERIFICATION_POLICY,snapshotLongTestPolicy} from '../../src/verification-policy.ts';
const script=String.raw`
import json,sys
p=json.loads(sys.stdin.readline())['payload']
ordinary,polls,skip=map(int,sys.argv[1:])
for i in range(ordinary+polls):
 path='/tools/state' if i<ordinary else '/tools/jobs/poll'
 frame={'type':'request','id':i+1+(1 if skip and i==ordinary else 0),'method':'POST','path':path,'headers':{'authorization':'Bearer '+p['capability'],'content-type':'application/json'},'body':{}}
 print(json.dumps(frame),flush=True)
 if not sys.stdin.readline():sys.exit(1)
print(json.dumps({'type':'result','result':{'taskId':p['taskId'],'requestId':p['requestId'],'status':'no_finish','publicationApproved':False}}),flush=True)
`;
function fixture(ordinary:number,polls:number,enabled=true,skip=false){
 let cleanups=0,calls=0;
 const launch=createStdioLauncher({command:['/usr/bin/python3','-I','-c',script,String(ordinary),String(polls),skip?'1':'0'],cwd:'/tmp',env:{PATH:'/usr/bin:/bin'},cleanup:async()=>{cleanups++;}});
 const manifest:GaryRuntimeManifest={taskId:'task',requestId:'request',ownerEpoch:'owner',capability:'x'.repeat(40),modelBaseUrl:'http://127.0.0.1/v1',executorUrl:'http://127.0.0.1/tools/execute',stateUrl:'http://127.0.0.1/tools/state',model:'deepseek-v4-pro',prompt:'offline',systemPrompt:'Gary',tools:[],maxIterations:1,maxTokens:32,temperature:0.3,deadlineMs:Date.now()+5000,
  ...(enabled?{longTestPolicy:snapshotLongTestPolicy(CODING_VERIFICATION_POLICY)}:{})};
 return{run:()=>launch(manifest,async()=>{calls++;return Response.json({ok:true});},new AbortController().signal),stats:()=>({calls,cleanups})};
}
test('stdio polling has a separate bounded quota and keeps sequential frame IDs',async()=>{
 const f=fixture(256,1152);expect((await f.run()).status).toBe('no_finish');expect(f.stats()).toEqual({calls:1408,cleanups:1});
});
test('ordinary frame limit remains256 and polling is denied without opt-in',async()=>{
 for(const [ordinary,polls,enabled,expected] of [[257,0,true,256],[0,1,false,0],[0,1153,true,1152]] as const){const f=fixture(ordinary,polls,enabled);await expect(f.run()).rejects.toThrow('worker_protocol_or_lifetime_rejected');expect(f.stats()).toEqual({calls:expected,cleanups:1});}
});
test('new private route does not relax frame sequence validation',async()=>{
 const f=fixture(1,1,true,true);await expect(f.run()).rejects.toThrow();expect(f.stats()).toEqual({calls:1,cleanups:1});
});
