/** Explicit operator-only image integration fixture. Never discovered as a test.
 * Real native and executor containers; fixed provider responses and a disposable
 * six-attempt continuation ledger. The reviewed Python custodian owns the real
 * inherited heavy-lock FD until independent physical cleanup is verified.
 */
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createEngineeringExecution, type EngineeringExecutionOptions } from '../../../src/hermes/engineering-execution.ts';
import { createEngineeringTaskPolicy, resolveEngineeringRepository } from '../../../src/hermes/engineering-policy.ts';
import { createEngineeringNativeLauncher } from '../../../src/hermes/engineering-native-launcher.ts';
import { createBunEngineeringCommandRunner, type EngineeringCommandRunner } from '../../../src/executors/engineering-session.ts';
import { createEngineeringSessionGuardianFactory } from '../../../src/executors/engineering-session-guardian.ts';
import { createSqliteEngineeringSessionJournal } from '../../../src/executors/engineering-session-journal.ts';
import { createEngineeringContinuation04Fixture } from './engineering-continuation04.ts';
import { admitEngineeringContinuation, assertEngineeringContinuationBudget } from '../../../src/hermes/engineering-continuation-budget.ts';
import type { EngineeringRuntimeConfig } from '../../../src/hermes/engineering-config.ts';
import type { EngineeringTaskView } from '../../../src/hermes/engineering-task-store.ts';

type Json = Record<string, any>;
const ROOT='/Users/tanner/Documents/Codex/2026-10-10/task';
const BASE='09e0a6f361a7f6b79e18d7b782fcb8723d6f613b';
const WORKER='sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab';
const EXECUTOR='sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c';
const CACHE='gary-bun-cache-20261010-mulligan-4bb2fdde-v2';
const PARSER='src/lib/utils/scryfall-url.ts', TEST='src/lib/utils/scryfall-url.test.ts';
const CHECKS=[
  'bun run test:run --project=src-node '+TEST,
  'node node_modules/eslint/bin/eslint.js '+PARSER+' '+TEST,
  'node node_modules/prettier/bin/prettier.cjs --check '+PARSER+' '+TEST,
];
const TEST_SOURCE=`import { describe, expect, it } from 'vitest';
import { parseScryfallUrl } from './scryfall-url';

describe('Scryfall hostname boundary', () => {
  it('accepts exact Scryfall host', () => {
    expect(parseScryfallUrl('https://scryfall.com/card/lea/1')).toEqual({
      set: 'lea',
      number: '1',
    });
  });

  it('rejects prefixed attacker hostname', () => {
    expect(parseScryfallUrl('https://evilscryfall.com/card/lea/1')).toBeNull();
  });

  it('accepts real subdomain boundary', () => {
    expect(parseScryfallUrl('https://www.scryfall.com/card/lea/1')).toEqual({
      set: 'lea',
      number: '1',
    });
  });
});
`;
const PATCH=`*** Begin Patch\n*** Update File: ${PARSER}\n@@\n-    if (!parsed.hostname.endsWith('scryfall.com')) {\n+    if (parsed.hostname !== 'scryfall.com' && !parsed.hostname.endsWith('.scryfall.com')) {\n*** End Patch`;
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function privateDirectory(path:string){const s=lstatSync(path);assert.equal(realpathSync(path),path);assert(s.isDirectory());assert.equal(s.uid,process.getuid!());assert.equal(s.mode&0o777,0o700);}
function regular(path:string,expected?:string){const s=lstatSync(path);assert.equal(realpathSync(path),path);assert(s.isFile());assert.equal(s.nlink,1);assert.equal(s.uid,process.getuid!());assert.equal(s.mode&0o022,0);assert(s.size<16*1024*1024);const raw=readFileSync(path);if(expected)assert.equal(sha(raw),expected);return raw;}
function exclusive(path:string,value:unknown){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(dir);}finally{closeSync(dir);}}

