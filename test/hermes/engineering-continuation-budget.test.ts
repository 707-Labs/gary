import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../../src/spend.ts';
import { admitEngineeringAcceptance, assertEngineeringBudgetAdmission, type EngineeringBudgetBinding } from '../../src/hermes/engineering-budget.ts';
import { observeEngineeringLedgerBootIdentity } from '../../src/hermes/engineering-budget-reboot.ts';
import { admitEngineeringContinuation, previewEngineeringContinuation, assertEngineeringContinuationBudget, assertEngineeringContinuationBaseline, type EngineeringContinuationBinding } from '../../src/hermes/engineering-continuation-budget.ts';
import { EngineeringTaskStore } from '../../src/hermes/engineering-task-store.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';
import { createEngineeringModelAdapter } from '../../src/hermes/engineering-model.ts';
import { EngineeringProtocol } from '../../src/hermes/engineering-protocol.ts';
import { createEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';
const roots: string[] = [], close: (() => void)[] = [];
afterEach(() => { for (const f of close.splice(0).reverse()) f(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function fixture(productionLedgerMetadata = false, knownChain = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'engineering-continuation-')); roots.push(root); chmodSync(root, productionLedgerMetadata ? 0o755 : 0o700);
  if(knownChain)mkdirSync(join(root,'workspaces'),{mode:0o700});
  const oldRoot = join(root, knownChain?'engineering-v1':'v1'), nextRoot = join(root, knownChain?'engineering-v2':'v2'), workspaces = join(root, knownChain?'workspaces/engineering-v2':'workspaces-v2');
  for (const dir of [oldRoot, nextRoot, workspaces, join(nextRoot,'budget-admission')]) mkdirSync(dir, { mode: 0o700 });
  const ledgerPath = join(root,'spend.db'), aggregatePath = join(root,'aggregate.json'), ledger = new SpendLedger(ledgerPath); close.push(() => ledger.close());
  if (productionLedgerMetadata) chmodSync(ledgerPath,0o644);
  writeFileSync(aggregatePath, JSON.stringify({ schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,
    runtimeCommittedOrHeldUsd:50.302993006,runtimeUnallocatedUsd:9.697006994,totalCommittedOrHeldUsd:90.302993006,
    runtimeUnknownHoldsUsd:4.44446835,runtimeAuthorizationRetiredUsd:0,
    runtimeAllocations:[{id:'historical',amountUsd:50.302993006,state:'retained',retainedAmountUsd:50.302993006,
      retainedUnknownCostsUsd:4.44446835,retiredUnusedAuthorizationUsd:0,admission:{kind:'classifier_canary',commonfieldEarmarkMicros:3000000}}] }), { mode:0o600 });
  const originalRun=knownChain?'gary-native-engineering-20261010-01':'grant-one';
  const original: EngineeringBudgetBinding = { aggregatePath,ledgerPath,auditDir:join(oldRoot,'budget-admission'),runId:originalRun,grantId:originalRun,
    campaignId:'original-campaign',allocationId:'original-allocation',sourceRevision:'a'.repeat(40),runtimeConfigSha256:'b'.repeat(64),authoritySha256:'c'.repeat(64) };
  admitEngineeringAcceptance({...original, expectedAggregateSha256:hash(readFileSync(aggregatePath)),apply:true});
  const spend = new Database(ledgerPath); close.push(() => spend.close());
  const attemptIds: number[] = [];
  for (const charged of [36388,37438,40950]) {
    const id = Number(spend.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'deepseek','deepseek-v4-pro',8192,1416561,?,'settled')").run(original.allocationId,charged).lastInsertRowid);
    attemptIds.push(id); spend.query("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(?,'accepted','{}')").run(id);
  }
  const oldPath = join(oldRoot,'engineering.sqlite'), oldDb = new Database(oldPath); chmodSync(oldPath,0o600); close.push(() => oldDb.close());
  const store = new EngineeringTaskStore(oldDb), spec = { taskId:'old-task',requestId:'old-request',grantId:original.grantId,
    allocationId:original.allocationId,repository:'707-Labs/fixture',repositoryId:'1',baseCommit:'a'.repeat(40),policyHash:'sha256:'+'d'.repeat(64),deadlineMs:Date.now()+60_000,
    scope:{teamId:'team',surface:'private_dm' as const,audienceId:'user',projectId:'fixture'} };
  store.admit(spec, () => {}); const task = store.claim(spec.taskId, () => {});
  store.finish(spec.taskId, task.ownerEpoch!, 'blocked', () => ({receiptId:'old-cleanup',taskId:spec.taskId,sessionId:task.sessionId!,ownerEpoch:task.ownerEpoch!,absent:true}));
  oldDb.exec(`CREATE TABLE engineering_model_owners(allocation_id TEXT PRIMARY KEY,task_id TEXT,session_id TEXT,owner_epoch TEXT,owner_token TEXT,policy_hash TEXT,fenced INTEGER);
    CREATE TABLE engineering_model_requests(request_id TEXT PRIMARY KEY,allocation_id TEXT,turn_id TEXT,role TEXT,max_tokens INTEGER,state TEXT,request_hash TEXT,ledger_attempt INTEGER,receipt_hash TEXT,response_hash TEXT);`);
  oldDb.query('INSERT INTO engineering_model_owners VALUES(?,?,?,?,?,?,0)').run(original.allocationId,spec.taskId,task.sessionId,task.ownerEpoch,'old-owner',spec.policyHash);
  for (const id of attemptIds) {
    const receipt = spend.query('SELECT a.*,r.reason,r.details_json FROM spend_attempts a LEFT JOIN spend_receipts r ON r.attempt_id=a.id WHERE a.id=?').get(id);
    oldDb.query("INSERT INTO engineering_model_requests VALUES(?,?,?,'work',8192,'settled',?,?,?,?)").run('old-'+id,original.allocationId,'old-turn','hash',id,fingerprintJson(receipt).sha256,'f'.repeat(64));
  }
  const journalPath = join(nextRoot,'engineering.sqlite'); writeFileSync(journalPath,'',{mode:0o600});
  const secondRun=knownChain?'gary-native-engineering-20261010-02':'grant-two';
  const o: EngineeringContinuationBinding = {...original,root:nextRoot,workspacesRoot:workspaces,auditDir:join(nextRoot,'budget-admission'),runId:secondRun,grantId:secondRun,sourceRevision:'d'.repeat(40),runtimeConfigSha256:'e'.repeat(64),authoritySha256:'f'.repeat(64),
    continuation:{version:1,original,predecessorJournalPath:oldPath,predecessorTaskId:spec.taskId,receiptPath:join(nextRoot,'budget-admission','continuation.json')} };
  const logical = () => JSON.stringify(['spend_campaigns','spend_tickets','spend_attempts','spend_receipts','spend_coding_policies'].map(t=>spend.query('SELECT * FROM '+t+' ORDER BY 1').all()));
  return {root,o,ledger,spend,oldDb,journalPath,attemptIds,logical};
}
test('preview and apply retain original hold, settled rows and blocked predecessor; empty journal is accepted', () => {
  const s=fixture(), before=s.logical(), aggregate=readFileSync(s.o.aggregatePath), old=JSON.stringify(s.oldDb.query('SELECT * FROM engineering_tasks').all());
  const preview=admitEngineeringContinuation(s.o); expect(preview.canRun).toBe(false); expect(preview.remainingMicros).toBe(5_535_224); expect(existsSync(preview.claimPath)).toBe(false);
  const result=admitEngineeringContinuation({...s.o,apply:true}); expect(result.canRun).toBe(true); expect(result.receiptSha256).toBe(preview.receiptSha256);
  expect(s.logical()).toBe(before); expect(readFileSync(s.o.aggregatePath)).toEqual(aggregate); expect(JSON.stringify(s.oldDb.query('SELECT * FROM engineering_tasks').all())).toBe(old);
  const baseline=assertEngineeringContinuationBudget(s.o,{requireUnused:true}), journal=new Database(s.journalPath); close.push(()=>journal.close());
  assertEngineeringContinuationBaseline(baseline,s.spend,journal,s.o.allocationId); expect(baseline.baselineAttemptCount).toBe(3); expect(baseline.baselineChargedMicros).toBe(114776);
  expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow('already_claimed');
  expect(()=>assertEngineeringContinuationBaseline({...baseline},s.spend,journal,s.o.allocationId)).toThrow('untrusted_baseline');
});
test('claim remains consumed after partial failure; no replay and no duplicate hold or refund', () => {
  const s=fixture(), before=s.logical(), aggregate=readFileSync(s.o.aggregatePath);
  expect(()=>admitEngineeringContinuation({...s.o,apply:true,onClaimed:()=>{throw new Error('injected');}})).toThrow('injected');
  expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow('already_claimed');
  expect(()=>assertEngineeringContinuationBudget(s.o)).toThrow(); expect(s.logical()).toBe(before);expect(readFileSync(s.o.aggregatePath)).toEqual(aggregate);
});
for (const target of ['attempt','receipt','predecessor','cleanup','new-journal','old-journal','claim','receipt-file','config','authority','source'] as const)
  test('fresh and existing readiness reject changed '+target,()=>{
    const s=fixture();admitEngineeringContinuation({...s.o,apply:true});const baseline=assertEngineeringContinuationBudget(s.o);
    if(target==='attempt')s.spend.exec('UPDATE spend_attempts SET charged_micros=charged_micros+1 WHERE id=1');
    else if(target==='receipt')s.spend.exec("UPDATE spend_receipts SET details_json='changed' WHERE attempt_id=1");
    else if(target==='predecessor')s.oldDb.exec("UPDATE engineering_tasks SET state='paused'");
    else if(target==='cleanup')s.oldDb.exec('DELETE FROM engineering_cleanup_proofs');
    else if(target==='new-journal'||target==='old-journal'){const p=target==='new-journal'?s.journalPath:s.o.continuation.predecessorJournalPath;copyFileSync(p,p+'.new');chmodSync(p+'.new',0o600);renameSync(p+'.new',p);}
    else if(target==='claim')writeFileSync(join(s.o.continuation.original.auditDir,s.o.continuation.original.runId+'.continuation-claim.json'),'{}');
    else if(target==='receipt-file')writeFileSync(s.o.continuation.receiptPath,readFileSync(s.o.continuation.receiptPath,'utf8')+' ');
    else if(target==='config')s.o.runtimeConfigSha256='1'.repeat(64);
    else if(target==='authority')s.o.authoritySha256='1'.repeat(64);
    else s.o.sourceRevision='1'.repeat(40);
    expect(()=>assertEngineeringContinuationBudget(s.o)).toThrow();
    if(!['config','authority','source'].includes(target))expect(()=>baseline.assertCurrent()).toThrow();
  });
test('unknown prefix, extra attempts, occupied journal and changed allocation never authorize continuation',()=>{
  for(const target of ['unknown','extra','journal','allocation']){
    const s=fixture();if(target==='unknown')s.spend.exec("UPDATE spend_attempts SET state='unknown' WHERE id=1");
    else if(target==='extra')s.spend.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'deepseek','deepseek-v4-pro',8192,1416561,0,'settled')").run(s.o.allocationId);
    else if(target==='journal'){const db=new Database(s.journalPath);db.exec('CREATE TABLE used(id INTEGER);INSERT INTO used VALUES(1)');db.close();}
    else s.o.allocationId='new-allocation';
    expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow();
  }
});
function model(s:ReturnType<typeof fixture>, fetch?: (r:Request)=>Promise<Response>) {
  admitEngineeringContinuation({...s.o,apply:true});const baseline=assertEngineeringContinuationBudget(s.o);
  const journal=new Database(s.journalPath);close.push(()=>journal.close());
  const binding={taskId:'new-task',sessionId:'new-session',ownerEpoch:'new-owner',deadlineMs:Date.now()+60_000};
  const authority={authenticated:true as const,requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',surface:'private_dm' as const,channelId:'D123456789',threadTs:'1234567890.000001'};
  const repository=resolveEngineeringRepository('fixture',authority,[{repositoryId:1,installationId:2,fullName:'707-Labs/fixture',appAccessible:true,contents:'write',pullRequests:'write',archived:false,disabled:false,sharedChannelIds:[]}]);
  const policy=createEngineeringTaskPolicy({taskId:binding.taskId,repository,baseCommit:'a'.repeat(40),allowedFiles:['file.ts'],requiredCommands:['bun test'],publication:'patch_only'});
  const protocol=new EngineeringProtocol({binding,transportCapability:'x'.repeat(48),allowedTools:['terminal'],assertOwner:()=>{},append:()=>{},fence:()=>{},execute:async()=>({}),close:async()=>({cleanupConfirmed:true})});
  let calls=0;
  const options={binding,policy,allocationId:s.o.allocationId,ledger:s.ledger,journalDb:journal,spendDb:s.spend,continuationBaseline:baseline,protocol,tools:[],systemPrompt:'Host.',providerApiKey:'synthetic',assertOwner:()=>{},fence:()=>{},fetch:async(r:Request)=>{calls++;return fetch?fetch(r):Response.json({id:'synthetic',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'text',text:'done'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}});}};
  const adapter=createEngineeringModelAdapter(options);
  const body=()=>({model:'deepseek-v4-pro',messages:[{role:'system',content:'Host.'},...adapter.history()],tools:[],max_tokens:8192,stream:false,temperature:0.3});
  return {adapter,body,journal,options,calls:()=>calls};
}
test('three new work requests and review share the original cap and preserve exact settled prefix without replay',async()=>{
  const s=fixture(), prefix=s.spend.query('SELECT * FROM spend_attempts').all(), m=model(s), signal=new AbortController().signal;
  for(let i=0;i<3;i++){m.adapter.beginTurn({turnId:'new-turn-'+i,prompt:'Work.'});expect((await m.adapter.handle(m.body(),signal)).status).toBe(200);m.adapter.finishTurn(m.adapter.history());}
  expect((await m.adapter.review({prompt:'Review.',systemPrompt:'Independent.',signal})).status).toBe(200);
  expect(m.calls()).toBe(4);expect(s.ledger.status(s.o.allocationId)!.attemptCount).toBe(7);expect(s.ledger.status(s.o.allocationId)!.chargedMicros).toBeLessThan(5_650_000);
  expect(s.spend.query('SELECT * FROM spend_attempts ORDER BY id LIMIT 3').all()).toEqual(prefix);
  expect(()=>createEngineeringModelAdapter(m.options)).toThrow();expect(()=>assertEngineeringContinuationBudget(s.o,{requireUnused:true})).toThrow('already_used');
  assertEngineeringContinuationBudget(s.o).assertCurrent();
  await expect(m.adapter.review({prompt:'Replay.',systemPrompt:'Independent.',signal})).rejects.toThrow();expect(m.calls()).toBe(4);
});
test('prefix mutation and foreign new attempts deny before a new physical request',async()=>{
  for(const change of ['prefix','foreign']){
    const s=fixture(), m=model(s);m.adapter.beginTurn({turnId:'turn',prompt:'Work.'});
    if(change==='prefix')s.spend.exec("UPDATE spend_receipts SET details_json='altered' WHERE attempt_id=1");
    else s.spend.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'deepseek','deepseek-v4-pro',8192,1416561,0,'settled')").run(s.o.allocationId);
    await expect(m.adapter.handle(m.body(),new AbortController().signal)).rejects.toThrow();expect(m.calls()).toBe(0);
  }
});

