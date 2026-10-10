/** Disposable synthetic v1→v2→v3→v4 chain. No live paths, activation or provider calls. */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { SpendLedger } from '../../../src/spend.ts';
import { admitEngineeringAcceptance, type EngineeringBudgetBinding } from '../../../src/hermes/engineering-budget.ts';
import { engineeringContinuationJournalPreservationSha256, admitEngineeringContinuation, type EngineeringContinuationBinding } from '../../../src/hermes/engineering-continuation-budget.ts';
import { EngineeringTaskStore } from '../../../src/hermes/engineering-task-store.ts';
import { fingerprintJson } from '../../../src/hermes/audit-trace.ts';
import { engineeringAcceptancePolicySha256 } from '../../../src/hermes/engineering-policy.ts';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export function createEngineeringContinuation04Fixture(options: {parentDirectory?: string} = {}) {
  const parent=options.parentDirectory;
  if(parent!==undefined){
    const st=lstatSync(parent);
    if(!isAbsolute(parent)||resolve(parent)!==parent||realpathSync(parent)!==parent||!st.isDirectory()||st.isSymbolicLink()
        ||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700)throw Error('continuation04_fixture_parent');
  }
  const roots: string[] = [], close: (()=>void)[] = [];
function fixture(productionLedgerMetadata = false, knownChain = false, historicalAttemptIds = false) {
  const root = mkdtempSync(join(parent??realpathSync(tmpdir()), 'engineering-continuation-')); roots.push(root); chmodSync(root, productionLedgerMetadata ? 0o755 : 0o700);
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
    const id = Number(spend.query("INSERT INTO spend_attempts(id,ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,?,'deepseek','deepseek-v4-pro',8192,1416561,?,'settled')").run(historicalAttemptIds?147+attemptIds.length:null,original.allocationId,charged).lastInsertRowid);
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
function afterBlockedFixture(historicalAttemptIds = false) {
  const s=fixture(false,true,historicalAttemptIds),second=structuredClone(s.o);
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
function afterSettledFixture() {
  const s=afterBlockedFixture(true),third=structuredClone(s.o);
  const decision={kind:'trusted_delegated_continuation_03_decision',sourceThreadId:'synthetic-parent',continuationGrantId:third.grantId,
    originalGrantId:third.continuation.original.grantId,consumedContinuationGrantId:s.second.grantId,campaignId:third.campaignId,
    allocationId:third.allocationId,cumulativeCapMicros:5_650_000,priorSettledSpendMicros:114776,newAggregateHold:false,
    preserveUnknownHolds:true,replayConsumedPhases:false,publication:'patch_only',originalApprovalSha256:third.continuation.original.authoritySha256};
  const decisionBytes=JSON.stringify(decision),decisionPath=join(third.root,'continuation-authority.json');writeFileSync(decisionPath,decisionBytes,{mode:0o600});
  const authority={grantId:third.grantId,sourceThreadId:decision.sourceThreadId,capMicros:5_650_000,mergeAllowed:false,deploymentAllowed:false,
    continuationDecision:{path:decisionPath,sha256:hash(decisionBytes)}};
  const authorityBytes=JSON.stringify(authority);writeFileSync(join(third.root,'authority.json'),authorityBytes,{mode:0o600});third.authoritySha256=hash(authorityBytes);
  const config={grantId:third.grantId,allocationId:third.allocationId,campaignId:third.campaignId,sourceRevision:third.sourceRevision,
    root:third.root,workspacesRoot:third.workspacesRoot,repository:s.secondSpec.repository,baseCommit:s.secondSpec.baseCommit,
    publication:'patch_only',capMicros:5_650_000,budget:{continuation:third.continuation}};
  const configBytes=JSON.stringify(config);writeFileSync(join(third.root,'config.json'),configBytes,{mode:0o600});third.runtimeConfigSha256=hash(configBytes);
  const admission=admitEngineeringContinuation({...third,apply:true}),thirdDb=new Database(s.journalPath);close.push(()=>thirdDb.close());
  const taskId='engineering-eebc7874-e224-45f8-8e8b-9c01aed15ef9',spec={...s.secondSpec,taskId,requestId:'third-request',grantId:third.grantId};
  const tasks=new EngineeringTaskStore(thirdDb);tasks.admit(spec,()=>{});const task=tasks.claim(taskId,()=>{});
  tasks.finish(taskId,task.ownerEpoch!,'blocked',()=>({receiptId:'third-cleanup',taskId,sessionId:task.sessionId!,ownerEpoch:task.ownerEpoch!,absent:true}));
  thirdDb.exec(`CREATE TABLE engineering_runtime_runs(task_id TEXT PRIMARY KEY,policy_hash TEXT NOT NULL,launch_state TEXT NOT NULL);
    CREATE TABLE engineering_runtime_leases(task_id TEXT PRIMARY KEY,session_id TEXT,owner_epoch TEXT,reference_json TEXT,reference_hash TEXT);
    CREATE TABLE engineering_ingress_requests(request_id TEXT PRIMARY KEY,task_id TEXT,allocation_id TEXT,stage TEXT,final_json TEXT);
    CREATE TABLE engineering_model_owners(allocation_id TEXT PRIMARY KEY,task_id TEXT,session_id TEXT,owner_epoch TEXT,owner_token TEXT,policy_hash TEXT,fenced INTEGER);
    CREATE TABLE engineering_model_requests(request_id TEXT PRIMARY KEY,allocation_id TEXT,turn_id TEXT,role TEXT,max_tokens INTEGER,state TEXT,request_hash TEXT,ledger_attempt INTEGER,receipt_hash TEXT,response_hash TEXT);
    CREATE TABLE engineering_model_baselines(allocation_id TEXT PRIMARY KEY,receipt_hash TEXT,attempt_count INTEGER,charged_micros INTEGER);`);
  thirdDb.query('INSERT INTO engineering_runtime_runs VALUES(?,?,?)').run(taskId,spec.policyHash,'closed');
  const ref={binding:{taskId,sessionId:task.sessionId,ownerEpoch:task.ownerEpoch},pid:1234,birthToken:'historical'};
  thirdDb.query('INSERT INTO engineering_runtime_leases VALUES(?,?,?,?,?)').run(taskId,task.sessionId,task.ownerEpoch,JSON.stringify(ref),fingerprintJson(ref).sha256);
  thirdDb.query('INSERT INTO engineering_ingress_requests VALUES(?,?,?,?,?)').run(spec.requestId,taskId,third.allocationId,'blocked',JSON.stringify({requestId:spec.requestId,taskId,phase:'final',status:'blocked'}));
  thirdDb.query('INSERT INTO engineering_model_owners VALUES(?,?,?,?,?,?,0)').run(third.allocationId,taskId,task.sessionId,task.ownerEpoch,'third-owner',spec.policyHash);
  thirdDb.query('INSERT INTO engineering_model_baselines VALUES(?,?,?,?)').run(third.allocationId,admission.receiptSha256,3,114776);
  for(const [i,charge] of [36601,38937,41698].entries()) {
    const id=150+i;s.spend.query("INSERT INTO spend_attempts(id,ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,?,'deepseek','deepseek-v4-pro',8192,1416561,?,'settled')").run(id,third.allocationId,charge);
    s.spend.query("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(?,'accepted','{}')").run(id);
    const row=s.spend.query('SELECT a.*,r.reason,r.details_json FROM spend_attempts a JOIN spend_receipts r ON r.attempt_id=a.id WHERE a.id=?').get(id);
    thirdDb.query("INSERT INTO engineering_model_requests VALUES(?,?,?,'work',8192,'settled',?,?,?,?)").run('third-'+id,third.allocationId,'third-turn','a'.repeat(64),id,fingerprintJson(row).sha256,'b'.repeat(64));
  }
  const root=join(s.root,'engineering-v4'),workspacesRoot=join(s.root,'workspaces','engineering-v4'),auditDir=join(root,'budget-admission');
  for(const path of [root,workspacesRoot,auditDir])mkdirSync(path,{mode:0o700});
  const journalPath=join(root,'engineering.sqlite');writeFileSync(journalPath,'',{mode:0o600});
  const {afterBlockedContinuation:_,...priorContinuation}=third.continuation;
  const o:EngineeringContinuationBinding={...third,root,workspacesRoot,auditDir,runId:'gary-native-engineering-20261010-04',grantId:'gary-native-engineering-20261010-04',
    sourceRevision:'4'.repeat(40),runtimeConfigSha256:'5'.repeat(64),authoritySha256:'6'.repeat(64),continuation:{...priorContinuation,version:2,
      receiptPath:join(auditDir,'continuation.json'),budgetPolicySha256:engineeringAcceptancePolicySha256(2),afterSettledContinuation:{receiptPath:third.continuation.receiptPath,
        receiptSha256:admission.receiptSha256,claimSha256:hash(readFileSync(admission.claimPath)),taskId,preservationSha256:engineeringContinuationJournalPreservationSha256(thirdDb)}}};
  return {...s,o,journalPath,third,thirdDb,thirdClaim:admission.claimPath,thirdSpec:spec,decisionPath};
}
  try {
    const result=afterSettledFixture();
    let closed=false,disposed=false;
    const closeHandles=()=>{if(closed)return;closed=true;for(const f of close.splice(0).reverse())f();};
    return {...result,close:closeHandles,dispose(){if(disposed)return;closeHandles();disposed=true;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});}};
  } catch(error) {
    for(const f of close.splice(0).reverse())f();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});throw error;
  }
}
