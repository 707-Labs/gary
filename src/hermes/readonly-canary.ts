/** One-shot, host-verified read-only smoke. No polling, publication, enrollment or I/O at import. */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { constants, closeSync, chmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { DB } from '../state/db.ts';
import type { SpendLedger, SpendStatus } from '../spend.ts';
import type { Executor } from '../executors/index.ts';
import type { AgentLoopArgs } from '../agent/loop.ts';
import { createGaryLoopAdapter, type GaryRuntimeLauncher } from './gary-loop-adapter.ts';
import type { AdmittedSession, SessionOptions } from './session-host.ts';
import { createReadonlyChildExecutor, type ReadonlyChildHandle } from './readonly-child.ts';
import { createDockerRuntimeLauncher } from './docker-launcher.ts';
import { createAuditTrace, type AuditTrace } from './audit-trace.ts';
import { canonicalArguments, canonicalizeConversation, finiteJson, sameConversation, type ConversationMessage } from './conversation.ts';
import { HERMES_CANARY_CHILD_IMAGE, HERMES_CANARY_WORKER_IMAGE } from './activation.ts';

export const READONLY_CANARY_POLICY = Object.freeze({version:1,provider:'deepseek',model:'deepseek-v4-pro',
  workerImage:HERMES_CANARY_WORKER_IMAGE,executorImage:HERMES_CANARY_CHILD_IMAGE,
  dockerExecutable:'/usr/local/bin/docker',dockerHost:'unix:///Users/tanner/.colima/default/docker.sock',
  maxRequests:3,maxTokens:1024,timeoutMs:120_000,temperature:0,capMicros:5_000_000,
  campaignCapMicros:5_000_000,allowedTools:Object.freeze(['read_file']),fixtureFile:'challenge.json'} as const);
const ID=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const schema=z.object({version:z.literal(1),runId:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),campaignId:ID,allocationId:ID.refine(value=>!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)),
  releaseCommit:z.string().regex(/^[a-f0-9]{40}$/),fixtureDirectory:z.string().min(1).max(4096),traceDirectory:z.string().min(1).max(4096)}).strict();
export type ReadonlyCanaryConfig=z.infer<typeof schema>;
export interface ReadonlyCanaryDependencies {
  db:DB;ledger:SpendLedger;route:Pick<SessionOptions,'provider'|'model'|'providerApiKey'|'fetch'>;
  launch?:GaryRuntimeLauncher;createExecutor?:typeof createReadonlyChildExecutor;signal?:AbortSignal;
}
export interface ReadonlyCanaryHealth {kind:'readonly_runtime';ready:boolean;readonlyCanarySucceeded:boolean;receiptId:string}
const pending:ReadonlyCanaryHealth=Object.freeze({kind:'readonly_runtime',ready:false,readonlyCanarySucceeded:false,receiptId:'pending'});
const configFault=():never=>{throw new Error('readonly_canary_config_rejected');};
const failed=():never=>{throw new Error('readonly_canary_failed');};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function directory(path:string,mode=0o700):void {
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path||/[\x00-\x1f\x7f]/.test(path))configFault();
  const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o7777)!==mode)configFault();
}
function validate(value:unknown):ReadonlyCanaryConfig {
  const config=schema.parse(value);directory(config.fixtureDirectory);directory(config.traceDirectory);
  const child=relative(config.fixtureDirectory,config.traceDirectory);
  if(child===''||(!child.startsWith('../')&&child!=='..'&&!isAbsolute(child)))configFault();
  return Object.freeze(config);
}
/** This schema is flat; a full token match also detects escaped duplicate keys. */
function json(raw:string):unknown {
  const parsed:unknown=JSON.parse(raw);if(!object(parsed))configFault();
  const pairs=/\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([,}])/gy;
  const start=/^\s*\{/.exec(raw);if(!start)configFault();pairs.lastIndex=start![0].length;const keys=new Set<string>();
  for(;;){const match=pairs.exec(raw);if(!match)configFault();const key=JSON.parse(match![1]!);if(keys.has(key))configFault();keys.add(key);
    if(match![3]==='}'){if(raw.slice(pairs.lastIndex).trim()!=='')configFault();break;}}
  return parsed;
}
export function loadReadonlyCanaryConfig(path:string):ReadonlyCanaryConfig {
  let fd:number|undefined;
  try{directory(dirname(path));if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)configFault();
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd);
    if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o7777)!==0o600||before.nlink!==1||before.size<2||before.size>16_384)configFault();
    const raw=readFileSync(fd),after=fstatSync(fd),current=lstatSync(path);
    if(after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs
      ||current.ino!==before.ino||current.dev!==before.dev||raw.length!==before.size)configFault();
    return validate(json(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
  }catch{return configFault();}finally{if(fd!==undefined)closeSync(fd);}
}
interface Row {run_id:string;allocation_id:string;config_fingerprint:string;owner_epoch:string;request_id:string;state:string;
  fixture_sha256:string|null;trace_path:string|null;trace_sha256:string|null;receipt_id:string|null;model_requests:number;tool_reads:number;charged_micros:number|null}