test('prospective preparation validates settled predecessor without creating any v2 paths',()=>{
  const s=fixture();rmSync(s.o.root,{recursive:true});rmSync(s.o.workspacesRoot,{recursive:true});
  const before=s.logical(), aggregate=readFileSync(s.o.aggregatePath), result=previewEngineeringContinuation(s.o);
  expect(result.canRun).toBe(false);expect(result.remainingMicros).toBe(5_535_224);
  expect(existsSync(s.o.root)).toBe(false);expect(existsSync(s.o.workspacesRoot)).toBe(false);
  expect(s.logical()).toBe(before);expect(readFileSync(s.o.aggregatePath)).toEqual(aggregate);
  expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow();
});
test('pre-admission ledger edits cannot be blessed by a new sidecar even with unchanged totals',()=>{
  for(const change of ['receipt','redistributed-charge','model-receipt']) {
    const s=fixture();
    if(change==='receipt')s.spend.exec("UPDATE spend_receipts SET details_json='altered' WHERE attempt_id=1");
    else if(change==='redistributed-charge')s.spend.exec('UPDATE spend_attempts SET charged_micros=charged_micros+1 WHERE id=1; UPDATE spend_attempts SET charged_micros=charged_micros-1 WHERE id=2');
    else s.oldDb.exec("UPDATE engineering_model_requests SET receipt_hash='invalid' WHERE ledger_attempt=1");
    expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow('predecessor_model_requests');
  }
});
test('cumulative remaining budget protects review after expensive new settlements',async()=>{
  const s=fixture(), m=model(s,async()=>Response.json({id:'synthetic',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'text',text:'done'}],stop_reason:'end_turn',usage:{input_tokens:1_048_576,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}}));
  for(let i=0;i<2;i++){m.adapter.beginTurn({turnId:'expensive-'+i,prompt:'Work.'});await m.adapter.handle(m.body(),new AbortController().signal);m.adapter.finishTurn(m.adapter.history());}
  m.adapter.beginTurn({turnId:'third',prompt:'More work.'});
  await expect(m.adapter.handle(m.body(),new AbortController().signal)).rejects.toThrow();
  expect(m.calls()).toBe(2);expect(s.ledger.status(s.o.allocationId)).toMatchObject({attemptCount:5,chargedMicros:2_947_898,remainingMicros:2_702_102,unknownAttempts:0,state:'active'});
  expect(s.ledger.status(s.o.allocationId)!.remainingMicros).toBeGreaterThan(1_400_317);
});
for(const phase of ['before_request','before_send'] as const)test('new receipt edit during '+phase+' is denied before physical dispatch',async()=>{
  const s=fixture(),m=model(s);m.adapter.beginTurn({turnId:'first',prompt:'Work.'});await m.adapter.handle(m.body(),new AbortController().signal);m.adapter.finishTurn(m.adapter.history());
  m.adapter.beginTurn({turnId:'second',prompt:'More work.'});
  await expect(s.ledger.withPaidRequestGuard(p=>{if(p===phase)s.spend.exec("UPDATE spend_receipts SET details_json='altered' WHERE attempt_id=4");},()=>m.adapter.handle(m.body(),new AbortController().signal))).rejects.toThrow();
  expect(m.calls()).toBe(1);expect(s.ledger.status(s.o.allocationId)!.attemptCount).toBe(phase==='before_request'?4:5);
  expect(s.ledger.status(s.o.allocationId)!.unknownAttempts).toBe(phase==='before_request'?0:1);
});
test('baseline cannot authorize another allocation or another canonical writer',()=>{
  const s=fixture(),m=model(s);
  expect(()=>assertEngineeringContinuationBaseline(m.options.continuationBaseline,s.spend,m.journal,'another-allocation')).toThrow('untrusted_baseline');
  const other=new SpendLedger(join(s.root,'other-ledger.sqlite'));close.push(()=>other.close());
  other.createCampaign('other',5.65);other.enrollTicket('other',s.o.allocationId,5.65,{draftPr:false});
  expect(()=>createEngineeringModelAdapter({...m.options,ledger:other})).toThrow('configuration');expect(other.status(s.o.allocationId)!.attemptCount).toBe(0);
});

