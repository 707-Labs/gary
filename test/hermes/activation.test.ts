import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHermesActivationConfig, createHermesActivation, HERMES_CANARY_CHILD_IMAGE, HERMES_CANARY_WORKER_IMAGE, HERMES_CODING_WORKER_IMAGE, type HermesActivationConfig } from '../../src/hermes/activation.ts';
import { READONLY_CANARY_POLICY } from '../../src/hermes/readonly-canary.ts';
import { bindCanonicalCodeAction } from '../../src/hermes/canonical-admission.ts';
import { openDb } from '../../src/state/db.ts';
import { setClassification, upsertTicket } from '../../src/state/queries.ts';
import { SpendLedger } from '../../src/spend.ts';
import { runProcess } from '../../src/executors/process.ts';
import type { Executor } from '../../src/executors/index.ts';
import type { AgentLoopArgs } from '../../src/agent/loop.ts';
import type { AssignedIssue } from '../../src/adapters/linear.ts';
import type { GaryRuntimeLauncher } from '../../src/hermes/gary-loop-adapter.ts';
import * as production from '../../src/hermes/production-runtime.ts';
import { fingerprintHermesCodingActivation } from '../../src/hermes/coding-runtime-policy.ts';

const cleanups: Array<()=>void> = [];
afterEach(()=>{for(const clean of cleanups.splice(0).reverse()) clean();});
const ID='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const CHECK='bun run ci:full';
function configFixture() {
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'gary-activation-')));chmodSync(directory,0o700);
  cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  const trace=join(directory,'traces');mkdirSync(trace,{mode:0o700});
  const path=join(directory,'activation.json');
  const config:HermesActivationConfig={version:1,issueId:ID,repo:'fixture/repo',provider:'deepseek',model:'deepseek-v4-pro',
    workerImage:HERMES_CODING_WORKER_IMAGE,childImage:HERMES_CANARY_CHILD_IMAGE,dockerExecutable:'/usr/local/bin/docker',dockerHost:'unix:///Users/tanner/.colima/default/docker.sock',traceDirectory:trace,
    policy:{baseCommit:'a'.repeat(40),task:{allowedFiles:['task.ts'],criteria:[{id:'fix',description:'Exact scoped change',requiredCommands:['bun run check',CHECK]}]},
      progress:{maxModelRequests:50,maxModelRequestsWithoutProgress:20,maxSuccessfulToolCalls:100,toolRepeatWindow:10,maxRepeatedToolCalls:5},
      instructions:[],voicePrinciples:'Preserve Gary voice.',readTicketIdentifiers:['ERT-1'],publicFetch:{policy:{kind:'urls',urls:[]}},
      cloudflare:{allowedServices:[],allowedDatabases:[]},preparationCommands:[]}};
  const save=(value:unknown=config)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});save();
  return{directory,trace,path,config,save};
}
const native:GaryRuntimeLauncher=async(m,handle)=>{
  const history:Record<string,unknown>[]=[...(m.history??[]),{role:'user',content:m.prompt}];
  const call=(path:string,body:unknown)=>handle(new Request(new URL(path,m.modelBaseUrl),{method:'POST',headers:{authorization:'Bearer '+m.capability,'content-type':'application/json'},body:JSON.stringify(body)}));
  for(let i=0;i<m.maxIterations;i++){
    const response=await call('/v1/chat/completions',{model:m.model,messages:[{role:'system',content:m.systemPrompt},...history],tools:m.tools,max_tokens:m.maxTokens,temperature:m.temperature,stream:false});
    if(!response.ok) return{taskId:m.taskId,requestId:m.requestId,status:'error',publicationApproved:false,history};
    const assistant=(await response.json()).choices[0].message;history.push(assistant);
    if(!assistant.tool_calls?.length)return{taskId:m.taskId,requestId:m.requestId,status:'no_finish',publicationApproved:false,history};
    for(const tool of assistant.tool_calls){
      let response=await call('/tools/execute',{taskId:m.taskId,ownerEpoch:m.ownerEpoch,token:m.capability,callId:tool.id,name:tool.function.name,arguments:tool.function.arguments});
      let receipt=await response.json();
      while(response.status===202){response=await call('/tools/jobs/poll',{taskId:m.taskId,requestId:m.requestId,ownerEpoch:m.ownerEpoch,callId:tool.id,jobId:receipt.jobId});receipt=await response.json();}
      if(receipt.kind==='test_job_complete')receipt=receipt.receipt;
      history.push({role:'tool',tool_call_id:tool.id,content:receipt.content});
      if(!response.ok)return{taskId:m.taskId,requestId:m.requestId,status:'error',publicationApproved:false,history};
      if(tool.function.name==='finish')return{taskId:m.taskId,requestId:m.requestId,status:'finished',publicationApproved:false,history};
    }
  }
  return{taskId:m.taskId,requestId:m.requestId,status:'iteration_cap',publicationApproved:false,history};
};
async function runtimeFixture(configure?:(config:HermesActivationConfig,workspace:string)=>void) {
  const f=configFixture();const workspace=join(f.directory,'workspace');mkdirSync(workspace);
  const env={PATH:'/opt/homebrew/bin:/Users/tanner/.bun/bin:/usr/bin:/bin',HOME:workspace,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const run=(command:string)=>runProcess('/bin/bash',['-c',command],{cwd:workspace,env,timeoutMs:10_000});
  for(const command of ['git init -q','git config user.email fixture@example.invalid','git config user.name Fixture','git config core.hooksPath /dev/null'])expect((await run(command)).exitCode).toBe(0);
  writeFileSync(join(workspace,'task.ts'),'base\n');writeFileSync(join(workspace,'package.json'),JSON.stringify({scripts:{'ci:full':'bun run check',check:'test \"$(cat task.ts)\" = updated'}}));expect((await run('git add task.ts package.json && git commit -qm baseline')).exitCode).toBe(0);
  f.config.policy.baseCommit=(await run('git rev-parse HEAD')).stdout.trim();configure?.(f.config,workspace);f.save();
  const db=openDb(':memory:');cleanups.push(()=>db.close());const ledger=new SpendLedger(':memory:');cleanups.push(()=>ledger.close());
  ledger.createCampaign('offline',10);ledger.enrollTicket('offline',ID,10,{draftPr:true,codingReviewReserve:true});
  const issue:AssignedIssue={id:ID,identifier:'ERT-1',title:'Fixture',description:'Change task.ts',url:'https://linear.invalid/ERT-1',stateName:'Todo',stateType:'unstarted',
    createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z',creatorId:null,creatorName:null,teamId:'team',teamKey:'ERT',blockedBy:[]};
  upsertTicket(db,{linearId:ID,identifier:'ERT-1'});
  const executor:Executor={workspaceRoot:workspace,readFile:async path=>readFileSync(join(workspace,path),'utf8'),writeFile:async(path,content)=>{writeFileSync(join(workspace,path),content);},
    listFiles:async()=>[],grep:async()=>[],run:async(command,opts)=>runProcess('/bin/bash',['-c',command],{...opts,cwd:workspace,env,timeoutMs:opts?.timeoutMs??10_000})};
  let requests=0,launches=0;
  const route={provider:'deepseek' as const,model:'deepseek-v4-pro' as const,providerApiKey:'offline-fixture-key',fetch:async(request:Request)=>{
    const body=await request.json();expect(body.model).toBe('deepseek-v4-pro');expect(body.thinking).toEqual({type:'disabled'});requests++;
    const steps=[['read_file',{path:'task.ts'}],['write_file',{path:'task.ts',content:'updated\n'}],['run_bash',{command:'bun run check'}],['run_bash',{command:CHECK}],['finish',{summary:'Verified fixture'}]] as const;
    const step=steps[(requests-1)%5]!;
    return Response.json({id:'reply-'+requests,type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'tool_use',id:'call-'+requests,name:step[0],input:step[1]}],stop_reason:'tool_use',usage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
  }};
  const deps={db,ledger,route,executorJobJournal:{directory:join(f.trace,'offline-jobs'),close(){}},launch:async(...args:Parameters<GaryRuntimeLauncher>)=>{launches++;return native(...args);}};
  const admissionActivation=createHermesActivation(loadHermesActivationConfig(f.path),deps);
  const admitted={issueId:ID,fingerprint:'fp',humanSignature:'human-fp',provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'};
  const classify=admissionActivation.codingTrial.admit({...admitted,actionType:'classify'});
  setClassification(db,{linearId:ID,classification:'CODE',confidence:.99,scope:'S'});
  classify.complete(true,'handled');
  const admit=()=>{const trial=admissionActivation.codingTrial.admit({...admitted,actionType:'start_coding'});
    return bindCanonicalCodeAction({db,ledger,actionId:trial.actionId,fingerprint:'fp',issue,provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'});};
  const binding=admit();
  const args:AgentLoopArgs={glm:{} as AgentLoopArgs['glm'],executor,systemPrompt:'Gary admitted instructions.',task:'Change task.ts',maxIterations:5,maxTokensPerTurn:128,timeoutMs:30_000,deadlineMs:Date.now()+30_000,finishGateCommand:CHECK,disableSubagent:true};
  return{...f,workspace,db,ledger,binding,admit,deps,args,counts:()=>({requests,launches})};
}

test('coding activation accepts the async worker pin and rejects the previous read-only worker',()=>{
  const f=configFixture();
  expect(HERMES_CODING_WORKER_IMAGE).toBe('sha256:8f728373dd6121e8031e113988c76eb561eb4758b2e3e701932e3a36ff991fcb');
  expect(loadHermesActivationConfig(f.path).workerImage).toBe(HERMES_CODING_WORKER_IMAGE);
  f.save({...f.config,workerImage:HERMES_CANARY_WORKER_IMAGE});
  expect(()=>loadHermesActivationConfig(f.path)).toThrow('hermes_activation_rejected:config_unavailable_or_invalid');
});
test('coding worker pin leaves the read-only canary policy unchanged',()=>{
  expect(HERMES_CANARY_WORKER_IMAGE).toBe('sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab');
  expect(READONLY_CANARY_POLICY).toEqual({version:2,provider:'deepseek',model:'deepseek-v4-pro',thinking:'disabled',
    workerImage:'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',
    executorImage:'sha256:e77edfc6e20402c7ed9f447dca81dc61e277c2a39199963f455a37a03dfcedf4',
    dockerExecutable:'/usr/local/bin/docker',dockerHost:'unix:///Users/tanner/.colima/default/docker.sock',
    maxRequests:3,maxTokens:1024,timeoutMs:120_000,temperature:0,capMicros:5_000_000,
    campaignCapMicros:5_000_000,allowedTools:['read_file'],fixtureFile:'challenge.json'});
});

test('loader reads only explicit protected JSON and returns detached deeply frozen policy',()=>{
  const f=configFixture();const cfg=loadHermesActivationConfig(f.path);
  expect(cfg).toEqual(f.config);expect(Object.isFrozen(cfg)).toBe(true);expect(Object.isFrozen(cfg.policy.task.allowedFiles)).toBe(true);
  f.config.policy.task.allowedFiles.push('other.ts');expect(cfg.policy.task.allowedFiles).toEqual(['task.ts']);
  expect(readFileSync(f.path,'utf8')).not.toContain('apiKey');
});
for(const mode of ['config-public','parent-public','trace-public','symlink','hardlink','symlink-parent','not-json','duplicate-key','oversized'] as const)test('loader rejects '+mode,()=>{
  const f=configFixture();let path=f.path;
  if(mode==='config-public')chmodSync(f.path,0o644);
  if(mode==='parent-public')chmodSync(f.directory,0o755);
  if(mode==='trace-public')chmodSync(f.trace,0o755);
  if(mode==='symlink'){path=join(f.directory,'alias.json');symlinkSync(f.path,path);}
  if(mode==='hardlink')linkSync(f.path,join(f.directory,'hardlink.json'));
  if(mode==='symlink-parent'){const alias=join(f.directory,'alias');symlinkSync(f.trace,alias);path=join(alias,'config.json');writeFileSync(path,JSON.stringify(f.config),{mode:0o600});}
  if(mode==='not-json')writeFileSync(path,'not JSON');
  if(mode==='duplicate-key')writeFileSync(path,readFileSync(path,'utf8').replace('"version":1','"version":1,"version":1'));
  if(mode==='oversized')writeFileSync(path,' '.repeat(262145));
  expect(()=>loadHermesActivationConfig(path)).toThrow('hermes_activation_rejected');
});
for(const alter of [
  (x:any)=>{x.apiKey='must not be accepted';},(x:any)=>{x.policy.publicFetch.transport={};},(x:any)=>{x.workerImage='sha256:'+'0'.repeat(64);},
  (x:any)=>{x.childImage='mutable:tag';},(x:any)=>{x.dockerHost='tcp://example.invalid:2375';},(x:any)=>{x.issueId='ERT-1';},
  (x:any)=>{x.policy.task.allowedFiles=['../outside'];},(x:any)=>{x.policy.task.criteria.push(x.policy.task.criteria[0]);},
  (x:any)=>{x.policy.baseCommit='main';},(x:any)=>{x.policy.progress.maxModelRequestsWithoutProgress=100;},
  (x:any)=>{x.policy.publicFetch.policy={kind:'urls',urls:['https://user:pass@example.invalid']};},
  (x:any)=>{delete x.policy.cloudflare;},(x:any)=>{x.provider='z.ai';},
  (x:any)=>{x.policy.task.criteria[0].requiredCommands=['true'];},
  (x:any)=>{x.policy.instructions=[{source:'AGENTS.md',text:'one'},{source:'AGENTS.md',text:'two'}];},
  (x:any)=>{x.policy.task.criteria=Array.from({length:5},(_,i)=>({id:'c'+i,description:'Check',requiredCommands:Array.from({length:8},(_,j)=>i===0&&j===0?CHECK:'check-'+i+'-'+j)}));},
  (x:any)=>{x.policy.progress.maxModelRequests=49;},
  (x:any)=>{x.policy.progress.maxModelRequestsWithoutProgress=15;},
  (x:any)=>{x.policy.task.allowedFiles=['é'.repeat(300)+'.ts'];},
  (x:any)=>{x.policy.task.criteria[0].description='é'.repeat(1100);},
  (x:any)=>{x.policy.preparationCommands=['é'.repeat(600)];},
])test('strict schema refuses unreviewed fields/routes/scope',()=>{
  const f=configFixture();alter(f.config);f.save();expect(()=>loadHermesActivationConfig(f.path)).toThrow('hermes_activation_rejected');
});

test('composition is inert and exposes only the selected ticket and allowed canary action types',async()=>{
  const f=await runtimeFixture();const activation=createHermesActivation(loadHermesActivationConfig(f.path),f.deps);
  expect(activation.createCodeVerification(f.binding.admission)).toBe(activation.createCodeVerification(f.binding.admission));
  expect(activation.verificationPolicy.publicationCommand).toBe(CHECK);
  expect(activation.codeBase).toEqual({branch:'main',commit:f.config.policy.baseCommit});
  expect(Object.isFrozen(activation.codeBase)).toBe(true);
  expect([...activation.allowedIssueIds]).toEqual([ID]);expect([...activation.allowedActionTypes]).toEqual(['classify','start_coding']);
  expect(activation.getHealthEvidence()).toEqual([]);expect(f.counts()).toEqual({requests:0,launches:0});expect(f.ledger.status(ID)!.attemptCount).toBe(0);
});
test('actual host runtime finishes with one ledger reservation per request and durable parent trace evidence',async()=>{
  const f=await runtimeFixture();const activation=createHermesActivation(loadHermesActivationConfig(f.path),f.deps);
  const result=await activation.createAdmittedCodeLoop(f.binding.admission)(f.args);
  expect(result.status).toBe('finished');expect(activation.createCodeVerification(f.binding.admission).snapshot().counts).toEqual({'bun run ci:full':1,'bun run check':1});expect(f.counts()).toEqual({requests:5,launches:1});expect(f.ledger.status(ID)!.attemptCount).toBe(5);
  const evidence=activation.getHealthEvidence();expect(evidence).toHaveLength(1);expect(evidence[0]).toMatchObject({actionId:f.binding.admission.actionId,ticketId:ID,runtime:'hermes',traceClosed:true,terminalStatus:'finished',publicationApproved:false});
  const trace=readFileSync(evidence[0]!.tracePath,'utf8');expect(trace).toContain('"kind":"terminal"');expect(trace).toContain('"status":"finished"');expect(trace).not.toContain('offline-fixture-key');
  expect(Object.isFrozen(evidence)).toBe(true);expect(Object.isFrozen(evidence[0])).toBe(true);
});
test('different host route, canonical ledger, repository or ticket cannot bind',async()=>{
  const f=await runtimeFixture();const config=loadHermesActivationConfig(f.path);
  expect(()=>createHermesActivation(config,{...f.deps,route:{...f.deps.route,model:'glm-5.3'}})).toThrow('host_route_mismatch');
  const activation=createHermesActivation(config,f.deps);
  for(const bad of [{ticketId:OTHER},{repo:'fixture/other'},{ledger:{} as SpendLedger},{ownerEpoch:'forged'}])expect(()=>activation.createAdmittedCodeLoop({...f.binding.admission,...bad})).toThrow();
  expect(f.counts()).toEqual({requests:0,launches:0});
});
test('non-draft enrollment and second coding attempt fail before native launch or model spend',async()=>{
  const nondraft=configFixture(),db=openDb(':memory:'),ledger=new SpendLedger(':memory:');
  cleanups.push(()=>db.close(),()=>ledger.close());ledger.createCampaign('offline',5);ledger.enrollTicket('offline',ID,5);
  upsertTicket(db,{linearId:ID,identifier:'ERT-1'});
  const non=createHermesActivation(loadHermesActivationConfig(nondraft.path),{db,ledger,executorJobJournal:{directory:join(nondraft.trace,'offline-jobs'),close(){}},route:{provider:'deepseek',model:'deepseek-v4-pro',providerApiKey:'offline',fetch:async()=>{throw new Error('must not fetch');}},launch:async()=>{throw new Error('must not launch');}});
  expect(()=>non.codingTrial.admit({issueId:ID,actionType:'classify',fingerprint:'fp',humanSignature:'human-fp',provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'})).toThrow('coding_trial_rejected:allocation');
  expect(db.query('SELECT count(*) AS n FROM actions').get()).toEqual({n:0});
  const f=await runtimeFixture();const before=f.db.query('SELECT * FROM actions ORDER BY id').all();
  expect(()=>f.admit()).toThrow('coding_trial_rejected:unfinished_owner');
  expect(f.db.query('SELECT * FROM actions ORDER BY id').all()).toEqual(before);
  expect(f.counts()).toEqual({requests:0,launches:0});expect(f.ledger.status(ID)!.attemptCount).toBe(0);
});
test('base mismatch, dirty starting workspace and trace-inside-workspace fail before launch',async()=>{
  for(const mode of ['base','dirty','trace']){
    const f=await runtimeFixture((config,workspace)=>{
      if(mode==='base')config.policy.baseCommit='b'.repeat(40);
      if(mode==='trace'){config.traceDirectory=join(workspace,'trace');mkdirSync(config.traceDirectory,{mode:0o700});}
    });
    if(mode==='dirty')writeFileSync(join(f.workspace,'task.ts'),'preexisting\n');
    const activation=createHermesActivation(loadHermesActivationConfig(f.path),f.deps);
    expect((await activation.createAdmittedCodeLoop(f.binding.admission)(f.args)).status).toBe('error');
    expect(f.counts()).toEqual({requests:0,launches:0});expect(activation.getHealthEvidence()).toEqual([]);
  }
});
for(const parentMode of ['error','unclosed'] as const)test(parentMode+' parent trace cannot borrow a successful child trace for health evidence',async()=>{
  const f=await runtimeFixture();
  const mock=spyOn(production,'createHermesCodeLoopFactory').mockImplementation(options=>action=>async()=>{
    const root={taskId:'gary-action-'+action.actionId,requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',actionId:action.actionId,ownerEpoch:action.ownerEpoch,ticketId:ID};
    const parent=options.createTrace(root);parent.append({kind:'terminal',status:parentMode==='error'?'error':'finished',phase:'hermes',iteration:0,modelState:{provider:'unknown',model:'unknown',thinking:'unknown',effort:'unknown'}});if(parentMode==='error')parent.close();else cleanups.push(()=>parent.close());
    const child=options.createTrace({...root,requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});child.append({kind:'terminal',status:'finished',phase:'hermes',iteration:0,modelState:{provider:'unknown',model:'unknown',thinking:'unknown',effort:'unknown'}});child.close();
    return{status:'finished',summary:'untrusted stub',iterations:0,inputTokens:0,outputTokens:0,cacheCreationTokens:0,cacheReadTokens:0,phase:'single',runLog:[]};
  });
  try{const activation=createHermesActivation(loadHermesActivationConfig(f.path),f.deps);await activation.createAdmittedCodeLoop(f.binding.admission)(f.args);expect(activation.getHealthEvidence()).toEqual([]);}
  finally{mock.mockRestore();}
});

test('same admitted runner retains original baseline across a verified repair',async()=>{
  const f=await runtimeFixture();const activation=createHermesActivation(loadHermesActivationConfig(f.path),f.deps);
  const run=activation.createAdmittedCodeLoop(f.binding.admission);
  expect((await run(f.args)).status).toBe('finished');
  const first=activation.getHealthEvidence()[0]!;
  expect(readFileSync(join(f.workspace,'task.ts'),'utf8')).toBe('updated\n');
  // The repair starts with the original task patch present. It must re-verify it without re-admitting a clean base.
  expect((await run({...f.args,task:'Recheck the existing task patch.'})).status).toBe('finished');
  const repaired=activation.getHealthEvidence();expect(repaired).toHaveLength(1);
  expect(repaired[0]!.actionId).toBe(first.actionId);expect(repaired[0]!.requestId).not.toBe(first.requestId);
  expect(activation.createCodeVerification(f.binding.admission).snapshot().counts).toEqual({'bun run ci:full':2,'bun run check':2});
  expect(f.counts()).toEqual({requests:10,launches:2});expect(f.ledger.status(ID)!.attemptCount).toBe(10);
},20_000);


test('preparation command limit matches runtime before any action admission',()=>{
  const f=configFixture();
  f.config.policy.preparationCommands=Array.from({length:8},(_,i)=>'true # trusted preparation '+i);f.save();
  expect(loadHermesActivationConfig(f.path).policy.preparationCommands).toHaveLength(8);
  f.config.policy.preparationCommands.push('true # ninth command');f.save();
  expect(()=>loadHermesActivationConfig(f.path)).toThrow('hermes_activation_rejected');
});

test('full gate cannot be omitted or replaced by its shell alias, and journal is required before classification',async()=>{
 const f=configFixture();
 for(const commands of [['bun run check'],['bun run ci:full'],['bun run check','bun run ci:full '],['bun run check','bun run ci:full && true']]) {
  f.config.policy.task.criteria[0]!.requiredCommands=commands;f.save();expect(()=>loadHermesActivationConfig(f.path)).toThrow();
 }
 const h=await runtimeFixture();const {executorJobJournal:_journal,...deps}=h.deps;
 expect(()=>createHermesActivation(loadHermesActivationConfig(h.path),deps as never)).toThrow('executor_journal_required');
 expect(h.counts()).toEqual({requests:0,launches:0});
});


test('explicit base branch is protected, frozen and included in the activation fingerprint', async () => {
  const f = await runtimeFixture();
  const defaultFingerprint = fingerprintHermesCodingActivation(loadHermesActivationConfig(f.path));
  f.config.policy.baseBranch = 'codex/baseline-test-repairs-20261008'; f.save();
  const config = loadHermesActivationConfig(f.path);
  const activation = createHermesActivation(config, f.deps);
  expect(activation.codeBase).toEqual({ branch: f.config.policy.baseBranch, commit: f.config.policy.baseCommit });
  expect(Object.isFrozen(activation.codeBase)).toBe(true);
  expect(fingerprintHermesCodingActivation(config)).not.toBe(defaultFingerprint);
  expect(f.counts()).toEqual({ requests: 0, launches: 0 });
});

for (const branch of ['', '-option', 'main:other', '../main', 'HEAD', 'main^{commit}', 'refs/heads/main', 'a//b', 'a.lock', 'a\nb']) {
  test('activation rejects unsafe base branch ' + JSON.stringify(branch), () => {
    const f = configFixture(); f.config.policy.baseBranch = branch; f.save();
    expect(() => loadHermesActivationConfig(f.path)).toThrow('hermes_activation_rejected');
  });
}