function receipt(row:Row):string {return 'sha256:'+sha(JSON.stringify({version:1,kind:'verified_readonly',runId:row.run_id,allocationId:row.allocation_id,
  configFingerprint:row.config_fingerprint,ownerEpoch:row.owner_epoch,requestId:row.request_id,fixtureSha256:row.fixture_sha256,
  tracePath:row.trace_path,traceSha256:row.trace_sha256,modelRequests:row.model_requests,toolReads:row.tool_reads,chargedMicros:row.charged_micros,
  nativeStatus:'no_finish',traceClosed:true,cleanupComplete:true,publicationApproved:false}));}
function snapshot(path:string,mode:number,maxBytes:number):Buffer {
  let fd:number|undefined;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const a=fstatSync(fd);
    if(!a.isFile()||a.uid!==process.getuid?.()||(a.mode&0o7777)!==mode||a.nlink!==1||a.size>maxBytes)failed();
    const bytes=readFileSync(fd),b=fstatSync(fd),c=lstatSync(path);
    if(b.size!==a.size||b.mtimeMs!==a.mtimeMs||b.ctimeMs!==a.ctimeMs||c.ino!==a.ino||c.dev!==a.dev||bytes.length!==a.size)failed();return bytes;
  }finally{if(fd!==undefined)closeSync(fd);}
}
async function body(request:Request|Response,signal:AbortSignal,max:number):Promise<{value:any;bytes:Buffer}> {
  const reader=request.body?.getReader();if(!reader)failed();const abort=()=>{void reader!.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){signal.throwIfAborted();const part=await reader!.read();signal.throwIfAborted();if(part.done)break;size+=part.value.byteLength;if(size>max)failed();chunks.push(part.value);}
    const bytes=Buffer.concat(chunks),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!finiteJson(value))failed();return{value,bytes};
  }finally{signal.removeEventListener('abort',abort);void reader!.cancel().catch(()=>{});reader!.releaseLock();}
}