test('owned 0755 ledger parent and 0644 canonical ledger permit continuation while private roots remain 0700',()=>{
  const s=fixture(true), before=s.logical(), aggregate=readFileSync(s.o.aggregatePath);
  expect(lstatSync(s.root).mode & 0o777).toBe(0o755);expect(lstatSync(s.o.ledgerPath).mode & 0o777).toBe(0o644);
  expect(previewEngineeringContinuation(s.o).canRun).toBe(false);
  expect(admitEngineeringContinuation({...s.o,apply:true}).canRun).toBe(true);
  const baseline=assertEngineeringContinuationBudget(s.o,{requireUnused:true});baseline.assertCurrent();
  const journal=new Database(s.journalPath);close.push(()=>journal.close());assertEngineeringContinuationBaseline(baseline,s.spend,journal,s.o.allocationId);
  expect(s.logical()).toBe(before);expect(readFileSync(s.o.aggregatePath)).toEqual(aggregate);
  for(const dir of [s.o.root,s.o.auditDir,s.o.continuation.original.auditDir,s.o.workspacesRoot])expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  expect(lstatSync(s.root).mode & 0o777).toBe(0o755);expect(lstatSync(s.o.ledgerPath).mode & 0o777).toBe(0o644);
});
test('group/world writable ledger parents and nonprivate journal or receipt directories remain denied',()=>{
  for(const mode of [0o775,0o777]){
    const s=fixture(true);chmodSync(s.root,mode);
    expect(()=>previewEngineeringContinuation(s.o)).toThrow();expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow();
  }
  for(const dir of ['old-journal','new-root','old-audit','new-audit']){
    const s=fixture(true);admitEngineeringContinuation({...s.o,apply:true});const baseline=assertEngineeringContinuationBudget(s.o);
    const path=dir==='old-journal'?join(s.root,'v1'):dir==='new-root'?s.o.root:dir==='old-audit'?s.o.continuation.original.auditDir:s.o.auditDir;
    chmodSync(path,0o755);
    expect(()=>baseline.assertCurrent()).toThrow();expect(()=>assertEngineeringContinuationBudget(s.o)).toThrow();
  }
});

