import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openSpendLedger } from '../../src/spend.ts';
import { admitReadonlyCanary } from '../../src/hermes/readonly-canary-budget.ts';
const RUN='hermes-readonly-20261008-db05d434',ALLOCATION='local:'+RUN;
const roots:string[]=[];afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const script=resolve(import.meta.dir,'../../scripts/reconcile-readonly-canary.py');
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'canary-retire-'));chmodSync(root,0o700);roots.push(root);
  const aggregate=join(root,'aggregate.json'),ledger=join(root,'spend.db'),state_db=join(root,'gary.db'),audit_dir=join(root,'audit');
  const originalDir=join(root,'admission');mkdirSync(originalDir,{mode:0o700});const auditRecord=join(originalDir,RUN+'.intent.json');
  const b={schemaVersion:2,totalCeilingUsd:100,runtimePoolUsd:60,other90HoldUsd:30,bufferHoldUsd:10,runtimeCommittedOrHeldUsd:13.687615006,
    runtimeUnallocatedUsd:46.312384994,totalCommittedOrHeldUsd:53.687615006,runtimeUnknownHoldsUsd:4.44446835,runtimeAuthorizationRetiredUsd:46.312384994,
    hermesPaidCalls:0,history:{allPriorNotes:'preserve',originalAuthorization:100},lastReconciliation:{id:'earlier-preserve'},
    runtimeAllocations:[{id:'legacy',amountUsd:50,retainedAmountUsd:5.095283006,retiredUnusedAuthorizationUsd:44.904716994,retainedUnknownCostsUsd:4.44446835,history:{unknown:4.44446835}},
      {id:'exhausted',amountUsd:5,retainedAmountUsd:3.592332,retiredUnusedAuthorizationUsd:1.407668,retainedUnknownCostsUsd:0,state:'exhausted'},
      {id:'hermes-readonly-canary:'+RUN,amountUsd:5,retainedAmountUsd:5,retiredUnusedAuthorizationUsd:0,retainedUnknownCostsUsd:0,state:'held_for_readonly_canary',rule:'keep original rule',
        admission:{kind:'hermes_readonly_canary',runId:RUN,campaignId:RUN,allocationId:ALLOCATION,ledgerPath:ledger,capUsdExact:'5.000000000',draftPr:false,aggregateBeforeSha256:'a'.repeat(64),auditRecord}}]};
  const raw=JSON.stringify(b,null,2)+'\n',expected_sha256=sha(raw);writeFileSync(aggregate,raw,{mode:0o600});
  writeFileSync(auditRecord,JSON.stringify({runId:RUN,allocationId:ALLOCATION,ledgerPath:ledger,afterSha256:expected_sha256}),{mode:0o600});
  writeFileSync(join(originalDir,RUN+'.after.json'),raw,{mode:0o600});
  const l=openSpendLedger(ledger);l.createCampaign('prior',50);l.enrollTicket('prior','prior-allocation',50,{draftPr:true});l.markTerminal('prior-allocation','old');
  l.createCampaign(RUN,5);l.enrollTicket(RUN,ALLOCATION,5,{draftPr:false});l.markTerminal(ALLOCATION,'readonly_canary_failed');l.close();
  const db=new Database(ledger);db.query("INSERT INTO spend_attempts(id,ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state,input_tokens,http_status,settled_at) VALUES(53,?,'deepseek','deepseek-v4-pro',1024,1388176,4683,'settled',475,200,'2026-10-08 01:45:37')").run(ALLOCATION);
  const details={modelMatches:true,serviceTier:'standard',unknownUsageFields:0,counters:Object.fromEntries([['input_tokens',475],['output_tokens',74],['cache_read_input_tokens',0],['cache_creation_input_tokens',0]].map(([k,v])=>[k,{state:'integer',value:v}]))};
  db.query("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(53,'accepted',?)").run(JSON.stringify(details));db.close();
  const state=new Database(state_db);state.exec('CREATE TABLE hermes_readonly_canaries(run_id TEXT PRIMARY KEY,allocation_id TEXT UNIQUE,state TEXT,model_requests INTEGER,tool_reads INTEGER,completed_at TEXT,owner_epoch TEXT)');
  state.query("INSERT INTO hermes_readonly_canaries VALUES(?,?,'failed',0,0,'2026-10-08T01:45:37.522Z','old-owner')").run(RUN,ALLOCATION);state.close();
  return {root,b,options:{aggregate,ledger,state_db,audit_dir,expected_sha256,original_admission_after_sha256:expected_sha256,apply:true}};
}
function rows(path:string,table:string){const db=new Database(path,{readonly:true});try{return db.query('SELECT * FROM '+table).all();}finally{db.close();}}
function sql(path:string,statement:string){const db=new Database(path);try{db.exec(statement);}finally{db.close();}}
function call(options:Record<string,unknown>,hook='pass'){
  const code="import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('reconcile',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\no=json.loads(sys.argv[2])\ndef hook(stage):\n "+hook.replaceAll('\n','\n ')+"\nprint(json.dumps(m.reconcile(o,hook)))";
  return Bun.spawnSync(['python3','-B','-c',code,script,JSON.stringify(options)],{stdout:'pipe',stderr:'pipe'});
}
function good(options:Record<string,unknown>,hook='pass'){const r=call(options,hook);expect(r.stderr.toString()).toBe('');expect(r.exitCode).toBe(0);return JSON.parse(r.stdout.toString());}
function bad(options:Record<string,unknown>,error:string,hook='pass'){const r=call(options,hook);expect(r.exitCode).not.toBe(0);expect(r.stderr.toString()).toContain(error);}
const budget=(o:{aggregate:string})=>JSON.parse(readFileSync(o.aggregate,'utf8'));

