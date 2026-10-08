import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openSpendLedger } from '../../src/spend.ts';
const RUN='hermes-readonly-20261008-5de09cee',OLD='hermes-readonly-20261008-db05d434',ALLOCATION='local:'+RUN;
const REQUEST='Sentinel_ecc85c3dae948191965308b6414c1165',READY_KEY='ready:'+REQUEST+':A0C7QFW3PEG:T0AA24R7VUZ:U0A9M5W16F8';
const roots:string[]=[];afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const script=resolve(import.meta.dir,'../../scripts/reconcile-verified-readonly-canary.py');
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'verified-retire-'));chmodSync(root,0o700);roots.push(root);
  const aggregate=join(root,'aggregate.json'),ledger=join(root,'spend.db'),state_db=join(root,'gary.db'),audit_dir=join(root,'audit'),canary_config=join(root,'config.json');
  const admissionDir=join(root,'admission');mkdirSync(admissionDir,{mode:0o700});const auditRecord=join(admissionDir,RUN+'.intent.json');
  const b={schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,runtimeCommittedOrHeldUsd:13.692298006,
    runtimeUnallocatedUsd:46.307701994,totalCommittedOrHeldUsd:53.692298006,runtimeUnknownHoldsUsd:4.44446835,runtimeAuthorizationRetiredUsd:51.307701994,
    hermesPaidCalls:1,history:{allPriorNotes:'preserve'},runtimeAllocations:[
      {id:'legacy',amountUsd:50,retainedAmountUsd:5.095283006,retiredUnusedAuthorizationUsd:44.904716994,retainedUnknownCostsUsd:4.44446835,history:{unknown:4.44446835}},
      {id:'exhausted',amountUsd:5,retainedAmountUsd:3.592332,retiredUnusedAuthorizationUsd:1.407668,retainedUnknownCostsUsd:0,state:'exhausted'},
      {id:'hermes-readonly-canary:'+OLD,amountUsd:5,retainedAmountUsd:.004683,retiredUnusedAuthorizationUsd:4.995317,retainedUnknownCostsUsd:0,state:'reconciled_retained_charge',history:{neverReopen:true}},
      {id:'hermes-readonly-canary:'+RUN,amountUsd:5,retainedAmountUsd:5,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0,state:'held_for_readonly_canary',rule:'keep original rule',
        admission:{kind:'hermes_readonly_canary',runId:RUN,campaignId:RUN,allocationId:ALLOCATION,ledgerPath:ledger,capUsdExact:'5.000000000',draftPr:false,aggregateBeforeSha256:'a'.repeat(64),auditRecord}}]};
  const raw=JSON.stringify(b,null,2)+'\n',expected_sha256=sha(raw);writeFileSync(aggregate,raw,{mode:0o600});
  writeFileSync(auditRecord,JSON.stringify({runId:RUN,allocationId:ALLOCATION,ledgerPath:ledger,afterSha256:expected_sha256}),{mode:0o600});writeFileSync(join(admissionDir,RUN+'.after.json'),raw,{mode:0o600});
  const l=openSpendLedger(ledger);l.createCampaign('legacy',50);l.enrollTicket('legacy','old-unknown',50,{draftPr:true});l.markTerminal('old-unknown','old_exhausted');
  for(const run of [OLD,RUN]){l.createCampaign(run,5);l.enrollTicket(run,'local:'+run,5,{draftPr:false});l.markTerminal('local:'+run,run===RUN?'verified_readonly':'readonly_canary_failed');}l.close();
  const db=new Database(ledger);db.exec("INSERT INTO spend_attempts(id,ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(1,'old-unknown','fake','fake',1,4190885,4190885,'unknown')");
  for(const [id,charge,input,uncached,output,cache] of [[53,4683,475,475,74,0],[54,4578,396,396,45,0],[55,4697,486,102,29,384]]){
    db.query("INSERT INTO spend_attempts(id,ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state,input_tokens,http_status,settled_at) VALUES(?,?,'deepseek','deepseek-v4-pro',1024,1388176,?,'settled',?,200,'2026-10-08 02:04:24')").run(id!,'local:'+(id===53?OLD:RUN),charge!,input!);
    const details={modelMatches:true,serviceTier:'standard',unknownUsageFields:0,counters:Object.fromEntries([['input_tokens',uncached],['output_tokens',output],['cache_read_input_tokens',cache],['cache_creation_input_tokens',0]].map(([k,v])=>[k,{state:'integer',value:v}]))};
    db.query("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(?,'accepted',?)").run(id!,JSON.stringify(details));
  }db.close();
  const fixtures=join(root,'fixtures'),leaf=join(fixtures,RUN),traces=join(root,'traces');mkdirSync(fixtures,{mode:0o700});mkdirSync(leaf,{mode:0o755});mkdirSync(traces,{mode:0o700});
  const fixturePath=join(leaf,'challenge.json'),fixtureRaw='{"nonce":"fake","a":1,"b":2}\n';writeFileSync(fixturePath,fixtureRaw,{mode:0o444});chmodSync(fixturePath,0o444);
  const requestId='7a18d3dc-3307-491e-82e0-2f8d8b95ca03',tracePath=join(traces,requestId+'.jsonl'),traceRaw='{"kind":"terminal","status":"no_finish"}\n';writeFileSync(tracePath,traceRaw,{mode:0o600});
  writeFileSync(canary_config,JSON.stringify({version:1,runId:RUN,campaignId:RUN,allocationId:ALLOCATION,releaseCommit:'be78cbd932687fb0fe192c3e078d0cdbc40cd1c1',fixtureDirectory:fixtures,traceDirectory:traces}),{mode:0o600});
  const claim={run_id:RUN,allocation_id:ALLOCATION,config_fingerprint:'b299a4c739532bd2eb3d4f741b76c7250515b76524d0b9e20960e72c09c4baeb',owner_epoch:'owner',request_id:requestId,state:'verified',fixture_sha256:sha(fixtureRaw),trace_path:tracePath,trace_sha256:sha(traceRaw),receipt_id:'',model_requests:2,tool_reads:1,charged_micros:9275,started_at:'2026-10-08T02:04:20.033Z',completed_at:'2026-10-08T02:04:25.255Z'};
  claim.receipt_id='sha256:'+sha(JSON.stringify({version:1,kind:'verified_readonly',runId:RUN,allocationId:ALLOCATION,configFingerprint:claim.config_fingerprint,ownerEpoch:claim.owner_epoch,requestId,fixtureSha256:claim.fixture_sha256,tracePath,traceSha256:claim.trace_sha256,modelRequests:2,toolReads:1,chargedMicros:9275,nativeStatus:'no_finish',traceClosed:true,cleanupComplete:true,publicationApproved:false}));
  const state=new Database(state_db);
  function insert(table:string,value:Record<string,unknown>){const keys=Object.keys(value);state.exec('CREATE TABLE '+table+'('+keys.map(k=>k+' '+(typeof value[k]==='number'?'INTEGER':'TEXT')).join(',')+')');state.query('INSERT INTO '+table+' VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>value[k] as string|number|null));}
  insert('hermes_readonly_canaries',claim);
  insert('gary_slack_outbox',{delivery_key:READY_KEY,kind:'ready',request_id:REQUEST,app_id:'A0C7QFW3PEG',team_id:'T0AA24R7VUZ',bot_user_id:'U0C7NPEUG1F',recipient_id:'U0A9M5W16F8',target_channel:'U0A9M5W16F8',thread_ts:null,content_sha256:'dd5abbdd9a4251dcfc82a9a7c833bbfb7676948b0e23049c62aa5c801ad67438',readiness_receipt_id:claim.receipt_id,claim_id:'one-claim',status:'sent',claimed_at:'2026-10-08T02:04:25.376Z',completed_at:'2026-10-08T02:04:25.559Z',slack_channel:'D0C7EJELQJX',slack_ts:'1791425065.474159',error_code:null});state.close();
  return {root,b,fixturePath,tracePath,options:{aggregate,ledger,state_db,audit_dir,canary_config,expected_sha256,original_admission_after_sha256:expected_sha256,expected_canary_config_sha256:sha(readFileSync(canary_config)),expected_readiness_receipt_id:claim.receipt_id,apply:true}};
}
function rows(path:string,table:string){const db=new Database(path,{readonly:true});try{return db.query('SELECT * FROM '+table).all();}finally{db.close();}}
function sql(path:string,statement:string){const db=new Database(path);try{db.exec(statement);}finally{db.close();}}
function call(options:Record<string,unknown>,hook='pass'){
  const code="import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('reconcile',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\no=json.loads(sys.argv[2])\ndef hook(stage):\n "+hook.replaceAll('\n','\n ')+"\nprint(json.dumps(m.reconcile(o,hook)))";
  return Bun.spawnSync(['python3','-B','-c',code,script,JSON.stringify(options)],{stdout:'pipe',stderr:'pipe'});
}
function good(o:Record<string,unknown>,hook='pass'){const r=call(o,hook);expect(r.stderr.toString()).toBe('');expect(r.exitCode).toBe(0);return JSON.parse(r.stdout.toString());}
function bad(o:Record<string,unknown>,error:string,hook='pass'){const r=call(o,hook);expect(r.exitCode).not.toBe(0);expect(r.stderr.toString()).toContain(error);}
const budget=(o:{aggregate:string})=>JSON.parse(readFileSync(o.aggregate,'utf8'));

test('preview is read-only and computes exact retirement totals',()=>{
  const {options:o}=fixture(),before=readFileSync(o.aggregate),prior=rows(o.ledger,'spend_attempts');const r=good({...o,apply:false});
  expect(r.applied).toBe(false);expect(r.retiredUsd).toBe('4.990725000');expect(r.totals.runtimeCommittedOrHeldUsd).toBe('8.701573006');expect(r.totals.runtimeUnallocatedUsd).toBe('51.298426994');
  expect(readFileSync(o.aggregate)).toEqual(before);expect(rows(o.ledger,'spend_attempts')).toEqual(prior);expect(existsSync(o.audit_dir)).toBe(false);expect(existsSync(o.aggregate+'.admission.lock')).toBe(false);
});
test('retirement preserves oldholds, unknowns, caps, SQL/history/claim/outbox and is idempotent',()=>{
  const {options:o,b}=fixture(),tables=['spend_campaigns','spend_tickets','spend_attempts','spend_receipts'];const before=tables.map(t=>rows(o.ledger,t)),claim=rows(o.state_db,'hermes_readonly_canaries'),outbox=rows(o.state_db,'gary_slack_outbox');
  const r=good(o);expect(r.sqlWrites).toBe(false);expect(r.newAuthorization).toBe(false);const after=budget(o);
  expect(after.runtimeAllocations.slice(0,3)).toEqual(b.runtimeAllocations.slice(0,3));expect(after.history).toEqual(b.history);const entry=after.runtimeAllocations[3];
  expect(entry.amountUsd).toBe(5);expect(entry.admission).toEqual(b.runtimeAllocations[3]!.admission);expect(entry.rule).toBe('keep original rule');expect(entry.retainedAmountUsd).toBe(.009275);expect(entry.retiredUnusedAuthorizationUsd).toBe(4.990725);
  expect(after.runtimeCommittedOrHeldUsd).toBe(8.701573006);expect(after.runtimeUnallocatedUsd).toBe(51.298426994);expect(after.totalCommittedOrHeldUsd).toBe(48.701573006);expect(after.runtimeAuthorizationRetiredUsd).toBe(56.298426994);expect(after.runtimeUnknownHoldsUsd).toBe(4.44446835);expect(after.hermesPaidCalls).toBe(3);
  expect(tables.map(t=>rows(o.ledger,t))).toEqual(before);expect(rows(o.state_db,'hermes_readonly_canaries')).toEqual(claim);expect(rows(o.state_db,'gary_slack_outbox')).toEqual(outbox);
  expect(good(o).recovery).toBe(true);expect(budget(o)).toEqual(after);
});
for(const stage of ['audit_prepared','retirement_durable'])test('safe exact retry after '+stage,()=>{
  const {options:o}=fixture();bad(o,'injected',"if stage=='"+stage+"': raise RuntimeError('injected')");expect(existsSync(o.aggregate+'.admission.lock')).toBe(false);
  expect(good(o).applied).toBe(true);expect(good(o).recovery).toBe(true);expect(budget(o).runtimeCommittedOrHeldUsd).toBe(8.701573006);
});
test('exclusive lock and stale claim block retirement without stealing',()=>{
  const {options:o}=fixture(),lock=o.aggregate+'.admission.lock';mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'claim.json'),'prior',{mode:0o600});bad(o,'FileExistsError');expect(readFileSync(join(lock,'claim.json'),'utf8')).toBe('prior');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.692298006);
});
test('unsettled, wrongcharge, extraattempt, badreceipt, activeallocation and badclaim fail closed',()=>{
  for(const change of ['unknown','charge','extra','receipt','active','claim','claim-receipt','other-running']){const {options:o}=fixture();
    if(change==='unknown')sql(o.ledger,"UPDATE spend_attempts SET state='unknown' WHERE id=55");
    if(change==='charge')sql(o.ledger,'UPDATE spend_attempts SET charged_micros=4696 WHERE id=55');
    if(change==='extra')sql(o.ledger,"INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('"+ALLOCATION+"','deepseek','deepseek-v4-pro',1,1,1,'unknown')");
    if(change==='receipt')sql(o.ledger,"UPDATE spend_receipts SET reason='ambiguous' WHERE attempt_id=54");
    if(change==='active')sql(o.ledger,"UPDATE spend_tickets SET state='active' WHERE ticket_id='old-unknown'");
    if(change==='claim')sql(o.state_db,"UPDATE hermes_readonly_canaries SET state='failed'");
    if(change==='claim-receipt')sql(o.state_db,"UPDATE hermes_readonly_canaries SET receipt_id='forged'");
    if(change==='other-running')sql(o.state_db,"INSERT INTO hermes_readonly_canaries(run_id,state) VALUES('other','running')");
    const before=readFileSync(o.aggregate);bad(o,'verified_canary_reconciliation:');expect(readFileSync(o.aggregate)).toEqual(before);
  }
});
test('missing/unconfirmed/wrongidentity/duplicate DM cannot support retirement',()=>{
  for(const change of ['missing','unknown','identity','receipt','duplicate','delivery','different-dm','different-timestamp']){const {options:o}=fixture();
    if(change==='missing')sql(o.state_db,'DELETE FROM gary_slack_outbox');
    if(change==='unknown')sql(o.state_db,"UPDATE gary_slack_outbox SET status='unknown'");
    if(change==='identity')sql(o.state_db,"UPDATE gary_slack_outbox SET recipient_id='OTHER'");
    if(change==='receipt')sql(o.state_db,"UPDATE gary_slack_outbox SET readiness_receipt_id='wrong'");
    if(change==='duplicate')sql(o.state_db,'INSERT INTO gary_slack_outbox SELECT * FROM gary_slack_outbox');
    if(change==='delivery')sql(o.state_db,'UPDATE gary_slack_outbox SET slack_ts=NULL');
    if(change==='different-dm')sql(o.state_db,"UPDATE gary_slack_outbox SET slack_channel='DOTHER'");
    if(change==='different-timestamp')sql(o.state_db,"UPDATE gary_slack_outbox SET slack_ts='1791425065.474160'");
    bad(o,'verified_canary_reconciliation:');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.692298006);
  }
});
test('tampered trace, fixture or config rejects readiness proof',()=>{
  for(const kind of ['trace','fixture','config']){const f=fixture(),o=f.options;
    const path=kind==='trace'?f.tracePath:kind==='fixture'?f.fixturePath:o.canary_config;if(kind==='fixture')chmodSync(path,0o600);writeFileSync(path,readFileSync(path,'utf8')+' ');
    if(kind==='config'){const c=JSON.parse(readFileSync(path,'utf8'));c.runId='other';writeFileSync(path,JSON.stringify(c));}
    bad(o,'verified_canary_reconciliation:');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.692298006);
  }
});
test('CAS preserves aggregate and catches concurrent reservations/history changes',()=>{
  for(const kind of ['aggregate','reservation','prior-unknown']){const {options:o}=fixture();
    const hook=kind==='aggregate'?"if stage=='audit_prepared':\n with open(o['aggregate'],'a') as f: f.write(' ')":"if stage=='audit_prepared':\n import sqlite3\n db=sqlite3.connect(o['ledger']);db.execute(\""+(kind==='reservation'?"UPDATE spend_tickets SET state='active' WHERE ticket_id='old-unknown'":"UPDATE spend_attempts SET charged_micros=4190886 WHERE id=1")+"\");db.commit();db.close()";
    bad(o,kind==='reservation'?'concurrent_allocation_or_canary':'evidence_or_aggregate_changed',hook);expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.692298006);
  }
});
test('bad hash, symlink, unsafe mode and edited recovery audit cannot retire again',()=>{
  for(const kind of ['hash','symlink','mode','audit']){const {root,options:o}=fixture();
    if(kind==='hash')o.expected_sha256='a'.repeat(64);
    if(kind==='symlink'){const p=o.aggregate;o.aggregate=join(root,'alias');symlinkSync(p,o.aggregate);}
    if(kind==='mode')chmodSync(o.aggregate,0o666);
    if(kind==='audit'){good(o);writeFileSync(join(o.audit_dir,RUN+'-verified-unused-authorization-retirement.evidence.json'),'{}');}
    bad(o,'reconciliation:');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(kind==='audit'?8.701573006:13.692298006);
  }
});

test('same-content fixture/config relocation and alternate receipt cannot replace exact audited evidence',()=>{
  for(const kind of ['config-bytes','config-relocation','receipt']){const {root,options:o,fixturePath}=fixture();
    if(kind==='config-bytes')writeFileSync(o.canary_config,readFileSync(o.canary_config,'utf8')+' ');
    if(kind==='config-relocation'){const config=JSON.parse(readFileSync(o.canary_config,'utf8'));const other=join(root,'alternate');mkdirSync(other,{mode:0o700});mkdirSync(join(other,RUN),{mode:0o755});writeFileSync(join(other,RUN,'challenge.json'),readFileSync(fixturePath),{mode:0o444});config.fixtureDirectory=other;writeFileSync(o.canary_config,JSON.stringify(config));}
    if(kind==='receipt')o.expected_readiness_receipt_id='sha256:'+'a'.repeat(64);
    bad(o,kind==='receipt'?'readiness_receipt_binding':'audited_canary_config_changed');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.692298006);
  }
});