/** Construction validates only; run owns all claims, fixture creation, containers and spending. */
export function createReadonlyCanary(input:ReadonlyCanaryConfig,deps:ReadonlyCanaryDependencies) {
  let config:ReadonlyCanaryConfig;try{config=validate(input);}catch{return configFault();}
  const route=Object.freeze({...deps.route});
  if(route.provider!=='deepseek'||route.model!=='deepseek-v4-pro'||typeof route.fetch!=='function'||typeof route.providerApiKey!=='string'||!route.providerApiKey)configFault();
  const fingerprint=sha(JSON.stringify({config,policy:READONLY_CANARY_POLICY}));
  const leaf=join(config.fixtureDirectory,config.runId),fixture=join(leaf,READONLY_CANARY_POLICY.fixtureFile);
  const readRow=()=>deps.db.query<Row,[string]>('SELECT * FROM hermes_readonly_canaries WHERE run_id=?').get(config.runId);
  const sameAllocation=(s:SpendStatus|null):s is SpendStatus=>!!s&&s.ticketId===config.allocationId&&s.campaignId===config.campaignId&&s.capMicros===5_000_000
    &&s.campaignCapMicros===5_000_000&&!s.draftPr&&s.chargedMicros>=0&&s.chargedMicros<=5_000_000&&s.campaignChargedMicros<=5_000_000;
  let consumed=false;
  function check():ReadonlyCanaryHealth {
    try{if(deps.signal?.aborted)return pending;const row=readRow(),s=deps.ledger.status(config.allocationId);
      if(!row||row.state!=='verified'||row.config_fingerprint!==fingerprint||row.allocation_id!==config.allocationId||!row.owner_epoch
        ||!/^[a-f0-9-]{36}$/.test(row.request_id)||row.model_requests<2||row.model_requests>3||row.tool_reads<1||row.tool_reads>2
        ||row.trace_path!==join(config.traceDirectory,row.request_id+'.jsonl')||!row.fixture_sha256||!row.trace_sha256||row.receipt_id!==receipt(row)
        ||!sameAllocation(s)||s.state!=='closed'||s.terminalReason!=='verified_readonly'||s.unknownAttempts!==0||s.attemptCount!==row.model_requests||s.chargedMicros!==row.charged_micros)return pending;
      directory(config.fixtureDirectory);directory(config.traceDirectory);directory(leaf,0o755);
      if(sha(snapshot(fixture,0o444,4096))!==row.fixture_sha256||sha(snapshot(row.trace_path,0o600,262144))!==row.trace_sha256)return pending;
      return Object.freeze({kind:'readonly_runtime',ready:true,readonlyCanarySucceeded:true,receiptId:row.receipt_id});
    }catch{return pending;}
  }
  async function run():Promise<void> {
    if(consumed)throw new Error('readonly_canary_already_attempted');consumed=true;
    const owner=randomUUID(),requestId=randomUUID();let claimed=false,child:ReadonlyChildHandle|undefined,trace:AuditTrace|undefined,traceClosed=false,traceTerminal:string|undefined;
    let modelRequests=0,physicalReads=0,toolReads=0,fixtureHash='',answer:string|undefined;let fault=false;
    const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
    const deadlineMs=Date.now()+120_000,timer=setTimeout(abort,120_000);
    const active=()=>{if(deps.signal?.aborted)controller.abort();controller.signal.throwIfAborted();if(Date.now()>=deadlineMs||fault)failed();const row=readRow(),s=deps.ledger.status(config.allocationId);
      if(!row||row.state!=='running'||row.owner_epoch!==owner||row.request_id!==requestId||row.config_fingerprint!==fingerprint
        ||!sameAllocation(s)||s.state!=='active'||s.attemptCount>3)failed();};
    const tracePath=join(config.traceDirectory,requestId+'.jsonl');
    let error=false;
    try{
      if(controller.signal.aborted)failed();
      deps.db.exec('PRAGMA synchronous = FULL');
      if((deps.db.query('PRAGMA synchronous').get() as {synchronous:number})?.synchronous!==2)failed();
      deps.db.exec(`CREATE TABLE IF NOT EXISTS hermes_readonly_canaries (
        run_id TEXT PRIMARY KEY,allocation_id TEXT NOT NULL UNIQUE,config_fingerprint TEXT NOT NULL,owner_epoch TEXT NOT NULL,request_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','verified','failed')),fixture_sha256 TEXT,trace_path TEXT,trace_sha256 TEXT,receipt_id TEXT,
        model_requests INTEGER NOT NULL DEFAULT 0,tool_reads INTEGER NOT NULL DEFAULT 0,charged_micros INTEGER,started_at TEXT NOT NULL,completed_at TEXT)`);
      deps.db.transaction(()=>{
        if(deps.db.query('SELECT run_id FROM hermes_readonly_canaries WHERE run_id=? OR allocation_id=?').get(config.runId,config.allocationId))throw new Error('readonly_canary_already_attempted');
        const s=deps.ledger.status(config.allocationId);
        if(!sameAllocation(s)||s.state!=='active'||s.terminalReason!==null||s.attemptCount!==0||s.unknownAttempts!==0||s.chargedMicros!==0
          ||s.remainingMicros!==5_000_000||s.campaignChargedMicros!==0)failed();
        deps.db.query("INSERT INTO hermes_readonly_canaries(run_id,allocation_id,config_fingerprint,owner_epoch,request_id,state,started_at) VALUES(?,?,?,?,?,'running',?)")
          .run(config.runId,config.allocationId,fingerprint,owner,requestId,new Date().toISOString());
      }).immediate();claimed=true;active();directory(config.fixtureDirectory);directory(config.traceDirectory);
      mkdirSync(leaf,{mode:0o755});chmodSync(leaf,0o755);directory(leaf,0o755);
      const challenge={nonce:randomBytes(16).toString('hex'),a:randomInt(1,1000),b:randomInt(1,1000)};
      const challengeBytes=Buffer.from(JSON.stringify(challenge)+'\n');let fd:number|undefined;
      try{fd=openSync(fixture,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o444);let offset=0;while(offset<challengeBytes.length){const wrote=writeSync(fd,challengeBytes,offset,challengeBytes.length-offset);if(wrote<1)failed();offset+=wrote;}fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
      chmodSync(fixture,0o444);fixtureHash=sha(snapshot(fixture,0o444,4096));if(fixtureHash!==sha(challengeBytes))failed();
      deps.db.query('UPDATE hermes_readonly_canaries SET fixture_sha256=?,trace_path=? WHERE run_id=? AND owner_epoch=?').run(fixtureHash,tracePath,config.runId,owner);
      const admission:AdmittedSession={taskId:'readonly-'+config.runId,requestId,ticketId:config.allocationId,actionId:'readonly-'+config.runId,fingerprint,ownerEpoch:owner,deadlineMs};
      const stored=createAuditTrace({path:tracePath,binding:{taskId:admission.taskId,requestId,actionId:admission.actionId,ownerEpoch:owner,ticketId:config.allocationId},maxBytes:262144,maxEvents:128});
      trace={binding:stored.binding,get failed(){return stored.failed;},append(event){stored.append(event);if(event.kind==='terminal')traceTerminal=event.status;},close(){stored.close();if(!stored.failed)traceClosed=true;}};
      child=await (deps.createExecutor??createReadonlyChildExecutor)({workspaceRoot:leaf,imageDigest:HERMES_CANARY_CHILD_IMAGE,parentDepth:0,admission,
        assertActive:supplied=>{active();if(JSON.stringify(supplied)!==JSON.stringify(admission))failed();},signal:controller.signal,
        dockerExecutable:READONLY_CANARY_POLICY.dockerExecutable,dockerHost:READONLY_CANARY_POLICY.dockerHost});active();
      if(child.executor.workspaceRoot!==leaf)failed();
      const denied=async():Promise<never>=>{fault=true;return failed();};
      const executor:Executor={workspaceRoot:leaf,readFile:async(path,opts)=>{active();if(path!=='challenge.json'||physicalReads>=2){fault=true;failed();}
        const content=await child!.executor.readFile(path,opts);active();if(sha(content)!==fixtureHash){fault=true;failed();}physicalReads++;return content;},
        writeFile:denied,listFiles:denied,grep:denied,run:denied};
      const realLaunch=deps.launch??createDockerRuntimeLauncher({imageDigest:HERMES_CANARY_WORKER_IMAGE,dockerExecutable:READONLY_CANARY_POLICY.dockerExecutable,dockerHost:READONLY_CANARY_POLICY.dockerHost});
      const launch:GaryRuntimeLauncher=async(manifest,handle,signal)=>{
        let history:ConversationMessage[]=[{role:'user',content:manifest.prompt}],pendingCall:string|undefined,finishedAnswer=false;
        const native=await realLaunch(manifest,async request=>{
          try{active();if(request.headers.get('authorization')!=='Bearer '+manifest.capability)failed();
            const path=new URL(request.url).pathname;if(!['/v1/chat/completions','/tools/execute','/tools/state'].includes(path))failed();
            const input=await body(request,signal,1048576),value=input.value;
            if(!object(value))failed();
            if(path==='/v1/chat/completions'){
              if(finishedAnswer||pendingCall||modelRequests>=3||!Array.isArray(value.messages)||value.messages.length<2)failed();
              const systems=value.messages.filter((message:unknown)=>object(message)&&message.role==='system');
              if(systems.some((message:any)=>typeof message.content!=='string'||Object.keys(message).some(k=>!['role','content'].includes(k))))failed();
              const incoming=value.messages.filter((message:unknown)=>!object(message)||message.role!=='system');
              if(!sameConversation(history,canonicalizeConversation(incoming)))failed();
              // As in the production coordinator, native persona text acquires no authority.
              value.messages=[{role:'system',content:manifest.systemPrompt},...history];modelRequests++;
            }else if(path==='/tools/execute'){
              if(!pendingCall||value.callId!==pendingCall||value.name!=='read_file'||canonicalArguments(value.arguments)!=='{"path":"challenge.json"}')failed();
            }
            const response=await handle(new Request(request.url,{method:request.method,headers:request.headers,body:JSON.stringify(value),signal:request.signal}));active();
            // Reservation is transiently unknown in-flight. Inspect only after the guarded route has settled.
            if(path==='/v1/chat/completions'&&deps.ledger.status(config.allocationId)?.unknownAttempts!==0){void response.body?.cancel().catch(()=>{});failed();}
            const output=await body(response,signal,1048576);if(!response.ok)failed();
            if(path==='/v1/chat/completions'){
              const choices=output.value?.choices;if(!Array.isArray(choices)||choices.length!==1)failed();
              history=canonicalizeConversation([...history,choices[0]?.message],{requireResolved:false});
              const assistant=history.at(-1)!;
              if(Array.isArray(assistant.tool_calls)){
                if(assistant.tool_calls.length!==1)failed();const call=assistant.tool_calls[0] as any;
                if(call.function.name!=='read_file'||call.function.arguments!=='{"path":"challenge.json"}')failed();pendingCall=call.id;
              }else{if(toolReads<1||typeof assistant.content!=='string')failed();answer=assistant.content as string;finishedAnswer=true;}
            }else if(path==='/tools/execute'){
              if(output.value?.ok!==true||output.value.name!=='read_file'||output.value.tool_call_id!==pendingCall||output.value.truncated!==false
                ||typeof output.value.content!=='string'||sha(output.value.content)!==fixtureHash||physicalReads!==toolReads+1)failed();
              history=canonicalizeConversation([...history,{role:'tool',tool_call_id:pendingCall,content:output.value.content}]);pendingCall=undefined;toolReads++;
            }
            return new Response(new Uint8Array(output.bytes),{status:response.status,headers:response.headers});
          }catch{fault=true;controller.abort();throw new Error('readonly_canary_rpc_rejected');}
        },signal);
        active();if(native.status!=='no_finish'||!finishedAnswer||pendingCall||!sameConversation(history,canonicalizeConversation(native.history)))failed();
        return native;
      };
      const runLoop=createGaryLoopAdapter({baseUrl:'http://127.0.0.1/',launch,hostOptions:{...route,admission,capabilityToken:randomBytes(32).toString('hex'),ledger:deps.ledger,
        executor,readOnly:true,allowedTools:['read_file'],finishGateCommand:'',currentOwnerEpoch:()=>{active();return owner;},
        assertAdmission:supplied=>{active();if(JSON.stringify(supplied)!==JSON.stringify(admission))failed();},trace,signal:controller.signal}});
      const result=await runLoop({glm:{} as AgentLoopArgs['glm'],executor,task:'Read challenge.json using read_file. Return only a JSON object with exactly nonce (copied from the file) and sum (the integer sum of a and b). Do not invent the file contents.',
        systemPrompt:'You are Gary running a read-only runtime verification. Use only the provided read_file tool. Read the challenge before answering. No coding, publication or delegation is authorized.',
        maxIterations:3,maxTokensPerTurn:1024,temperature:0,timeoutMs:120_000,deadlineMs,readOnly:true,disableSubagent:true,signal:controller.signal});
      active();if(result.status!=='no_finish'||result.terminationReason!==null||modelRequests<2||modelRequests>3||toolReads<1||!traceClosed||traceTerminal!=='no_finish'||trace.failed)failed();
      const response=z.object({nonce:z.literal(challenge.nonce),sum:z.literal(challenge.a+challenge.b)}).strict().safeParse(json(answer??''));
      if(!response.success||sha(snapshot(fixture,0o444,4096))!==fixtureHash)failed();
    }catch(e){error=true;if(!claimed&&e instanceof Error&&e.message==='readonly_canary_already_attempted')throw e;}
    finally{
      try{await child?.close();}catch{error=true;}
      if(trace&&!traceClosed&&!trace.failed){try{if(!traceTerminal)trace.append({kind:'terminal',status:'error',iteration:modelRequests,phase:'hermes',modelState:{provider:'deepseek',model:'deepseek-v4-pro',thinking:'unknown',effort:'unknown'}});trace.close();}catch{error=true;}}
      clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);
    }
    try{
      if(!claimed)failed();active();const s=deps.ledger.status(config.allocationId);
      if(error||!traceClosed||traceTerminal!=='no_finish'||!sameAllocation(s)||s.unknownAttempts!==0||s.attemptCount!==modelRequests
        ||modelRequests<2||modelRequests>3||sha(snapshot(fixture,0o444,4096))!==fixtureHash)failed();
      const traceHash=sha(snapshot(tracePath,0o600,262144));
      deps.ledger.markTerminal(config.allocationId,'verified_readonly');
      const settled=deps.ledger.status(config.allocationId);if(!sameAllocation(settled)||settled.state!=='closed'||settled.terminalReason!=='verified_readonly'||settled.unknownAttempts!==0||settled.attemptCount!==modelRequests)failed();
      deps.db.transaction(()=>{
        const current=readRow();if(!current||current.state!=='running'||current.owner_epoch!==owner||current.config_fingerprint!==fingerprint)failed();
        const row:Row={...current!,state:'verified',trace_sha256:traceHash,model_requests:modelRequests,tool_reads:toolReads,charged_micros:settled!.chargedMicros};
        deps.db.query("UPDATE hermes_readonly_canaries SET state='verified',trace_sha256=?,receipt_id=?,model_requests=?,tool_reads=?,charged_micros=?,completed_at=? WHERE run_id=? AND owner_epoch=? AND state='running'")
          .run(traceHash,receipt(row),modelRequests,toolReads,settled!.chargedMicros,new Date().toISOString(),config.runId,owner);
      }).immediate();if(!check().ready)failed();
    }catch(e){
      if(claimed){
        // Cleanup diagnostics must not escape; a failed/unavailable durable store never grants readiness.
        try{deps.ledger.markTerminal(config.allocationId,'readonly_canary_failed');}catch{}
        try{deps.db.query("UPDATE hermes_readonly_canaries SET state='failed',completed_at=? WHERE run_id=? AND owner_epoch=? AND state IN ('running','verified')")
          .run(new Date().toISOString(),config.runId,owner);}catch{}
      }return failed();
    }finally{controller.abort();}
  }
  return Object.freeze({run,check});
}