function rebootFixture() {
  const s=fixture(true),original=s.o.continuation.original,intentPath=join(original.auditDir,original.runId+'.intent.json');
  // Offline history fixture: simulate a prior boot's device number before
  // recording evidence; production never edits that original intent.
  const intent=JSON.parse(readFileSync(intentPath,'utf8'));intent.ledgerMetadata.dev--;
  writeFileSync(intentPath,JSON.stringify(intent,null,2)+'\n');
  const stat=lstatSync(original.ledgerPath),currentMetadata={dev:stat.dev,ino:stat.ino,uid:stat.uid,gid:stat.gid,mode:stat.mode};
  const value={version:1,kind:'engineering_ledger_reboot_attestation',ledgerPath:original.ledgerPath,originalIntentPath:intentPath,
    originalIntentSha256:hash(readFileSync(intentPath)),campaignId:original.campaignId,allocationId:original.allocationId,capMicros:5_650_000,
    originalMetadata:intent.ledgerMetadata,currentMetadata,...observeEngineeringLedgerBootIdentity(stat.dev),
    rebootObservationSha256:'b'.repeat(64),userMessageId:'Sentinel_f2a39cc8fb608191b26f1f7fd9769ab6'};
  const path=join(original.auditDir,original.runId+'.ledger-reboot.json'),bytes=JSON.stringify(value,null,2)+'\n';
  writeFileSync(path,bytes,{mode:0o600});s.o.continuation.ledgerRebootAttestation={path,sha256:hash(bytes)};
  return {...s,intentPath,value,attestationPath:path};
}
const macTest=process.platform==='darwin'?test:test.skip;
macTest('reboot continuation retains all original bytes, cap, hold, settled prefix and future usage accounting',async()=>{
  const s=rebootFixture(),intent=readFileSync(s.intentPath),aggregate=readFileSync(s.o.aggregatePath),before=s.logical();
  expect(()=>assertEngineeringBudgetAdmission(s.o.continuation.original)).toThrow('recovery_ledger_identity_changed');
  expect(()=>admitEngineeringAcceptance({...s.o.continuation.original,expectedAggregateSha256:hash(aggregate),resumePartial:true})).toThrow('recovery_ledger_identity_changed');
  expect(previewEngineeringContinuation(s.o).remainingMicros).toBe(5_535_224);
  const m=model(s);expect(s.logical()).toBe(before);
  m.adapter.beginTurn({turnId:'after-reboot',prompt:'Work.'});
  expect((await m.adapter.handle(m.body(),new AbortController().signal)).status).toBe(200);
  m.adapter.finishTurn(m.adapter.history());assertEngineeringContinuationBudget(s.o).assertCurrent();
  expect(s.ledger.status(s.o.allocationId)!.capMicros).toBe(5_650_000);expect(s.ledger.status(s.o.allocationId)!.attemptCount).toBe(4);
  expect(readFileSync(s.intentPath)).toEqual(intent);expect(readFileSync(s.o.aggregatePath)).toEqual(aggregate);
});
macTest('reboot references fail closed for wrong hash, path, metadata, boot, volume and unsafe or changed files',()=>{
  for(const change of ['hash','path','inode','boot','volume','mode','duplicate-key','changed-after-admission']) {
    const s=rebootFixture(),ref=s.o.continuation.ledgerRebootAttestation!;
    if(change==='changed-after-admission') {
      admitEngineeringContinuation({...s.o,apply:true});const baseline=assertEngineeringContinuationBudget(s.o);
      writeFileSync(s.attestationPath,readFileSync(s.attestationPath,'utf8')+' ');
      expect(()=>baseline.assertCurrent()).toThrow();expect(()=>assertEngineeringContinuationBudget(s.o)).toThrow();continue;
    }
    if(change==='hash')ref.sha256='a'.repeat(64);
    else if(change==='path')ref.path+='.other';
    else if(change==='mode')chmodSync(ref.path,0o644);
    else {
      if(change==='inode')s.value.currentMetadata.ino++;
      else if(change==='boot')s.value.bootSessionUUID='12D97A38-83D2-457D-967F-A01481D5EEFC';
      else if(change==='volume')s.value.apfsVolumeUUID='8CD7DC2C-1F22-4B7C-BB7A-525D8FF5B697';
      let bytes=JSON.stringify(s.value);if(change==='duplicate-key')bytes=bytes.slice(0,-1)+',"version":1}';
      writeFileSync(ref.path,bytes);ref.sha256=hash(bytes);
    }
    expect(()=>previewEngineeringContinuation(s.o)).toThrow();expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow();
  }
});