test('preview reads evidence and never changes aggregate, SQL or creates lock/audit',()=>{
  const {options:o}=fixture(),before=readFileSync(o.aggregate),prior=rows(o.ledger,'spend_tickets');const result=good({...o,apply:false});
  expect(result.applied).toBe(false);expect(result.retiredUsd).toBe('4.995317000');expect(readFileSync(o.aggregate)).toEqual(before);expect(rows(o.ledger,'spend_tickets')).toEqual(prior);
  expect(existsSync(o.audit_dir)).toBe(false);expect(existsSync(o.aggregate+'.admission.lock')).toBe(false);
});
test('retains conservative4683 micros, retires only unused authorization and preserves SQL/claim/history',()=>{
  const {options:o,b}=fixture();const tables=['spend_campaigns','spend_tickets','spend_attempts','spend_receipts'];const before=tables.map(t=>rows(o.ledger,t)),claim=rows(o.state_db,'hermes_readonly_canaries');
  const r=good(o);expect(r.nextCanaryEnrolled).toBe(false);expect(r.runtimeHeldUsd).toBe('8.692298006');const after=budget(o);
  expect(after.runtimeAllocations.slice(0,2)).toEqual(b.runtimeAllocations.slice(0,2));expect(after.history).toEqual(b.history);expect(after.lastReconciliation).toEqual(b.lastReconciliation);
  const old=after.runtimeAllocations[2];expect(old.amountUsd).toBe(5);expect(old.admission).toEqual(b.runtimeAllocations[2]!.admission);expect(old.rule).toBe('keep original rule');expect(old.retainedAmountUsd).toBe(.004683);expect(old.retiredUnusedAuthorizationUsd).toBe(4.995317);
  expect(after.runtimeUnallocatedUsd).toBe(51.307701994);expect(after.totalCommittedOrHeldUsd).toBe(48.692298006);expect(after.runtimeAuthorizationRetiredUsd).toBe(51.307701994);expect(after.runtimeUnknownHoldsUsd).toBe(4.44446835);expect(after.hermesPaidCalls).toBe(1);
  expect(tables.map(t=>rows(o.ledger,t))).toEqual(before);expect(rows(o.state_db,'hermes_readonly_canaries')).toEqual(claim);
  expect(good(o).recovery).toBe(true);expect(budget(o)).toEqual(after);
});
test('existing hold-first helper can admit NEW5 after retirement without reopening old allocation',()=>{
  const {root,options:o}=fixture();good(o);
  const r=admitReadonlyCanary({aggregatePath:o.aggregate,ledgerPath:o.ledger,auditDir:join(root,'next-audit'),runId:'next-canary',campaignId:'next-canary',allocationId:'local:next-canary',expectedAggregateSha256:sha(readFileSync(o.aggregate)),apply:true});
  expect(r.canRun).toBe(true);expect(r.status?.capMicros).toBe(5_000_000);expect(r.runtimeHeldUsd).toBe('13.692298006');expect(r.runtimeUnallocatedUsd).toBe('46.307701994');
  expect(budget(o).totalCommittedOrHeldUsd).toBe(53.692298006);const ledger=openSpendLedger(o.ledger);expect(ledger.status(ALLOCATION)).toMatchObject({state:'closed',capMicros:5_000_000,chargedMicros:4683,terminalReason:'readonly_canary_failed',unknownAttempts:0});ledger.close();
});
for(const stage of ['audit_prepared','retirement_durable'])test('recover exact same retirement after '+stage+' without another release',()=>{
  const {options:o}=fixture();bad(o,'injected',"if stage=='"+stage+"': raise RuntimeError('injected')");
  expect(existsSync(o.aggregate+'.admission.lock')).toBe(false);expect(good(o).applied).toBe(true);expect(good(o).recovery).toBe(true);expect(budget(o).runtimeCommittedOrHeldUsd).toBe(8.692298006);
});
test('same cooperative lock excludes admission and reconciliation; stale claim never stolen',()=>{
  const {options:o}=fixture(),lock=o.aggregate+'.admission.lock';mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'claim.json'),'old',{mode:0o600});
  bad(o,'FileExistsError');expect(readFileSync(join(lock,'claim.json'),'utf8')).toBe('old');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.687615006);
});
test('unknown/unsettled attempts, wrong receipt, active old/other allocation, running/absent claim block retirement',()=>{
  for(const change of ['unknown','charge','receipt','old-active','other-active','claim-running','claim-absent']){
    const {options:o}=fixture();
    if(change==='unknown')sql(o.ledger,"UPDATE spend_attempts SET state='unknown' WHERE id=53");
    if(change==='charge')sql(o.ledger,'UPDATE spend_attempts SET charged_micros=4682 WHERE id=53');
    if(change==='receipt')sql(o.ledger,"UPDATE spend_receipts SET reason='ambiguous' WHERE attempt_id=53");
    if(change==='old-active')sql(o.ledger,"UPDATE spend_tickets SET state='active' WHERE ticket_id='"+ALLOCATION+"'");
    if(change==='other-active')sql(o.ledger,"UPDATE spend_tickets SET state='active' WHERE ticket_id='prior-allocation'");
    if(change==='claim-running')sql(o.state_db,"UPDATE hermes_readonly_canaries SET state='running'");
    if(change==='claim-absent')sql(o.state_db,'DELETE FROM hermes_readonly_canaries');
    const before=readFileSync(o.aggregate);bad(o,'readonly_canary_reconciliation:');expect(readFileSync(o.aggregate)).toEqual(before);
  }
});
test('CAS catches aggregate or receipt changes after audits before retirement',()=>{
  for(const kind of ['aggregate','receipt']){const {options:o}=fixture();
    const hook=kind==='aggregate'?"if stage=='audit_prepared':\n with open(o['aggregate'],'a') as f: f.write(' ')":"if stage=='audit_prepared':\n import sqlite3\n db=sqlite3.connect(o['ledger']);db.execute(\"UPDATE spend_receipts SET reason='ambiguous' WHERE attempt_id=53\");db.commit();db.close()";
    bad(o,kind==='aggregate'?'evidence_or_aggregate_changed':'old_receipt_evidence',hook);expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.687615006);
  }
});
test('changed hashes, symlinks and unsafe permissions cannot release money',()=>{
  for(const kind of ['hash','symlink','mode']){const {root,options:o}=fixture();
    if(kind==='hash')o.expected_sha256='a'.repeat(64);
    if(kind==='symlink'){const original=o.aggregate;o.aggregate=join(root,'alias');symlinkSync(original,o.aggregate);}
    if(kind==='mode')chmodSync(o.aggregate,0o666);
    bad(o,'readonly_canary_reconciliation:');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(13.687615006);
  }
});
test('later aggregate changes or modified saved evidence block idempotent replay',()=>{
  for(const kind of ['aggregate','evidence']){const {options:o}=fixture();good(o);
    if(kind==='aggregate')writeFileSync(o.aggregate,readFileSync(o.aggregate,'utf8')+' ');
    else writeFileSync(join(o.audit_dir,RUN+'-unused-authorization-retirement.evidence.json'),'{}');
    bad(o,'recovery_audit_changed');expect(budget(o).runtimeCommittedOrHeldUsd).toBe(8.692298006);
  }
});
