/** Offline rollback evidence. All databases, authority, messages and receipts are synthetic.
 * The old release is extracted from local Git or an explicitly hash-pinned bundle.
 * Bundle mode imports into its own temporary bare repository; no live .git fallback.
 * No network, Docker, service, or live store is used.
 * Optional GARY_COMPAT_RECEIPT writes a report only after every assertion passes.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as currentDb from '../src/state/db.ts';
import * as currentSpend from '../src/spend.ts';
import * as currentDm from '../src/slack/conversation.ts';
import * as currentShared from '../src/slack/shared-conversation.ts';
import * as currentSlack from '../src/slack/service.ts';
import * as currentAlerts from '../src/slack/alert-intake.ts';
import * as currentAlertConfig from '../src/slack/alert-config.ts';
import * as currentProjects from '../src/hermes/project-assistant.ts';
import * as currentJobs from '../src/executors/job-journal.ts';
import * as currentTrial from '../src/hermes/coding-trial.ts';
import * as currentQueries from '../src/state/queries.ts';
import { createEngineeringRuntime } from '../src/hermes/engineering-runtime.ts';
import { EngineeringTaskStore } from '../src/hermes/engineering-task-store.ts';
import type { EngineeringRuntimeConfig } from '../src/hermes/engineering-config.ts';
import type { SlackTransport } from '../src/slack/transport.ts';

const OLD = 'e849a0d1200b8e6f178be8a92e6478868deacb62';
const repo = realpathSync(join(import.meta.dir, '..'));
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const oldIssue = '11111111-1111-4111-8111-111111111111';
const engineeringAllocation = 'local:engineering-rollback-fixture';
const CLOCK = 1_791_633_600_000;
const denied = (): never => { throw Error('offline_fixture_unexpected_external_effect'); };
const current = { db: currentDb, spend: currentSpend, dm: currentDm, shared: currentShared, slack: currentSlack,
  alerts: currentAlerts, alertConfig: currentAlertConfig, projects: currentProjects, jobs: currentJobs, trial: currentTrial, queries: currentQueries };
type Release = typeof current;
function command(args: string[]): string {
  const result = Bun.spawnSync(args, { cwd: repo, env: { HOME: '/tmp', PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw Error(`${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function privateDir(path: string): string { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; }
function privateJson(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function archiveOldRelease(root:string,bundlePath?:string,bundleSha?:string): {kind:'checkout'|'bundle';sha256:string|null} {
  if((bundlePath===undefined)!==(bundleSha===undefined))throw Error('compatibility_bundle_pair_required');
  const git=['/usr/bin/git','-c','core.hooksPath=/dev/null','-c','protocol.allow=never'];
  if(bundlePath===undefined){command([...git,'archive','--format=tar','--output='+join(root,'old.tar'),OLD]);return {kind:'checkout',sha256:null};}
  if(!bundleSha||!/^[a-f0-9]{64}$/.test(bundleSha)||!isAbsolute(bundlePath)||realpathSync(bundlePath)!==bundlePath)throw Error('compatibility_bundle_binding');
  const before=lstatSync(bundlePath);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==process.getuid?.()||before.size<=0||before.size>150_000_000)throw Error('compatibility_bundle_file');
  const fd=openSync(bundlePath,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
  try{
    const opened=fstatSync(fd);
    if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)throw Error('compatibility_bundle_changed');
    bytes=readFileSync(fd);
    if(bytes.length!==before.size||sha(bytes)!==bundleSha)throw Error('compatibility_bundle_sha');
  }finally{closeSync(fd);}
  // All Git commands consume only this verified private copy. The supplied path
  // can subsequently disappear without changing the archive used by the test.
  const copy=join(root,'old.bundle'),bare=privateDir(join(root,'old.git'));
  writeFileSync(copy,bytes,{mode:0o600,flag:'wx'});
  const isolatedGit=[...git,'-C',root];
  if(command([...isolatedGit,'bundle','list-heads',copy])!==OLD+' HEAD')throw Error('compatibility_bundle_ref');
  command([...isolatedGit,'init','--bare','--template=',bare]);
  command([...isolatedGit,'--git-dir='+bare,'bundle','verify',copy]);
  command([...isolatedGit,'--git-dir='+bare,'-c','protocol.file.allow=always','fetch','--no-tags','--no-recurse-submodules','--no-write-fetch-head',copy,'HEAD:refs/compat/old']);
  if(command([...isolatedGit,'--git-dir='+bare,'rev-parse','--verify','refs/compat/old^{commit}'])!==OLD)throw Error('compatibility_bundle_commit');
  command([...isolatedGit,'--git-dir='+bare,'archive','--format=tar','--output='+join(root,'old.tar'),'refs/compat/old']);
  return {kind:'bundle',sha256:bundleSha};
}

test('explicit archive bundles fail closed on incomplete pairs or wrong digest without Git fallback',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'gary-compat-bundle-input-')));chmodSync(root,0o700);
  try{
    const path=join(root,'not-a-bundle');writeFileSync(path,'synthetic invalid bundle',{mode:0o600});
    expect(()=>archiveOldRelease(root,path)).toThrow('compatibility_bundle_pair_required');
    expect(()=>archiveOldRelease(root,undefined,'a'.repeat(64))).toThrow('compatibility_bundle_pair_required');
    expect(()=>archiveOldRelease(root,path,'a'.repeat(64))).toThrow('compatibility_bundle_sha');
  }finally{rmSync(root,{recursive:true,force:true});}
});
type Schema = { type: string; name: string; tbl_name: string; sql: string | null };
function snapshot(path: string) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const schema = db.query<Schema, []>('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const rows = Object.fromEntries(schema.filter(row => row.type === 'table').map(row => {
      const quoted = '"' + row.name.replaceAll('"', '""') + '"';
      return [row.name, db.query(`SELECT * FROM ${quoted}`).all().map(row => JSON.stringify(row)).sort()];
    }));
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    return { schema, rows, applicationId: db.query('PRAGMA application_id').get(), userVersion: db.query('PRAGMA user_version').get() };
  } finally { db.close(); }
}
function sourceHashes(): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string): void => { for (const file of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, file.name); if (file.isDirectory()) walk(full);
    else if (file.isFile()) result[relative(repo, full)] = sha(readFileSync(full));
  } };
  walk(join(repo, 'src'));
  for (const path of ['hermes/engineering-tools.json', 'test/rollback-engineering-compatibility.test.ts', 'bun.lock', 'package.json']) {
    result[path] = sha(readFileSync(join(repo, path)));
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

test('e849a0d reopens nine candidate stores preserving every row, fingerprints, closed trials, and separate engineering history', async () => {
  const hashesBefore = sourceHashes();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-rollback-compat-'))); chmodSync(root, 0o700);
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    const oldRoot = privateDir(join(root, 'old-source'));
    const oldSource=archiveOldRelease(root,process.env.GARY_COMPAT_BUNDLE_PATH,process.env.GARY_COMPAT_BUNDLE_SHA256);
    command(['/usr/bin/tar', '-xf', join(root, 'old.tar'), '-C', oldRoot]);
    symlinkSync(join(repo, 'node_modules'), join(oldRoot, 'node_modules'));
    const load = (path: string) => import(pathToFileURL(join(oldRoot, path)).href);
    // Actual modules from the exact historical Git commit, never a reimplementation.
    const old = Object.fromEntries(await Promise.all(Object.entries({ db:'src/state/db.ts',spend:'src/spend.ts',dm:'src/slack/conversation.ts',
      shared:'src/slack/shared-conversation.ts',slack:'src/slack/service.ts',alerts:'src/slack/alert-intake.ts',alertConfig:'src/slack/alert-config.ts',
      projects:'src/hermes/project-assistant.ts',jobs:'src/executors/job-journal.ts',trial:'src/hermes/coding-trial.ts',queries:'src/state/queries.ts' })
      .map(async ([key,path]) => [key,await load(path)]))) as Release;
    const data = privateDir(join(root, 'synthetic-stores'));
    const dmRoot = privateDir(join(data, 'dm')), sharedRoot = privateDir(join(data, 'shared'));
    const alertsRoot = privateDir(join(data, 'alerts')), projectRoot = privateDir(join(data, 'projects'));
    const jobs = ['ert2990','ert3336','ert3434'].map(id => privateDir(join(data, id)));
    const paths: Record<string, string> = { 'gary.db':join(data,'gary.db'), 'spend.db':join(data,'spend.db'),
      'dm/context.sqlite':join(dmRoot,'context.sqlite'), 'shared/shared-context.sqlite':join(sharedRoot,'shared-context.sqlite'),
      'project-memory.sqlite':join(projectRoot,'project-memory.sqlite'), 'alerts.sqlite':join(alertsRoot,'alerts.sqlite'),
      ...Object.fromEntries(jobs.map((directory,i) => [['ert2990','ert3336','ert3434'][i]+'/jobs.sqlite',join(directory,'jobs.sqlite')])) };
    privateJson(join(dmRoot,'config.json'), {version:1,runId:'hermes-dm-20261008',campaignId:'hermes-dm-20261008',allocationId:'local:hermes-dm-20261008-tanner'});
    privateJson(join(sharedRoot,'config.json'), {version:1,runId:'hermes-shared-20261008',campaignId:'hermes-shared-20261008',allocationId:'local:hermes-shared-20261008',
      appId:currentSlack.GARY_SLACK.appId,teamId:currentSlack.GARY_SLACK.teamId,botUserId:currentSlack.GARY_SLACK.botUserId,trigger:'explicit_mention'});
    const metadata = { async memberInfo(id:string) { return {id,teamId:currentSlack.GARY_SLACK.teamId,deleted:false,isBot:false,isAppUser:false,isRestricted:false,isUltraRestricted:false,isStranger:false,observedAt:Date.now()}; },
      async channelInfo(id:string) {return {id,teamId:currentSlack.GARY_SLACK.teamId,isMember:true,isArchived:false,isPrivate:false,isShared:false,isExtShared:false,isOrgShared:false,isPendingExtShared:false,observedAt:Date.now()};} };
    let prohibitedEffects = 0;
    const external = (): never => { prohibitedEffects++; return denied(); };
    const projectOptions = {teamId:currentSlack.GARY_SLACK.teamId,ownerUserId:currentSlack.GARY_SLACK.tannerId,memoryPath:paths['project-memory.sqlite']!,
      projects:[{id:'fixture',label:'Fixture',summary:'Synthetic compatibility project',sharedChannelIds:['C0FIXTURE1']}]};
    const audience = {teamId:currentSlack.GARY_SLACK.teamId,requesterId:currentSlack.GARY_SLACK.tannerId,surface:'private_dm' as const,channelId:'D0FIXTURE1',threadTs:'1791633600.000001'};
    const alertConfig = {version:1 as const,mode:'draft' as const,producer:{botId:'B0AJNH6K4LF' as const,appId:'A0AK0JCN5PF' as const},directory:alertsRoot,fingerprint:'a'.repeat(64)};
    const allSnapshots = () => Object.fromEntries(Object.entries(paths).map(([name,path]) => [name,snapshot(path)]));
    async function open(release:Release, engineeringIngress?:currentSlack.EngineeringIngress) {
      const db = release.db.openDb(paths['gary.db']!), ledger = new release.spend.SpendLedger(paths['spend.db']!);
      const dmConfig = release.dm.loadSlackConversationConfig(join(dmRoot,'config.json'));
      const sharedConfig = release.shared.loadSlackSharedConversationConfig(join(sharedRoot,'config.json'));
      for (const c of [dmConfig,sharedConfig]) { ledger.createCampaign(c.campaignId,5); ledger.enrollTicket(c.campaignId,c.allocationId,5); }
      const conversation = release.dm.createSlackConversation({config:dmConfig,ledger,reply:async()=> 'Synthetic private answer'});
      const shared = release.shared.createSlackSharedConversation({config:sharedConfig,ledger,metadata,reply:async()=> 'Synthetic shared answer'});
      const projects = new release.projects.ProjectAssistant(projectOptions);
      const alertDb = release.alertConfig.openSlackAlertDatabase(alertConfig);
      const alerts = release.alerts.createSlackAlertIntake({db:alertDb,producer:alertConfig.producer,mode:'draft',now:()=>CLOCK,
        transport:{channelInfo:async()=>external(),sendMessage:async()=>external()}});
      alerts.initialize();
      const journals = jobs.map(directory => release.jobs.createExecutorJobJournal({directory,dockerHost:'unix:///synthetic/no-daemon.sock',dockerBinary:'/synthetic/never-run-docker'}));
      let callback: ((event:unknown)=>void|Promise<void>) | undefined, connected=false, sends=0;
      const transport:SlackTransport = {async identity(){return {appId:currentSlack.GARY_SLACK.appId,teamId:currentSlack.GARY_SLACK.teamId,botUserId:currentSlack.GARY_SLACK.botUserId};},
        socketHealthy:()=>connected,async start(handler){callback=handler;connected=true;},async stop(){connected=false;},
        async sendMessage(args){sends++;return {ok:true,channel:args.channel.startsWith('U')?'D0FIXTURE1':args.channel,ts:'1791633600.999999'};} };
      const slack = release.slack.createSlackService({db,transport,tannerDirectMessages:true,conversation,sharedConversation:shared,checkConversationHealth:()=>true,
        checkHostHealth:async()=>({kind:'readonly_runtime' as const,ready:true,readonlyCanarySucceeded:true,receiptId:'synthetic-retained-ready'}),
        ...(engineeringIngress?{engineeringIngress,checkEngineeringHealth:()=>true}:{})});
      expect((await slack.start()).running).toBe(true);
      let closed=false;
      const close=async()=>{if(closed)return;closed=true;await slack.stop();conversation.close();shared.close();projects.close();alerts.close();alertDb.close();journals.forEach(j=>j.close());ledger.close();db.close();};
      cleanup.push(close);
      return {db,ledger,dmConfig,sharedConfig,conversation,shared,projects,alertDb,journals,slack,close,emit:async(event:unknown)=>callback?.(event),sends:()=>sends};
    }
    const before = await open(old);
    old.queries.upsertTicket(before.db,{linearId:oldIssue,identifier:'ERT-3434'});
    before.ledger.createCampaign('closed-ert-trial',10);before.ledger.enrollTicket('closed-ert-trial',oldIssue,10,{draftPr:true,codingReviewReserve:true});
    const trial = old.trial.createCodingTrial({db:before.db,ledger:before.ledger,issueId:oldIssue,repo:'707-Labs/fixture',policyFingerprint:'synthetic-closed-policy'});
    trial.admit({issueId:oldIssue,repo:'707-Labs/fixture',actionType:'classify',fingerprint:'historical',humanSignature:'historical',provider:'deepseek',model:'deepseek-v4-pro'}).complete(false,'handled','synthetic closed trial');
    await before.conversation.respond({eventId:'EvOldDM',channel:audience.channelId,ts:audience.threadTs,threadTs:audience.threadTs,text:'Synthetic retained private history'},async()=> 'sent',new AbortController().signal);
    await before.shared.respond({type:'app_mention',appId:currentSlack.GARY_SLACK.appId,teamId:audience.teamId,botUserId:currentSlack.GARY_SLACK.botUserId,requesterId:audience.requesterId,
      eventId:'EvOldShared',channel:'C0FIXTURE1',ts:audience.threadTs,threadTs:audience.threadTs,text:'Synthetic retained shared history'},async()=> 'sent',new AbortController().signal);
    expect((await before.projects.execute({audience,requestId:'old-note',toolName:'remember_fact',args:{project:'fixture',text:'Synthetic private fact'}})).ok).toBe(true);
    before.alertDb.query("INSERT INTO alert_messages VALUES(?,?,?,?,?,'draft')").run('1791633600.000001','EvRetainedAlert',CLOCK,'{"synthetic":true}','Synthetic retained advisory');
    before.alertDb.query('INSERT INTO alert_events VALUES(?,?)').run('EvRetainedAlert','1791633600.000001');
    before.alertDb.query("UPDATE alert_counters SET value=1 WHERE name IN ('accepted','drafted')").run();
    const oldDmFingerprint=old.dm.fingerprintSlackConversationConfig(before.dmConfig),oldSharedFingerprint=old.shared.fingerprintSlackSharedConversationConfig(before.sharedConfig);
    await before.close();
    // Deliberately fabricated completed history, not a claim that any workload/provider ran.
    const spendHistory=new Database(paths['spend.db']!);
    spendHistory.query("INSERT INTO spend_attempts(id,ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state,input_tokens,http_status,settled_at) VALUES(17,?,'deepseek','deepseek-v4-pro',128,100,1,'settled',1,200,'2026-10-10T00:00:00Z')").run(oldIssue);
    spendHistory.query("INSERT INTO spend_receipts VALUES(17,'synthetic_offline_receipt','{\"synthetic\":true}','2026-10-10T00:00:00Z')").run();spendHistory.close();
    for(const [index,directory] of jobs.entries()){
      const journal=new Database(join(directory,'jobs.sqlite'));
      const invocation='00000000-0000-4000-8000-'+String(index+1).padStart(12,'0');
      journal.query("INSERT INTO invocations VALUES(?,?,'completed',?,?,?, ?,NULL,NULL)").run(invocation,'gary-longjob-'+invocation,
        JSON.stringify({taskId:'synthetic-retained-task',actionId:'17',ownerEpoch:'synthetic-owner',workspaceRoot:'/synthetic/absent',image:'sha256:'+'a'.repeat(64),argvSha256:'b'.repeat(64)}),CLOCK-1000,CLOCK-2000,CLOCK-1500);
      journal.close();
    }
    const baseline=allSnapshots();expect(Object.keys(baseline)).toHaveLength(9);

    const engineeringRoot=privateDir(join(data,'engineering')),engineeringPath=join(engineeringRoot,'engineering.sqlite');
    writeFileSync(engineeringPath,'',{mode:0o600});const engineeringDb=new Database(engineeringPath);engineeringDb.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
    cleanup.push(()=>engineeringDb.close());
    const taskStore=new EngineeringTaskStore(engineeringDb,()=>CLOCK);let admissions=0;
    const candidate=await open(current,{async admit(request){admissions++;taskStore.admit({taskId:'engineering-fixture-task',requestId:request.requestId,grantId:'fixture-grant',
      scope:{teamId:audience.teamId,surface:'private_dm',audienceId:audience.channelId,projectId:'fixture'},repositoryId:'3',repository:'707-Labs/fixture',baseCommit:'a'.repeat(40),
      policyHash:'sha256:'+'b'.repeat(64),allocationId:engineeringAllocation,deadlineMs:CLOCK+60000},()=>{});
      return {requestId:request.requestId,taskId:'engineering-fixture-task',receiptId:'synthetic-admitted-receipt',phase:'admitted',status:'queued',text:'Synthetic engineering admission'};},verifyReceipt:()=>true});
    candidate.ledger.createCampaign('engineering-compatibility',5.65);candidate.ledger.enrollTicket('engineering-compatibility',engineeringAllocation,5.65);
    const spendReader=new Database(paths['spend.db']!,{readonly:true});let readerClosed=false;
    const closeSpendReader=()=>{if(!readerClosed){readerClosed=true;spendReader.close();}};cleanup.push(closeSpendReader);
    const config:EngineeringRuntimeConfig={resourceLock: { path:'/private/tmp/apple-release-xcode.lock',dev:16777232,ino:176033673,uid:501,mode:0o644,nlink:1,bootSessionUUID:'02D97A38-83D2-457D-967F-A01481D5EEFC',apfsVolumeUUID:'7CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697' }, version:1,grantId:'fixture-grant',campaignId:'engineering-compatibility',allocationId:engineeringAllocation,root:engineeringRoot,
      workspacesRoot:privateDir(join(data,'engineering-workspaces')),
      repository:'707-Labs/fixture',baseBranch:'main',baseCommit:'a'.repeat(40),allowedFiles:['fixture.ts'],requiredCommands:['bun test'],deadlineMs:1800000,
      workerImage:'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',executorImage:'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c',
      bunCacheVolume:'gary-bun-cache-20261010-mulligan-4bb2fdde-v2',dockerExecutable:'/usr/local/bin/docker',dockerSocketPath:'/Users/tanner/.colima/default/docker.sock',runtimeFiles:[],sourceRevision:'b'.repeat(40),publication:'patch_only',capMicros:5650000,
      budget:{aggregatePath:join(engineeringRoot,'aggregate.json'),auditDir:join(engineeringRoot,'admission'),runId:'fixture-grant'}};
    const runtime=createEngineeringRuntime({config,journalDb:engineeringDb,spendDb:spendReader,ledger:candidate.ledger,now:()=>CLOCK,
      repository:{binding:{appId:1,installationId:2},observer:{installation:async()=>external(),repositories:async()=>external()},getCredential:async()=>external()},
      providerApiKey:'synthetic-unused',fetch:async()=>external(),assertGrant(){},assertRuntime(){},assertBudget(){},deliver:async()=>external(),
      dependencies:{resourceBinding:{observeBoot:()=>({bootSessionUUID:config.resourceLock.bootSessionUUID,apfsVolumeUUID:config.resourceLock.apfsVolumeUUID}),inspection:{lstat:()=>({...config.resourceLock,isFile:()=>true,isSymbolicLink:()=>false}),realpath:p=>p}},git:{run:async()=>external()},readHeadroom:async()=>external(),acquireLease:async()=>external(),createExecution:()=>external()}});
    expect(runtime.ready()).toBe(true);await runtime.stop();
    const envelope={type:'events_api',envelope_id:'synthetic-socket',payload:{type:'event_callback',team_id:audience.teamId,api_app_id:currentSlack.GARY_SLACK.appId,event_id:'EvEngineeringFixture',
      event:{type:'message',channel_type:'im',channel:audience.channelId,user:audience.requesterId,ts:'1791633600.000003',text:'!engineer 707-Labs/fixture Make a synthetic scoped edit'}}};
    await candidate.emit(envelope);await candidate.emit(envelope);expect(admissions).toBe(1);
    expect(candidate.db.query('SELECT state,task_id FROM gary_slack_engineering_ingress').all()).toEqual([{state:'bound',task_id:'engineering-fixture-task'}]);
    currentQueries.recordEvent(candidate.db,{eventType:'boot',payload:{version:'synthetic-candidate',runtime:'offline'}});
    expect((await candidate.projects.execute({audience:{...audience,surface:'shared_channel',channelId:'C0FIXTURE1'},requestId:'candidate-note',toolName:'remember_fact',args:{project:'fixture',text:'Synthetic shared candidate fact'}})).ok).toBe(true);
    expect(currentDm.fingerprintSlackConversationConfig(candidate.dmConfig)).toBe(oldDmFingerprint);
    expect(currentShared.fingerprintSlackSharedConversationConfig(candidate.sharedConfig)).toBe(oldSharedFingerprint);
    await candidate.close();closeSpendReader();
    const postCandidate=allSnapshots(),engineeringBefore=snapshot(engineeringPath);
    const copies=privateDir(join(root,'preserved-post-candidate-copies'));
    for(const [name,path] of Object.entries(paths)){
      const target=join(copies,name);privateDir(dirname(target));
      const source=new Database(path,{readonly:true});try{writeFileSync(target,source.serialize(),{mode:0o600});}finally{source.close();}
      // A serialized WAL-mode database needs its new connection to create private sidecars.
      const copied=new Database(target);copied.exec('PRAGMA journal_mode=DELETE');copied.close();
      expect(snapshot(target)).toEqual(postCandidate[name]!);
    }
    const additions: Array<{store:string;type:string;name:string;sqlSha256:string}>=[];
    for(const name of Object.keys(paths)){
      const original=baseline[name]!,after=postCandidate[name]!;
      for(const entry of original.schema)expect(after.schema.find(x=>x.type===entry.type&&x.name===entry.name)).toEqual(entry);
      for(const [table,rows] of Object.entries(original.rows))if(table!=='sqlite_sequence')for(const row of rows)expect(after.rows[table]).toContain(row);
      for(const entry of after.schema.filter(row=>!original.schema.some(x=>x.name===row.name&&x.type===row.type))){
        // SQLite's implicit unique indexes belong to the admitted new table, not a second schema change.
        if(entry.name.startsWith('sqlite_autoindex_')){expect(entry.tbl_name).toBe('gary_slack_engineering_ingress');continue;}
        additions.push({store:name,type:entry.type,name:entry.name,sqlSha256:sha(entry.sql!)});
      }
    }
    expect(additions.map(({sqlSha256,...entry})=>entry)).toEqual([{store:'gary.db',type:'table',name:'gary_slack_engineering_ingress'}]);
    expect(engineeringBefore.schema.some(row=>row.name==='engineering_tasks')).toBe(true);
    expect(engineeringBefore.rows.engineering_tasks).toHaveLength(1);
    const rolledBack=await open(old);expect(rolledBack.sends()).toBe(0);
    expect(old.dm.fingerprintSlackConversationConfig(rolledBack.dmConfig)).toBe(oldDmFingerprint);
    expect(old.shared.fingerprintSlackSharedConversationConfig(rolledBack.sharedConfig)).toBe(oldSharedFingerprint);
    expect(rolledBack.conversation.ready()).toBe(true);expect(rolledBack.shared.ready()).toBe(true);
    const privateMemory=await rolledBack.projects.execute({audience,requestId:'read-private',toolName:'recall_learning',args:{project:'fixture'}});
    const sharedMemory=await rolledBack.projects.execute({audience:{...audience,surface:'shared_channel',channelId:'C0FIXTURE1'},requestId:'read-shared',toolName:'recall_learning',args:{project:'fixture'}});
    expect(JSON.stringify(privateMemory)).toContain('Synthetic private fact');expect(JSON.stringify(privateMemory)).not.toContain('Synthetic shared candidate fact');
    expect(JSON.stringify(sharedMemory)).toContain('Synthetic shared candidate fact');expect(JSON.stringify(sharedMemory)).not.toContain('Synthetic private fact');
    const oldConfigured=old.trial.createCodingTrial({db:rolledBack.db,ledger:rolledBack.ledger,issueId:oldIssue,repo:'707-Labs/fixture',policyFingerprint:'synthetic-closed-policy'});
    const attempt={issueId:oldIssue,repo:'707-Labs/fixture',actionType:'classify',fingerprint:'new-fingerprint',humanSignature:'new',provider:'deepseek',model:'deepseek-v4-pro'};
    expect(()=>oldConfigured.admit(attempt)).toThrow('coding_trial_rejected:allocation');
    expect(()=>oldConfigured.admit({...attempt,issueId:engineeringAllocation})).toThrow('coding_trial_rejected:scope');
    expect(rolledBack.ledger.canDispatch(oldIssue)).toBe(false);
    expect(rolledBack.ledger.status(engineeringAllocation)).toMatchObject({state:'active',capMicros:5650000,attemptCount:0,unknownAttempts:0,draftPr:false});
    expect(rolledBack.ledger.hasCodingReviewReserve(engineeringAllocation)).toBe(false);
    const ordinary=old.trial.createCodingTrial({db:rolledBack.db,ledger:rolledBack.ledger,issueId:engineeringAllocation,repo:'707-Labs/fixture',policyFingerprint:'synthetic-closed-policy'});
    expect(()=>ordinary.admit({...attempt,issueId:engineeringAllocation})).toThrow('coding_trial_rejected:allocation');
    await rolledBack.close();
    const afterRollback=allSnapshots();expect(afterRollback).toEqual(postCandidate);expect(snapshot(engineeringPath)).toEqual(engineeringBefore);
    expect(prohibitedEffects).toBe(0);expect(sourceHashes()).toEqual(hashesBefore);
    const receiptPath=process.env.GARY_COMPAT_RECEIPT;
    if(receiptPath){
      const candidateCommit=process.env.GARY_COMPAT_CANDIDATE_COMMIT??null,candidateTree=process.env.GARY_COMPAT_CANDIDATE_TREE??null;
      if(candidateCommit||candidateTree){expect(candidateCommit).toMatch(/^[a-f0-9]{40}$/);expect(candidateTree).toMatch(/^[a-f0-9]{40}$/);
        expect(command(['/usr/bin/git','rev-parse','HEAD'])).toBe(candidateCommit!);expect(command(['/usr/bin/git','rev-parse','HEAD^{tree}'])).toBe(candidateTree!);
        expect(command(['/usr/bin/git','status','--porcelain','--untracked-files=all'])).toBe('');}
      const stores=Object.fromEntries(Object.entries(afterRollback).map(([name,value])=>[name,{schemaSha256:sha(JSON.stringify(value.schema)),rowsSha256:sha(JSON.stringify(value.rows)),
        tableRowCounts:Object.fromEntries(Object.entries(value.rows).map(([table,rows])=>[table,rows.length]))}]));
      writeFileSync(receiptPath,JSON.stringify({version:1,kind:'gary_engineering_rollback_compatibility',oldCommit:OLD,candidateCommit,candidateTree,passed:true,testExitCode:0,
        oldConstructorsReadCandidateStores:true,newRowsPreserved:true,dmFingerprintUnchanged:true,sharedFingerprintUnchanged:true,canonicalSchemaAdditions:additions,
        oldConfiguredTrialRemainsClosed:true,ordinaryAllocationMicros:5650000,ordinaryAllocationAttempts:0,ordinaryAllocationInertToOldTrial:true,
        separateEngineeringStorePreserved:true,externalEffects:prohibitedEffects,storeCount:9,stores,engineeringStore:{schemaSha256:sha(JSON.stringify(engineeringBefore.schema)),rowsSha256:sha(JSON.stringify(engineeringBefore.rows))},
        sourceHashes:hashesBefore,oldSource,testCommand:'/usr/bin/env -i HOME=/tmp PATH=/usr/bin:/bin /Users/tanner/.bun/bin/bun test test/rollback-engineering-compatibility.test.ts',
        scope:'Synthetic stores only. Exact old constructors reopened candidate data; all rows compared after orderly closure. No live-state, workload, HTTP, paid, or message delivery checks.'},null,2)+'\n',{flag:'wx',mode:0o600});
    }
  } finally {for(const close of cleanup.reverse())await close();rmSync(root,{recursive:true,force:true});}
},30000);