function afterBlockedFixture() {
  const s=fixture(false,true),second=structuredClone(s.o);
  const secondBase='09e0a6f361a7f6b79e18d7b782fcb8723d6f613b';
  const config={grantId:second.grantId,allocationId:second.allocationId,campaignId:second.campaignId,sourceRevision:second.sourceRevision,
    root:second.root,workspacesRoot:second.workspacesRoot,repository:'707-Labs/fixture',baseCommit:secondBase};
  const configBytes=JSON.stringify(config);writeFileSync(join(second.root,'config.json'),configBytes,{mode:0o600});second.runtimeConfigSha256=hash(configBytes);
  const admission=admitEngineeringContinuation({...second,apply:true});
  const secondDb=new Database(s.journalPath);close.push(()=>secondDb.close());
  const taskId='engineering-438c8176-7f19-495d-9a8b-4056a141e1c8';
  const previous=s.oldDb.query('SELECT spec_json FROM engineering_tasks').get() as {spec_json:string};
  const spec={...JSON.parse(previous.spec_json),taskId,requestId:'second-request',grantId:second.grantId,baseCommit:secondBase,deadlineMs:Date.now()+60_000};
  const tasks=new EngineeringTaskStore(secondDb);tasks.admit(spec,()=>{});const task=tasks.claim(taskId,()=>{});
  tasks.finish(taskId,task.ownerEpoch!,'blocked',()=>({receiptId:'second-cleanup',taskId,sessionId:task.sessionId!,ownerEpoch:task.ownerEpoch!,absent:true}));
  secondDb.exec(`CREATE TABLE engineering_runtime_runs(task_id TEXT PRIMARY KEY,policy_hash TEXT NOT NULL,launch_state TEXT NOT NULL);
    CREATE TABLE engineering_runtime_leases(task_id TEXT PRIMARY KEY,session_id TEXT,owner_epoch TEXT,reference_json TEXT,reference_hash TEXT);
    CREATE TABLE engineering_ingress_requests(request_id TEXT PRIMARY KEY,task_id TEXT,allocation_id TEXT,stage TEXT,final_json TEXT);`);
  secondDb.query('INSERT INTO engineering_runtime_runs VALUES(?,?,?)').run(taskId,spec.policyHash,'closed');
  secondDb.query('INSERT INTO engineering_ingress_requests VALUES(?,?,?,?,?)').run(spec.requestId,taskId,s.o.allocationId,'blocked',
    JSON.stringify({requestId:spec.requestId,taskId,phase:'final',status:'blocked',receiptId:'final-receipt'}));
  const root=join(s.root,'engineering-v3'),workspacesRoot=join(s.root,'workspaces','engineering-v3'),auditDir=join(root,'budget-admission');
  for(const path of [root,workspacesRoot,auditDir])mkdirSync(path,{mode:0o700});
  const journalPath=join(root,'engineering.sqlite');writeFileSync(journalPath,'',{mode:0o600});
  const o:EngineeringContinuationBinding={...second,root,workspacesRoot,auditDir,runId:'gary-native-engineering-20261010-03',grantId:'gary-native-engineering-20261010-03',
    sourceRevision:'1'.repeat(40),runtimeConfigSha256:'2'.repeat(64),authoritySha256:'3'.repeat(64),continuation:{...second.continuation,
      receiptPath:join(auditDir,'continuation.json'),afterBlockedContinuation:{receiptPath:second.continuation.receiptPath,
        receiptSha256:admission.receiptSha256,claimSha256:hash(readFileSync(admission.claimPath)),taskId}}};
  return {...s,o,journalPath,second,secondDb,secondClaim:admission.claimPath,secondSpec:spec};
}