async function main(){
  const argv=process.argv.slice(2);assert.equal(argv.length,10);
  assert.deepEqual(argv.filter((_,i)=>i%2===0),['--manifest','--manifest-sha','--stage-sha','--admission-sha','--lease-fd']);
  const [manifestPath,manifestSha,stageSha,admissionSha,fdText]=argv.filter((_,i)=>i%2===1) as [string,string,string,string,string];
  assert.match(fdText,/^[0-9]+$/);const leaseFd=Number(fdText);assert(Number.isSafeInteger(leaseFd)&&leaseFd>=3&&leaseFd<1024);
  for(const value of [manifestSha,stageSha,admissionSha])assert.match(value,/^[a-f0-9]{64}$/);
  const manifest=JSON.parse(regular(manifestPath,manifestSha).toString()) as Json;
  const run=dirname(manifestPath);assert.equal(dirname(run),ROOT+'/validation');assert.match(run.split('/').at(-1)!,/^practical04-combined-\d{8}T\d{6}Z-[a-f0-9]{8}$/);privateDirectory(run);
  assert.equal(manifest.kind,'gary_practical04_combined');assert.equal(manifest.version,1);assert.equal(manifest.runDirectory,run);
  const sourceRoot=resolve(import.meta.dir,'../../..');assert.equal(manifest.sourceRoot,sourceRoot);assert.equal(realpathSync(sourceRoot),sourceRoot);
  assert.equal(manifest.baseCommit,BASE);assert.equal(manifest.workerImage,WORKER);assert.equal(manifest.executorImage,EXECUTOR);assert.equal(manifest.bunCacheVolume,CACHE);
  assert.deepEqual(manifest.resources,{worker:{cpus:1,memoryMiB:2048},executor:{cpus:2,memoryMiB:4096}});
  assert.equal(manifest.maxOutputBytes,8*1024*1024);assert(Number.isInteger(manifest.deadlineSeconds)&&manifest.deadlineSeconds>0&&manifest.deadlineSeconds<=1200);
  const stage=JSON.parse(regular(join(run,'stage.json'),stageSha).toString()) as Json;
  assert.equal(stage.manifestSha256,manifestSha);assert.equal(stage.staged,true);
  const admission=JSON.parse(regular(join(run,'host-admission.json'),admissionSha).toString()) as Json;
  assert.equal(admission.manifestSha256,manifestSha);assert.equal(admission.stageSha256,stageSha);assert.equal(admission.ownerPid,process.ppid);
  assert.equal(admission.lockFd,leaseFd);assert(admission.deadlineEpochMs>Date.now()&&admission.deadlineEpochMs<=Date.now()+1200_000);
  const lockPin={dev:16777232,ino:176033673,uid:501,mode:0o644,nlink:1};assert.deepEqual(admission.lockIdentity,lockPin);
  const assertHeld=()=>{const s=fstatSync(leaseFd);assert.deepEqual({dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777,nlink:s.nlink},lockPin);assert(s.isFile());assert.equal(process.ppid,admission.ownerPid);assert(Date.now()<admission.deadlineEpochMs);};assertHeld();
  assert(Array.isArray(manifest.sourceFiles)&&manifest.sourceFiles.length>300);
  for(const item of manifest.sourceFiles){assert.equal(typeof item.path,'string');assert(!item.path.startsWith('/')&&!item.path.split('/').includes('..'));const path=join(sourceRoot,item.path),raw=regular(path,item.sha256);assert.equal(raw.length,item.bytes);assert.equal(lstatSync(path).mode&0o777,item.mode);}
  const shared=ROOT.replace('/Documents/Codex/2026-10-10/task','/.gary/workspaces/engineering-validation')+'/'+run.split('/').at(-1)!;
  assert.deepEqual(manifest.staging,{run:shared,author:join(shared,'author'),verifier:join(shared,'verifier'),snapshots:join(shared,'snapshots')});
  for(const p of Object.values(manifest.staging) as string[])privateDirectory(p);
  const author=manifest.staging.author as string,verifier=manifest.staging.verifier as string;
  const hostState=join(run,'host-state'),artifacts=join(run,'artifacts');assert.equal(manifest.hostState,hostState);assert.equal(manifest.artifacts,artifacts);privateDirectory(hostState);privateDirectory(artifacts);
  const hostEnv={PATH:'/usr/bin:/bin',HOME:hostState,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
  const git=(cwd:string,args:string[])=>execFileSync('/opt/homebrew/bin/git',args,{cwd,env:hostEnv,encoding:'utf8',timeout:5000,maxBuffer:1024*1024}).trim();
  const checkClone=(path:string)=>{assert.equal(git(path,['rev-parse','HEAD']),BASE);assert.equal(git(path,['status','--porcelain=v1','--untracked-files=all']),'');assert.equal(git(path,['config','--local','remote.origin.url']),'https://github.com/707-Labs/mulligan-labs.git');assert.equal(git(path,['config','--local','core.hooksPath']),'/dev/null');assert.equal(existsSync(join(path,TEST)),false);assert.equal(sha(regular(join(path,PARSER))),'4eaf107ec9675930c385f5a9ee853bb3c50a30cee70d101956e88bc84fca1b3c');};
  checkClone(author);checkClone(verifier);
  const expectedParser=regular(join(author,PARSER)).toString().replace("if (!parsed.hostname.endsWith('scryfall.com')) {","if (parsed.hostname !== 'scryfall.com' && !parsed.hostname.endsWith('.scryfall.com')) {");
  // All real provider/network fallthrough is an error. Only the explicitly
  // injected immutable response function below can satisfy model requests.
  globalThis.fetch=Object.assign(async()=>{throw Error('combined_fixture_uninjected_network');},{preconnect(){throw Error('combined_fixture_uninjected_preconnect');}}) as typeof fetch;
  globalThis.WebSocket=class{constructor(){throw Error('combined_fixture_uninjected_socket');}} as any;
  const chain=createEngineeringContinuation04Fixture({parentDirectory:hostState});
  admitEngineeringContinuation({...chain.o,apply:true});const baseline=assertEngineeringContinuationBudget(chain.o);
  assert.equal(baseline.baselineAttemptCount,6);assert.equal(baseline.baselineChargedMicros,232012);
  const db=new Database(chain.journalPath),spend=chain.spend;
  const oldPrefix=JSON.stringify(spend.query('SELECT * FROM spend_attempts WHERE id<=152 ORDER BY id').all());
  const oldReceipts=JSON.stringify(spend.query('SELECT * FROM spend_receipts WHERE attempt_id<=152 ORDER BY 1').all());
  const guardians=join(hostState,'guardians');mkdirSync(guardians,{mode:0o700});
  exclusive(join(run,'control-paths.json'),{task:manifest.task,chainRoot:chain.root,ledgerPath:chain.o.ledgerPath,journalPath:chain.journalPath,guardianDirectory:guardians,artifacts,staging:manifest.staging});
  const progressFd=openSync(join(run,'progress.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let progressBytes=0;
  const progress=(event:Json)=>{const raw=JSON.stringify({at:Date.now(),...event})+'\n';progressBytes+=Buffer.byteLength(raw);assert(progressBytes<=1024*1024);writeFileSync(progressFd,raw);fsyncSync(progressFd);};
  const productionGuardians=createEngineeringSessionGuardianFactory({directory:guardians});
  const observedGuardians:typeof productionGuardians={async arm(context){
    progress({kind:'guardian_arming',binding:context.binding,containerName:context.containerName,workspaceRoot:context.workspaceRoot,image:context.image});
    const guardian=await productionGuardians.arm(context);
    progress({kind:'guardian_armed',binding:context.binding,containerName:context.containerName,daemonId:guardian.daemonId,guardian:guardian.reference});
    return {...guardian,async bind(containerId){progress({kind:'guardian_bind_intent',guardian:guardian.reference,containerId});await guardian.bind(containerId);progress({kind:'guardian_bound',guardian:guardian.reference,containerId});},async complete(){const proof=await guardian.complete();progress({kind:'guardian_completed',guardian:guardian.reference,proof});return proof;}};
  }};
  const commands:Json[]=[],requests:Json[]=[],fences:string[]=[];let work=0,review=0,released=false,phase='author';
  const actual=createBunEngineeringCommandRunner();
  const runner:EngineeringCommandRunner={async run(invocation){const create=invocation.argv[1]==='create';if(create)progress({kind:'executor_container_intent',argv:invocation.argv});const r=await actual.run(invocation);if(create)progress({kind:'executor_container_created',exitCode:r.exitCode,containerId:r.output.trim(),timedOut:r.timedOut,outputTruncated:r.outputTruncated});return r;},async start(invocation){
    const command=invocation.argv.at(-1)!,commandPhase=phase;const handle=await actual.start(invocation);let output='',recorded=false,exitCode:number|null=null;
    return {async poll(){const r=await handle.poll();exitCode=r.exitCode;return r;},async read(max){const r=await handle.read(max);output+=r.output;assert(Buffer.byteLength(output)<=1024*1024);if(exitCode!==null&&!r.outputPending&&!recorded){commands.push({phase:commandPhase,command,exitCode,output});recorded=true;}return r;},async stop(){await handle.stop();}};
  }};
  const authority={authenticated:true as const,requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',surface:'private_dm' as const,channelId:'D123456789',threadTs:'1234567890.000001'};
  const repository=resolveEngineeringRepository('mulligan-labs',authority,[{repositoryId:1117341295,installationId:1,fullName:'707-Labs/mulligan-labs',appAccessible:true,contents:'write',pullRequests:'write',archived:false,disabled:false,sharedChannelIds:[]}]);
  const {taskId,sessionId,ownerEpoch}=manifest.task;for(const id of [taskId,sessionId,ownerEpoch])assert.match(id,/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,100}$/);
  const policy=createEngineeringTaskPolicy({taskId,repository,baseCommit:BASE,allowedFiles:[TEST,PARSER],requiredCommands:CHECKS,publication:'patch_only',acceptancePolicyVersion:2});
  assert.equal(policy.acceptance.work.maxRequests,12);
  const task:EngineeringTaskView={taskId,spec:{taskId,requestId:'offline-combined-request',grantId:chain.o.grantId,scope:{teamId:authority.teamId,surface:'private_dm',audienceId:authority.requesterId,projectId:'707-labs:mulligan-labs'},repositoryId:'1117341295',repository:repository.repo,baseCommit:BASE,policyHash:policy.fingerprint,allocationId:chain.o.allocationId,deadlineMs:admission.deadlineEpochMs},scopeKey:'offline-combined',state:'running',ownerEpoch,sessionId,cleanupConfirmed:false,updatedAtMs:Date.now(),workerState:'not_observed'};
  const runtimeFiles=['gary_engineering_environment.py','gary_engineering_runtime.py'].map(name=>{const path=join(sourceRoot,'hermes/python',name);return {path,sha256:sha(regular(path))};});
  const config:EngineeringRuntimeConfig={version:1,acceptancePolicyVersion:2,grantId:chain.o.grantId,allocationId:chain.o.allocationId,campaignId:chain.o.campaignId,root:hostState,workspacesRoot:shared,repository:repository.repo,baseBranch:'main',baseCommit:BASE,allowedFiles:[TEST,PARSER],requiredCommands:CHECKS,deadlineMs:1200_000,workerImage:WORKER,executorImage:EXECUTOR,bunCacheVolume:CACHE,dockerExecutable:'/usr/local/bin/docker',dockerSocketPath:'/Users/tanner/.colima/default/docker.sock',runtimeFiles,sourceRevision:manifest.sourceRevision,publication:'patch_only',capMicros:5650000,budget:{aggregatePath:chain.o.aggregatePath,auditDir:chain.o.auditDir,runId:chain.o.runId,continuation:chain.o.continuation},resourceLock:{path:'/private/tmp/apple-release-xcode.lock',...lockPin,bootSessionUUID:'02D97A38-83D2-457D-967F-A01481D5EEFC',apfsVolumeUUID:'7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697'}};
  const provider=(content:Json[],stop_reason='tool_use')=>Response.json({id:'fixed-'+work+'-'+review,type:'message',role:'assistant',model:'deepseek/deepseek-v4.1-flash',content,stop_reason,usage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0, cost: 0}});
  const plan:Array<Array<[string,Json]>>=[
    [['read_file',{path:'CLAUDE.md'}]],[['read_file',{path:PARSER}]],[['read_file',{path:TEST}]],
    [['write_file',{path:TEST,content:TEST_SOURCE}]],[['terminal',{command:CHECKS[0]}]],
    [['patch',{mode:'patch',patch:PATCH}]],CHECKS.map((command):[string,Json]=>['terminal',{command}]),[],
  ];
  const options:EngineeringExecutionOptions={task,config,policy,workspaceRoot:author,artifactsRoot:artifacts,snapshotDirectory:manifest.staging.snapshots,journalDb:db,spendDb:spend,ledger:chain.ledger,continuationBaseline:baseline,
    providerApiKey:'offline-fixed-provider-no-secret',tools:JSON.parse(regular(join(sourceRoot,'hermes/engineering-tools.json')).toString()),
    session:{image:EXECUTOR,runner,journal:createSqliteEngineeringSessionJournal(db),guardian:observedGuardians,dockerBinary:config.dockerExecutable,dockerSocketPath:config.dockerSocketPath,bunCacheVolume:CACHE,resourceProfile:{cpus:2,memoryMiB:4096}},
    assertOwner:assertHeld,fence(reason){fences.push(reason);},async acquireLease(){assertHeld();return {signal:new AbortController().signal,assertHeld,async release(proof){assert.equal(proof.cleanupConfirmed,true);assertHeld();released=true;progress({kind:'flow_resource_release_requested',cleanupConfirmed:true});}};},
    async prepareVerifier(){assertHeld();checkClone(verifier);phase='verifier';progress({kind:'fresh_verifier_requested'});return {workspaceRoot:verifier};},
    async fetch(request){assertHeld();const body=await request.json() as Json;requests.push(body);if(body.max_tokens===4090){review++;assert.equal(review,1);assert.equal(work,8);const evidence=JSON.parse(body.messages[0].content[0].text);assert.equal(evidence.tests.length,3);assert(evidence.tests.every((x:Json)=>x.exitCode===0));assert(evidence.patch.includes("parsed.hostname !== 'scryfall.com'"));return provider([{type:'text',text:JSON.stringify({verdict:'approved',blockingFindings:[]})}],'end_turn');}
      assert.equal(body.max_tokens,8192);work++;assert(work<=8);const batch=plan[work-1]!;return batch.length?provider(batch.map(([name,input],i)=>({type:'tool_use',id:`image-call-${work}-${i}`,name,input}))):provider([{type:'text',text:'The named boundary regression failed before the edit and passed afterward. The required checks completed.'}],'end_turn');},
    dependencies:{createLauncher:opts=>{const launch=createEngineeringNativeLauncher(opts,{guardian:observedGuardians});return (input,signal)=>launch({...input,append(record){progress({kind:'native_observation',record});return input.append(record);}},signal);}},
  };
  const execution=createEngineeringExecution(options);let passed=false,cleanupConfirmed=false,error:string|undefined;
  try{
    const result=await execution.run('Offline fixed-response integration: repair the Scryfall hostname boundary; write the named regression, observe red, patch, observe green, and run the three required checks.',new AbortController().signal);
    assert.equal(result.completed,true);assert.equal(work,8);assert.equal(review,1);assert.deepEqual(fences,[]);
    const artifact=JSON.parse(regular(join(artifacts,'artifact.json')).toString());const capture=JSON.parse(regular(join(artifacts,'source-files.json')).toString());
    assert.equal(artifact.baseCommit,BASE);assert.deepEqual(artifact.changedFiles,[TEST,PARSER]);assert.equal(artifact.nativeReportedCompleted,true);assert.equal(artifact.publication,'disabled');assert.equal(artifact.patchSha256,sha(regular(join(artifacts,'patch.diff'))));assert.equal(capture.hash,artifact.capturedFilesHash);assert.equal(artifact.tests.length,3);
    assert.deepEqual(artifact.requests.map((r:Json)=>[r.role,r.state]),[...Array.from({length:8},()=>['work','settled']),['review','settled']]);
    const checks=commands.filter(c=>c.command.includes(CHECKS[0]!));assert.equal(checks.length,3);assert.deepEqual(checks.map(c=>[c.phase,c.exitCode]),[['author',1],['author',0],['verifier',0]]);
    const plain=(value:string)=>value.replace(/\x1b\[[0-9;]*m/g,'');const red=plain(checks[0]!.output);
    assert(red.includes('rejects prefixed attacker hostname'));assert.equal((red.match(/AssertionError:/g)??[]).length,1);assert.match(red,/AssertionError: expected [^\n]+ to be null/);
    assert.match(red,/^[ \t]*Tests[ \t]+1 failed[ \t]+\|[ \t]+2 passed[ \t]+\(3\)/m);
    for(const green of checks.slice(1)){assert.match(plain(green.output),/^[ \t]*Tests[ \t]+3[ \t]+passed[ \t]+\(3\)/m);assert.match(plain(green.output),/^[ \t]*Test Files[ \t]+1 passed[ \t]+\(1\)/m);}
    assert.equal(Buffer.from(capture.files.find((item:Json)=>item.path===TEST).base64,'base64').toString(),TEST_SOURCE);
    assert.equal(Buffer.from(capture.files.find((item:Json)=>item.path===PARSER).base64,'base64').toString(),expectedParser);
    const settled=spend.query('SELECT state,reserved_micros,charged_micros FROM spend_attempts ORDER BY id').all() as Json[];
    assert.equal(settled.length,15);assert(settled.every(row=>row.state==='settled'));assert.equal(settled.reduce((sum,row)=>sum+row.charged_micros,0),232012+8*19667+9822);
    assert.deepEqual(settled.slice(6).map(row=>[row.reserved_micros,row.charged_micros]),[...Array.from({length:8},()=>[648807,19667]),[638962,9822]]);
    const receipts=spend.query('SELECT reason FROM spend_receipts ORDER BY 1').all() as Json[];assert.equal(receipts.length,15);assert(receipts.every(row=>row.reason==='accepted'));
    for(const item of capture.files){assert.equal(item.kind,'file');assert.equal(sha(Buffer.from(item.base64,'base64')),item.sha256);assert.equal(readFileSync(join(verifier,item.path),'base64'),item.base64);}
    passed=true;
  }catch(e){error=e instanceof Error?e.message:String(e);}
  finally{
    try{const proof=await execution.cleanup();cleanupConfirmed=proof.absent&&released;}catch(e){error='cleanup: '+(e instanceof Error?e.message:String(e));passed=false;}
    assert.equal(JSON.stringify(spend.query('SELECT * FROM spend_attempts WHERE id<=152 ORDER BY id').all()),oldPrefix);assert.equal(JSON.stringify(spend.query('SELECT * FROM spend_receipts WHERE attempt_id<=152 ORDER BY 1').all()),oldReceipts);
    const attempts=spend.query('SELECT id,state,reserved_micros,charged_micros FROM spend_attempts ORDER BY id').all();
    exclusive(join(run,'flow-result.json'),{version:1,kind:'gary_practical04_combined_flow',passed:passed&&cleanupConfirmed,error,manifestSha256:manifestSha,stageSha256:stageSha,baseCommit:BASE,task:manifest.task,policy:policy.acceptance,workRequests:work,reviewRequests:review,requests,commands,spendAttempts:attempts,baselineAttemptCount:6,baselineChargedMicros:232012,priorPrefixPreserved:true,cleanupConfirmed,realNativeImage:WORKER,realExecutorImage:EXECUTOR,provider:'fixed_synthetic_responses',publication:'disabled',fences,artifacts:Object.fromEntries(['source-files.json','patch.diff','artifact.json'].filter(name=>existsSync(join(artifacts,name))).map(name=>[name,{sha256:sha(regular(join(artifacts,name)))}]))});
    // Preserve all disposable ledgers, source and receipts for independent review.
    // The outer custodian independently proves absence before releasing its FD.
    db.close();chain.close();closeSync(progressFd);
  }
  if(!passed||!cleanupConfirmed)throw Error(error??'combined_fixture_failed');
}

if(import.meta.main)await main();
