import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../../src/spend.ts';
import { admitEngineeringAcceptance, type EngineeringBudgetBinding } from '../../src/hermes/engineering-budget.ts';
import { admitEngineeringContinuation, previewEngineeringContinuation, assertEngineeringContinuationBudget, assertEngineeringContinuationBaseline, type EngineeringContinuationBinding } from '../../src/hermes/engineering-continuation-budget.ts';
import { EngineeringTaskStore } from '../../src/hermes/engineering-task-store.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';
import { createEngineeringModelAdapter } from '../../src/hermes/engineering-model.ts';
import { EngineeringProtocol } from '../../src/hermes/engineering-protocol.ts';
import { createEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';
const roots: string[] = [], close: (() => void)[] = [];
afterEach(() => { for (const f of close.splice(0).reverse()) f(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'engineering-continuation-')); roots.push(root); chmodSync(root, 0o700);
  const oldRoot = join(root, 'v1'), nextRoot = join(root, 'v2'), workspaces = join(root, 'workspaces-v2');
  for (const dir of [oldRoot, nextRoot, workspaces, join(nextRoot,'budget-admission')]) mkdirSync(dir, { mode: 0o700 });
  const ledgerPath = join(root,'spend.db'), aggregatePath = join(root,'aggregate.json'), ledger = new SpendLedger(ledgerPath); close.push(() => ledger.close());
  writeFileSync(aggregatePath, JSON.stringify({ schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,
    runtimeCommittedOrHeldUsd:50.302993006,runtimeUnallocatedUsd:9.697006994,totalCommittedOrHeldUsd:90.302993006,
    runtimeUnknownHoldsUsd:4.44446835,runtimeAuthorizationRetiredUsd:0,
    runtimeAllocations:[{id:'historical',amountUsd:50.302993006,state:'retained',retainedAmountUsd:50.302993006,
      retainedUnknownCostsUsd:4.44446835,retiredUnusedAuthorizationUsd:0,admission:{kind:'classifier_canary',commonfieldEarmarkMicros:3000000}}] }), { mode:0o600 });
  const original: EngineeringBudgetBinding = { aggregatePath,ledgerPath,auditDir:join(oldRoot,'budget-admission'),runId:'grant-one',grantId:'grant-one',
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
  const o: EngineeringContinuationBinding = {...original,root:nextRoot,workspacesRoot:workspaces,auditDir:join(nextRoot,'budget-admission'),runId:'grant-two',grantId:'grant-two',sourceRevision:'d'.repeat(40),runtimeConfigSha256:'e'.repeat(64),authoritySha256:'f'.repeat(64),
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