test('explicit 03 continuation preserves both closed predecessors and only adds a new claim under 02',()=>{
  const s=afterBlockedFixture(),before=s.logical(),aggregate=readFileSync(s.o.aggregatePath),claim=readFileSync(s.secondClaim),receipt=readFileSync(s.second.continuation.receiptPath);
  const preview=previewEngineeringContinuation(s.o);expect(preview.remainingMicros).toBe(5_535_224);expect(preview.blockedContinuationSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.claimPath).toBe(join(s.second.auditDir,s.second.runId+'.continuation-claim.json'));
  expect(s.secondSpec.baseCommit).toBe('09e0a6f361a7f6b79e18d7b782fcb8723d6f613b');
  expect(JSON.parse((s.oldDb.query('SELECT spec_json FROM engineering_tasks').get() as {spec_json:string}).spec_json).baseCommit).not.toBe(s.secondSpec.baseCommit);
  expect(admitEngineeringContinuation({...s.o,apply:true}).canRun).toBe(true);assertEngineeringContinuationBudget(s.o,{requireUnused:true}).assertCurrent();
  expect(readFileSync(s.secondClaim)).toEqual(claim);expect(readFileSync(s.second.continuation.receiptPath)).toEqual(receipt);
  expect(readFileSync(s.o.aggregatePath)).toEqual(aggregate);expect(s.logical()).toBe(before);
  expect(s.secondDb.query('SELECT state,cleanup_confirmed FROM engineering_tasks').get()).toEqual({state:'blocked',cleanup_confirmed:1});
  expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow('already_claimed');
});

