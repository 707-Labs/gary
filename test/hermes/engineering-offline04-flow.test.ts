/** Actual native AIAgent/tools → host protocol/ledger/session → real Git/test/artifact.
 * All model replies are fixed fixtures. Docker lifecycle and resource lease are
 * synthetic; commands run only in disposable fixture directories with no secrets.
 * This reproduces the observed failure shape, NOT missing historical replies.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SpendLedger } from '../../src/spend.ts';
import { createEngineeringExecution, type EngineeringExecutionOptions } from '../../src/hermes/engineering-execution.ts';
import { createEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';
import type { EngineeringTaskView } from '../../src/hermes/engineering-task-store.ts';
import type { EngineeringRuntimeConfig } from '../../src/hermes/engineering-config.ts';
import { createEngineeringStdioLauncher } from '../../src/hermes/engineering-native-launcher.ts';
import type { EngineeringCommandRunner } from '../../src/executors/engineering-session.ts';
import { createSqliteEngineeringSessionJournal } from '../../src/executors/engineering-session-journal.ts';
import { admitFixtureCommand, startOwnedFixtureCommand } from './fixtures/offline04-command-runner.ts';
import { createEngineeringContinuation04Fixture } from './fixtures/engineering-continuation04.ts';
import { admitEngineeringContinuation, assertEngineeringContinuationBudget } from '../../src/hermes/engineering-continuation-budget.ts';
import { readEngineeringDiagnostics } from '../../src/hermes/engineering-diagnostics.ts';

const NATIVE = '/Users/tanner/Documents/Codex/2026-10-07/task-4/gary-hermes-runtime/vendor/hermes';
const PYTHON = '/opt/homebrew/bin/python3.13';
const NODE = '/opt/homebrew/bin/node';
const GIT = '/opt/homebrew/bin/git';
const FIXTURES = resolve(import.meta.dir, 'fixtures');
// Optional trusted test-runner output directory. Full-suite runs need no durable capture.
const CAPTURE_DIR = process.env.GARY_OFFLINE04_CAPTURE_DIR;
if (CAPTURE_DIR && realpathSync(CAPTURE_DIR) !== CAPTURE_DIR) throw Error('offline04_capture_directory');
const PARSER = 'src/lib/utils/scryfall-url.ts', TEST = 'src/lib/utils/scryfall-url.test.ts';
const CHECK = 'bun --no-env-file --no-install test ' + TEST;
const BASE_SOURCE = readFileSync(join(FIXTURES, 'offline04-scryfall-url.ts.fixture'), 'utf8');
const TEST_SOURCE = `import { expect, test } from 'bun:test';
import { parseScryfallUrl } from './scryfall-url';
test('accepts exact Scryfall host', () => expect(parseScryfallUrl('https://scryfall.com/card/lea/1')).toEqual({set:'lea',number:'1'}));
test('rejects prefixed attacker hostname', () => expect(parseScryfallUrl('https://evilscryfall.com/card/lea/1')).toBeNull());
test('accepts real subdomain boundary', () => expect(parseScryfallUrl('https://www.scryfall.com/card/lea/1')).toEqual({set:'lea',number:'1'}));
`;
const PATCH = `*** Begin Patch\n*** Update File: ${PARSER}\n@@\n-    if (!parsed.hostname.endsWith('scryfall.com')) {\n+    if (parsed.hostname !== 'scryfall.com' && !parsed.hostname.endsWith('.scryfall.com')) {\n*** End Patch`;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
type Json = Record<string, any>;
function provider(content: Json[], reason = 'tool_use') {
  return { id: 'offline-fixture-response', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content, stop_reason: reason,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
type ReplayMode = 'no-edit' | 'corrected' | 'repeated-read' | 'same-batch' | 'practical-policy';
function harness(mode: ReplayMode) {
  expect(sha(BASE_SOURCE)).toBe('4eaf107ec9675930c385f5a9ee853bb3c50a30cee70d101956e88bc84fca1b3c');
  // All paths are beneath the checked-out test tree, never any live Gary root.
  const root = realpathSync(mkdtempSync(join(FIXTURES, 'offline04-temp-')));
  const path = (...parts: string[]) => join(root, ...parts);
  const author = path('author'), verifier = path('verifier'), state = path('state'), artifacts = path('artifacts');
  for (const dir of ['state','artifacts','snapshots','home','tools','author-tmp','verifier-tmp']) mkdirSync(path(dir), { mode: 0o700 });
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  for (const [name,binary,args] of [['bun',process.execPath,''],['node',NODE,''],['python3',PYTHON,'-B '],['bash','/bin/bash','--noprofile --norc '],['git',GIT,'']]) {
    writeFileSync(path('tools',name!), '#!/bin/sh\nexec ' + quote(binary!) + ' ' + args + '"$@"\n', { mode: 0o700 });
  }
  const env = { PATH: path('tools') + ':/usr/bin:/bin', HOME: path('home'), TMPDIR: path('author-tmp'), LANG:'C.UTF-8', CI:'1',
    GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', PYTHONDONTWRITEBYTECODE:'1',
    BUN_INSTALL_CACHE_DIR:path('bun-cache') };
  const git = (cwd: string, args: string[]) => execFileSync(GIT, args, { cwd, env, encoding:'utf8', timeout:5000, maxBuffer:1024*1024 }).trim();
  mkdirSync(author, { mode:0o700 }); mkdirSync(join(author,'src/lib/utils'), { recursive:true, mode:0o700 });
  writeFileSync(join(author,PARSER),BASE_SOURCE,{mode:0o644});
  writeFileSync(join(author,'CLAUDE.md'),'Fixture only. Change parser and test; demonstrate red then green.\n',{mode:0o644});
  writeFileSync(join(author,'package.json'),'{}\n',{mode:0o644});
  git(author,['init','-q']); git(author,['config','user.name','Offline Fixture']); git(author,['config','user.email','offline@example.invalid']);
  git(author,['config','core.hooksPath','/dev/null']);
  git(author,['remote','add','origin','https://github.com/707-Labs/fixture.git']);
  git(author,['add','.']); git(author,['commit','-qm','synthetic baseline with exact admitted parser bytes']);
  const base = git(author,['rev-parse','HEAD']);
  git(author,['bundle','create',path('baseline.bundle'),'HEAD']);
  const continuation = mode === 'practical-policy' ? createEngineeringContinuation04Fixture() : undefined;
  if (continuation) admitEngineeringContinuation({ ...continuation.o, apply:true });
  const baseline = continuation ? assertEngineeringContinuationBudget(continuation.o) : undefined;
  const ledger = continuation?.ledger ?? new SpendLedger(path('spend.sqlite'));
  if (!continuation) { ledger.createCampaign('fixture',5.65); ledger.enrollTicket('fixture','allocation',5.65); }
  const allocationId = continuation?.o.allocationId ?? 'allocation', campaignId = continuation?.o.campaignId ?? 'fixture';
  const spendDb = continuation?.spend ?? new Database(path('spend.sqlite'),{readonly:true}), db = new Database(continuation?.journalPath ?? path('engineering.sqlite'));
  const previousPrefix = JSON.stringify(spendDb.query('SELECT * FROM spend_attempts WHERE id <= 152 ORDER BY id').all());
  const journal = createSqliteEngineeringSessionJournal(db), requests: Json[] = [], commands: Json[] = [], events:string[] = [], fences:string[] = [];
  const containers = new Map<string,{root:string; live:boolean; labels:Json}>();
  const owned = new Map<string, Array<ReturnType<typeof startOwnedFixtureCommand>>>();
  let leaseHeld = false, nativeClosed = false, work = 0, review = 0;
  const runner: EngineeringCommandRunner = { synthetic:true,
    async run({argv,env:dockerEnv}) {
      expect(dockerEnv.HOME).toBe('/nonexistent');
      const op=argv[1]; let output='';
      if(op==='create') {
        expect(leaseHeld).toBe(true); expect(argv).toContain('--network=none');
        const mount=argv.find(s=>s.startsWith('type=bind,src='))!;
        const workspace=mount.slice(14).split(',dst=')[0]!;
        expect([author,verifier]).toContain(workspace);
        const labels:Json={}; argv.forEach((s,i)=>{if(s==='--label'){const [k,...v]=argv[i+1]!.split('=');labels[k!]=v.join('=');}});
        const id=String(containers.size+1).repeat(64); containers.set(id,{root:workspace,live:false,labels}); output=id;
      } else if(op==='start') containers.get(argv[2]!)!.live=true;
      else if(op==='ps') {const id=argv.find(s=>s.startsWith('id='))!.slice(3);output=containers.get(id)?.live?id:'';}
      else if(op==='inspect') {const id=argv.at(-1)!,c=containers.get(id)!;output=JSON.stringify({Id:id,Config:{Labels:c.labels}});}
      else if(op==='rm') {const c=containers.get(argv.at(-1)!)!;for(const command of owned.get(c.root)??[])await command.assertAbsent();c.live=false;events.push('sandbox-absent');}
      else throw Error('unexpected synthetic control '+op);
      return {output,exitCode:0,timedOut:false,outputTruncated:false};
    },
    async start(invocation) {
      const c=containers.get(invocation.argv[5]!)!; expect(c.live && leaseHeld).toBe(true);
      const raw=invocation.argv.at(-1)!;
      // Exact reviewed native command/stdin templates; unknown output never
      // grants new shell authority. Only ephemeral nonce and this base normalize.
      admitFixtureCommand(c.root===author?'author':'verifier',raw,invocation.stdin,base);
      const tmp=c.root===author?path('author-tmp'):path('verifier-tmp');
      const mapped=raw.replaceAll('/workspace',c.root).replaceAll('/tmp',tmp);
      const command=startOwnedFixtureCommand(mapped,{cwd:c.root,env:{...env,TMPDIR:tmp},...(invocation.stdin!==undefined?{stdin:invocation.stdin}:{}),timeoutMs:Math.min(10000,invocation.timeoutMs)});
      const list=owned.get(c.root)??[];list.push(command);owned.set(c.root,list);
      let read=false, recorded=false;
      return {async poll(){const result=command.result();return {running:!result,exitCode:result?.exitCode??null,timedOut:result?.timedOut??false};},
        async read(){const result=await command.completion;const output=result.output.replaceAll(c.root,'/workspace').replaceAll(tmp,'/tmp');
          if(!recorded){commands.push({phase:c.root===author?'author':'verifier',command:raw,output,exitCode:result.exitCode,groupAbsent:result.groupAbsent});recorded=true;}
          const v={output:read?'':output,outputTruncated:false};read=true;return v;},async stop(){await command.stop();}};
    }
  };
  const authority={authenticated:true as const,requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',surface:'private_dm' as const,channelId:'D123456789',threadTs:'1234567890.000001'};
  const repo=resolveEngineeringRepository('fixture',authority,[{repositoryId:1,installationId:2,fullName:'707-Labs/fixture',appAccessible:true,contents:'write',pullRequests:'write',archived:false,disabled:false,sharedChannelIds:[]}]);
  const policy=createEngineeringTaskPolicy({taskId:'offline04',repository:repo,baseCommit:base,allowedFiles:[TEST,PARSER],requiredCommands:[CHECK],publication:'patch_only', ...(mode==='practical-policy'?{acceptancePolicyVersion:2 as const}:{})});
  const task:EngineeringTaskView={taskId:'offline04',spec:{taskId:'offline04',requestId:'request',grantId:'grant',scope:{teamId:authority.teamId,surface:'private_dm',audienceId:authority.requesterId,projectId:'707-labs:fixture'},repositoryId:'1',repository:repo.repo,baseCommit:base,policyHash:policy.fingerprint,allocationId,deadlineMs:Date.now()+90000},scopeKey:'fixture',state:'running',ownerEpoch:'owner',sessionId:'session',cleanupConfirmed:false,updatedAtMs:Date.now(),workerState:'not_observed'};
  const config:EngineeringRuntimeConfig={version:1,grantId:'grant',allocationId,campaignId,root:state,workspacesRoot:root,repository:repo.repo,baseBranch:'main',baseCommit:base,allowedFiles:[TEST,PARSER],requiredCommands:[CHECK],deadlineMs:1800000,workerImage:'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',executorImage:'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c',bunCacheVolume:'unused-fixture',dockerExecutable:'/usr/local/bin/docker',dockerSocketPath:'/Users/tanner/.colima/default/docker.sock',runtimeFiles:[],sourceRevision:'b'.repeat(40),publication:'patch_only',capMicros:5650000,budget:{aggregatePath:path('aggregate.json'),auditDir:path('audit'),runId:'grant'},resourceLock:{path:'/private/tmp/apple-release-xcode.lock',dev:1,ino:2,uid:501,mode:0o644,nlink:1,bootSessionUUID:'02D97A38-83D2-457D-967F-A01481D5EEFC',apfsVolumeUUID:'7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697'}};
  const options:EngineeringExecutionOptions={task,config,policy,workspaceRoot:author,artifactsRoot:artifacts,snapshotDirectory:path('snapshots'),journalDb:db,spendDb,ledger,
    tools:JSON.parse(readFileSync(resolve('hermes/engineering-tools.json'),'utf8')),providerApiKey:'offline-fixture-no-secret',...(baseline?{continuationBaseline:baseline}:{}),session:{image:config.executorImage,runner,journal,resourceProfile:{cpus:2,memoryMiB:4096}},
    assertOwner(){},fence(reason){fences.push(reason);},
    async acquireLease(){leaseHeld=true;return {signal:new AbortController().signal,assertHeld(){expect(leaseHeld).toBe(true);},async release(){expect(nativeClosed).toBe(true);expect([...containers.values()].some(c=>c.live)).toBe(false);leaseHeld=false;events.push('lease-released');}};},
    async prepareVerifier(){expect(nativeClosed).toBe(true);expect([...containers.values()].some(c=>c.live)).toBe(false);
      // Fresh local Git metadata from immutable baseline; no author .git or deps.
      mkdirSync(verifier,{mode:0o700});git(verifier,['init','--quiet','--template=','.']);git(verifier,['config','core.hooksPath','/dev/null']);git(verifier,['remote','add','origin','https://github.com/707-Labs/fixture.git']);git(verifier,['fetch','--quiet','--no-tags','--no-recurse-submodules',path('baseline.bundle'),'HEAD']);git(verifier,['checkout','--quiet','--detach',base,'--']);
      expect(git(verifier,['rev-parse','HEAD'])).toBe(base);return {workspaceRoot:verifier};},
    async fetch(request){
      const body=await request.json() as Json;requests.push(body);
      if(body.max_tokens===4090){review++;expect(nativeClosed).toBe(true);expect([...containers.values()].some(c=>c.live)).toBe(false);
        const evidence=JSON.parse(body.messages[0].content[0].text);expect(evidence.patch).toContain("parsed.hostname !== 'scryfall.com'");expect(evidence.tests).toHaveLength(1);expect(evidence.tests[0].exitCode).toBe(0);
        return Response.json(provider([{type:'text',text:JSON.stringify({verdict:'approved',blockingFindings:[]})}],'end_turn'));}
      work++; expect(work).toBeLessThanOrEqual(policy.acceptance.work.maxRequests);
      const batches: Array<Array<[string,Json]>> = mode==='practical-policy' ? [
        [['read_file',{path:'CLAUDE.md'}]], [['read_file',{path:PARSER}]], [['read_file',{path:TEST}]],
        [['write_file',{path:TEST,content:TEST_SOURCE}]], [['terminal',{command:CHECK}]],
        [['patch',{mode:'patch',patch:PATCH}]], [['terminal',{command:CHECK}]], [],
      ] : (mode==='corrected'||mode==='same-batch') ? [
        [['read_file',{path:'CLAUDE.md'}],['read_file',{path:PARSER}]],
        [['write_file',{path:TEST,content:TEST_SOURCE}],['terminal',{command:CHECK}],['patch',{mode:'patch',patch:PATCH}],...(mode==='same-batch'?[['terminal',{command:CHECK}] as [string,Json]]:[])],
        mode==='same-batch'?[]:[['terminal',{command:CHECK}]],
      ] : [
        [['read_file',{path:'CLAUDE.md'}],['read_file',{path:PARSER}]],
        [['read_file',{path:TEST}]],
        mode==='repeated-read' ? [['read_file',{path:PARSER}],['read_file',{path:'CLAUDE.md'}],['terminal',{command:'pwd'}],['terminal',{command:'printf bounded-observation'}]] : [['read_file',{path:'package.json'}],['terminal',{command:'pwd'}],['terminal',{command:'printf bounded-observation'}],['terminal',{command:'test -f '+PARSER}]],
      ];
      const batch=batches[work-1]!;
      return Response.json(batch.length?provider(batch.map(([name,input],i)=>({type:'tool_use',id:`call-${work}-${i}`,name,input}))):provider([{type:'text',text:'The regression failed before the edit and passed afterward.'}],'end_turn'));
    },
    dependencies:{createLauncher:()=>createEngineeringStdioLauncher({command:[PYTHON,join(FIXTURES,'offline04-native-worker.py'),path('native-wire.jsonl')],cwd:root,
      env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},fixturePaths:{nativeSource:NATIVE,scopedHome:path('home','native')},async cleanup(){nativeClosed=true;events.push('native-absent');}})}
  };
  const execution=createEngineeringExecution(options);
  const wire=()=>readFileSync(path('native-wire.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as Json);
  return {root,author,verifier,artifacts,requests,commands,events,fences,ledger,db,execution,wire,
    allocationId,policy,baseline,counts:()=>({work,review}),async cleanup(){
      const evidence:Json={synthetic:true,historicalAcceptanceReplay:false,baseCommit:base,parserBaselineSha256:sha(BASE_SOURCE)};
      try {
        Object.assign(evidence,{wire:existsSync(path('native-wire.jsonl'))?readFileSync(path('native-wire.jsonl'),'utf8'):null,requests,commands,
          diagnostics:db.query('SELECT payload_json FROM engineering_diagnostics_v1').all(),fences,
          spendAttempts:spendDb.query('SELECT id,state,reserved_micros,charged_micros FROM spend_attempts ORDER BY id').all(),
          artifacts:Object.fromEntries(['source-files.json','patch.diff','artifact.json'].filter(n=>existsSync(join(artifacts,n))).map(n=>[n,readFileSync(join(artifacts,n),'utf8')]))});
      } finally {
        await execution.cleanup();expect(leaseHeld).toBe(false);
        expect(nativeClosed).toBe(true);expect([...containers.values()].some(c=>c.live)).toBe(false);
        if(continuation)expect(JSON.stringify(spendDb.query('SELECT * FROM spend_attempts WHERE id <= 152 ORDER BY id').all())).toBe(previousPrefix);
        db.close();if(continuation)continuation.dispose();else{spendDb.close();ledger.close();}rmSync(root,{recursive:true,force:true});
        evidence.cleanup={nativeClosed,syntheticContainersAbsent:true,syntheticLeaseReleased:!leaseHeld,temporaryFilesRemoved:!existsSync(root)};
        if(CAPTURE_DIR)writeFileSync(join(CAPTURE_DIR,'offline04-'+mode+'-capture.json'),JSON.stringify(evidence,null,2),{mode:0o600,flag:'wx'});
      }
    }};
}
const available=existsSync(NATIVE)&&existsSync(PYTHON)&&existsSync(NODE);
for (const mode of ['no-edit','repeated-read'] as const) test.skipIf(!available)(`offline04 ${mode}: native missing-file error then bounded exhaustion produces no patch or review`,async()=>{
  const f=harness(mode);try{
    await expect(f.execution.run('Offline fixture: repair hostname boundary.',new AbortController().signal)).rejects.toThrow('engineering_execution:patch_missing');
    expect(f.counts()).toEqual({work:3,review:0});
    const diagnostics=readEngineeringDiagnostics(f.db,{taskId:'offline04',requestId:'request',sessionId:'session',ownerEpoch:'owner'});
    expect(diagnostics.find(r=>r.event==='native_result')?.workerReported).toMatchObject({outcome:'iteration_limit',modelRequests:3,toolCalls:7,toolFailures:0,toolBlocks:0,toolResultErrors:1,toolErrorDetails:[{toolName:'read_file',toolOrdinal:3,phase:'native_result',category:'native_reported_error'}]});
    expect(diagnostics.some((r:any)=>r.diagnostic?.code==='engineering_execution:patch_missing'||r.code==='engineering_execution:patch_missing')).toBe(true);
    expect(readFileSync(join(f.author,PARSER),'utf8')).toBe(BASE_SOURCE);expect(existsSync(join(f.author,TEST))).toBe(false);
    expect(existsSync(join(f.artifacts,'source-files.json'))).toBe(true);expect(existsSync(join(f.artifacts,'patch.diff'))).toBe(false);expect(existsSync(join(f.artifacts,'artifact.json'))).toBe(false);
    expect(f.ledger.status('allocation')?.attemptCount).toBe(3);
    if(mode==='repeated-read'){
      const frames=f.wire(), presentations=frames.filter(x=>x.kind==='rpc'&&x.body.kind==='tool.presentation');
      expect(presentations).toHaveLength(7);
      expect(presentations.some(x=>x.body.payload.rawResultHash!==x.body.payload.resultHash)).toBe(true);
      expect(JSON.stringify(frames.find(x=>x.type==='engineering.result'))).toContain('Tool loop warning');
    }
  }finally{await f.cleanup();}
},100000);
for (const mode of ['corrected','same-batch','practical-policy'] as const) test.skipIf(!available)(`offline04 ${mode}: actual native writes/red/patch/green reach fresh-verifier artifact and separately settled review`,async()=>{
  const f=harness(mode);try{
    const result=await f.execution.run('Offline fixture: repair hostname boundary.',new AbortController().signal);expect(result.completed).toBe(true);
    const workCount=mode==='practical-policy'?8:3;
    expect(f.counts()).toEqual({work:workCount,review:1});
    if(mode==='practical-policy'){
      expect(f.policy.acceptance.version).toBe(2);expect(f.policy.acceptance.work.maxRequests).toBe(12);
      expect(f.baseline).toMatchObject({baselineAttemptCount:6,baselineChargedMicros:232012});
      expect(f.requests.filter(r=>r.max_tokens===8192)).toHaveLength(8);
    }
    const checks=f.commands.filter(c=>c.command.includes(CHECK));
    expect(checks.map(c=>[c.phase,c.exitCode])).toEqual([['author',1],['author',0],['verifier',0]]);
    expect(checks[0]!.output).toContain('rejects prefixed attacker hostname');
    if(mode==='same-batch'){
      const begins=f.wire().filter(x=>x.kind==='rpc'&&x.body.kind==='tool.begin').map(x=>x.body.payload);
      expect(begins).toHaveLength(6);expect(begins.filter(x=>x.toolName==='terminal').map(x=>[x.toolCallId,x.originalArgs.command])).toEqual([['call-2-1',CHECK],['call-2-3',CHECK]]);
    }
    const artifact=JSON.parse(readFileSync(join(f.artifacts,'artifact.json'),'utf8'));
    expect(artifact.changedFiles).toEqual([TEST,PARSER]);expect(artifact.nativeReportedCompleted).toBe(mode!=='corrected');expect(artifact.publication).toBe('disabled');
    expect(artifact.tests).toHaveLength(1);expect(artifact.review).toEqual({verdict:'approved',blockingFindings:[]});
    expect(artifact.requests.map((r:Json)=>[r.role,r.state])).toEqual([...Array.from({length:workCount},()=>['work','settled']),['review','settled']]);
    expect(sha(readFileSync(join(f.artifacts,'patch.diff')))).toBe(artifact.patchSha256);
    const captured=JSON.parse(readFileSync(join(f.artifacts,'source-files.json'),'utf8'));expect(captured.hash).toBe(artifact.capturedFilesHash);
    for(const file of captured.files){expect(file.kind).toBe('file');expect(sha(Buffer.from(file.base64,'base64'))).toBe(file.sha256);expect(readFileSync(join(f.verifier,file.path),'base64')).toBe(file.base64);}
    expect(f.fences).toEqual([]);expect(f.ledger.status(f.allocationId)?.attemptCount).toBe(workCount+1+(mode==='practical-policy'?6:0));
  }finally{await f.cleanup();}
},100000);