test('03 partial new claim is consumed without changing 01/02 receipts or retrying',()=>{
  const s=afterBlockedFixture(),old=readFileSync(s.secondClaim),receipt=readFileSync(s.second.continuation.receiptPath),before=s.logical();
  expect(()=>admitEngineeringContinuation({...s.o,apply:true,onClaimed:()=>{throw new Error('injected');}})).toThrow('injected');
  expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow('already_claimed');expect(()=>assertEngineeringContinuationBudget(s.o)).toThrow();
  expect(readFileSync(s.secondClaim)).toEqual(old);expect(readFileSync(s.second.continuation.receiptPath)).toEqual(receipt);expect(s.logical()).toBe(before);
});

for(const change of ['receipt','claim','config','journal-replaced','task-state','cleanup','model-table','lease','runtime','ingress','scope','base','extra-task','history'] as const)
  test('03 readiness and existing guard reject changed second '+change,()=>{
    const s=afterBlockedFixture();admitEngineeringContinuation({...s.o,apply:true});const baseline=assertEngineeringContinuationBudget(s.o);
    if(change==='receipt')writeFileSync(s.second.continuation.receiptPath,readFileSync(s.second.continuation.receiptPath,'utf8')+' ');
    else if(change==='claim')writeFileSync(s.secondClaim,readFileSync(s.secondClaim,'utf8')+' ');
    else if(change==='config')writeFileSync(join(s.second.root,'config.json'),readFileSync(join(s.second.root,'config.json'),'utf8')+' ');
    else if(change==='journal-replaced'){const p=join(s.second.root,'engineering.sqlite');copyFileSync(p,p+'.new');chmodSync(p+'.new',0o600);renameSync(p+'.new',p);}
    else if(change==='task-state')s.secondDb.exec("UPDATE engineering_tasks SET state='cleanup_unknown',cleanup_confirmed=0");
    else if(change==='cleanup')s.secondDb.exec('DELETE FROM engineering_cleanup_proofs');
    else if(change==='model-table')s.secondDb.exec('CREATE TABLE engineering_model_requests(request_id TEXT)');
    else if(change==='lease')s.secondDb.exec("INSERT INTO engineering_runtime_leases VALUES('task','session','owner','{}','hash')");
    else if(change==='runtime')s.secondDb.exec("UPDATE engineering_runtime_runs SET launch_state='running'");
    else if(change==='ingress')s.secondDb.exec("UPDATE engineering_ingress_requests SET stage='preparing'");
    else if(change==='scope'||change==='base'){
      const spec={...s.secondSpec,baseCommit:change==='base'?'b'.repeat(40):s.secondSpec.baseCommit,
        scope:{...s.secondSpec.scope,audienceId:change==='scope'?'another-user':s.secondSpec.scope.audienceId}};
      s.secondDb.query('UPDATE engineering_tasks SET spec_json=?,spec_hash=?,scope_key=?').run(JSON.stringify(spec),fingerprintJson(spec).sha256,
        fingerprintJson([spec.scope.teamId,spec.scope.surface,spec.scope.audienceId,spec.scope.projectId]).sha256);
    } else if(change==='extra-task')s.secondDb.exec("INSERT INTO engineering_tasks SELECT 'other','other-request',spec_json,spec_hash,scope_key,state,owner_epoch,session_id,cleanup_confirmed,updated_ms FROM engineering_tasks");
    else s.secondDb.exec("UPDATE engineering_task_receipts SET evidence_hash='changed'");
    expect(()=>baseline.assertCurrent()).toThrow();expect(()=>assertEngineeringContinuationBudget(s.o)).toThrow();
  });

test('03 admission rejects paid/unresolved second attempts and pre-admission nonzero-model or unknown cleanup',()=>{
  for(const change of ['new-settled','new-unknown','model-table','cleanup-unknown','bad-cleanup']){
    const s=afterBlockedFixture();
    if(change.startsWith('new-'))s.spend.query('INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,?,?,?,?,?,?)')
      .run(s.o.allocationId,'deepseek','deepseek-v4-pro',8192,1416561,0,change==='new-settled'?'settled':'unknown');
    else if(change==='model-table')s.secondDb.exec('CREATE TABLE engineering_model_owners(allocation_id TEXT)');
    else if(change==='cleanup-unknown')s.secondDb.exec("UPDATE engineering_tasks SET state='cleanup_unknown',cleanup_confirmed=0");
    else s.secondDb.exec("UPDATE engineering_cleanup_proofs SET session_id='other'");
    expect(()=>previewEngineeringContinuation(s.o)).toThrow();expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow();
  }
});

test('03 rejects wrong chain, recursive rollover, changed receipt pins and overlapping roots',()=>{
  for(const change of ['no-chain','grant-four','other-task','receipt-path','claim-hash','old-original','recursive','overlap','reboot-reference']){
    const s=afterBlockedFixture(),after=s.o.continuation.afterBlockedContinuation!;
    if(change==='no-chain')delete s.o.continuation.afterBlockedContinuation;
    else if(change==='grant-four')s.o.runId=s.o.grantId='gary-native-engineering-20261010-04';
    else if(change==='other-task')after.taskId='another-task';
    else if(change==='receipt-path')after.receiptPath=s.o.continuation.receiptPath;
    else if(change==='claim-hash')after.claimSha256='a'.repeat(64);
    else if(change==='overlap')s.o.workspacesRoot=s.second.workspacesRoot;
    else if(change==='reboot-reference')s.o.continuation.ledgerRebootAttestation={path:'/wrong',sha256:'a'.repeat(64)};
    else {
      const receipt=JSON.parse(readFileSync(after.receiptPath,'utf8'));
      if(change==='old-original')receipt.binding.continuation.original.authoritySha256='a'.repeat(64);
      else receipt.binding.continuation.afterBlockedContinuation={...after};
      const bytes=JSON.stringify(receipt);writeFileSync(after.receiptPath,bytes);after.receiptSha256=hash(bytes);
    }
    expect(()=>previewEngineeringContinuation(s.o)).toThrow();expect(()=>admitEngineeringContinuation({...s.o,apply:true})).toThrow();
  }
});

test('03 future work and review remain inside original cap and permit new settled rows without weakening predecessor guards',async()=>{
  const s=afterBlockedFixture(),prefix=s.spend.query('SELECT * FROM spend_attempts').all(),m=model(s),signal=new AbortController().signal;
  for(let i=0;i<3;i++){
    m.adapter.beginTurn({turnId:'third-attempt-'+i,prompt:'Work.'});expect((await m.adapter.handle(m.body(),signal)).status).toBe(200);m.adapter.finishTurn(m.adapter.history());
    assertEngineeringContinuationBudget(s.o).assertCurrent();
  }
  expect((await m.adapter.review({prompt:'Independent review.',systemPrompt:'Independent.',signal})).status).toBe(200);
  expect(m.calls()).toBe(4);expect(s.ledger.status(s.o.allocationId)!.attemptCount).toBe(7);
  expect(s.ledger.status(s.o.allocationId)!.capMicros).toBe(5_650_000);expect(s.ledger.status(s.o.allocationId)!.chargedMicros).toBeLessThan(5_650_000);
  expect(s.spend.query('SELECT * FROM spend_attempts ORDER BY id LIMIT 3').all()).toEqual(prefix);
  expect(()=>assertEngineeringContinuationBudget(s.o,{requireUnused:true})).toThrow('already_used');
  await expect(m.adapter.review({prompt:'Replay.',systemPrompt:'Independent.',signal})).rejects.toThrow();expect(m.calls()).toBe(4);
  s.secondDb.exec("UPDATE engineering_task_receipts SET evidence_hash='changed'");expect(()=>assertEngineeringContinuationBudget(s.o)).toThrow();
});
