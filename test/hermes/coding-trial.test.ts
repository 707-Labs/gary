import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/state/db.ts';
import { upsertTicket, setClassification, recordActionStart } from '../../src/state/queries.ts';
import { SpendLedger } from '../../src/spend.ts';
import { createCodingTrial } from '../../src/hermes/coding-trial.ts';
import { bindCanonicalCodeAction } from '../../src/hermes/canonical-admission.ts';
import type { AssignedIssue } from '../../src/adapters/linear.ts';

const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'coding-trial-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'gary.db'),db=openDb(path);cleanup.push(()=>db.close());
 const ledger=new SpendLedger(':memory:');cleanup.push(()=>ledger.close());
 ledger.createCampaign('trial',20);ledger.enrollTicket('trial','ticket',10,{draftPr:true});
 upsertTicket(db,{linearId:'ticket',identifier:'ERT-1'});
 const options={db,ledger,issueId:'ticket',repo:'fixture/repo',policyFingerprint:'sha256:'+'a'.repeat(64)};
 const controller=createCodingTrial(options);
 const input={issueId:'ticket',actionType:'classify',fingerprint:'state1',humanSignature:'human1',provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'};
 const classify=()=>{const a=controller.admit(input);setClassification(db,{linearId:'ticket',classification:'CODE',confidence:.99,scope:'S'});a.complete(true,'handled');return a;};
 const code=()=>controller.admit({...input,actionType:'start_coding',fingerprint:'state2'});
 const rows=()=>db.query('SELECT * FROM actions ORDER BY id').all();
 return{root,path,db,ledger,options,controller,input,classify,code,rows};
}
test('durable classify -> code binds one allocation/policy, preserves 21 historical rows, and closes once',()=>{
 const f=fixture();upsertTicket(f.db,{linearId:'history',identifier:'ERT-0'});
 for(let i=0;i<21;i++)recordActionStart(f.db,{ticketLinearId:'history',stateFingerprint:'old'+i,actionType:'start_coding'});
 const before=f.rows();f.classify();const action=f.code();action.assertActive();
 expect(f.db.query<{synchronous:number},[]>('PRAGMA synchronous').get()?.synchronous).toBe(2);
 expect(f.db.query('SELECT phase,campaign_id,cap_micros,policy_fingerprint FROM hermes_coding_trials').get()).toEqual({phase:'coding',campaign_id:'trial',cap_micros:10_000_000,policy_fingerprint:f.options.policyFingerprint});
 const binding=bindCanonicalCodeAction({db:f.db,ledger:f.ledger,actionId:action.actionId,fingerprint:'state2',issue:{id:'ticket'} as AssignedIssue,provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'});
 f.controller.assertCodingAction(binding.admission);action.complete(true,'pr_opened');binding.close();
 expect(f.ledger.status('ticket')?.terminalReason).toBe('pr_opened');expect(()=>action.assertActive()).toThrow();expect(()=>f.code()).toThrow();
 expect(f.rows().slice(0,21)).toEqual(before);expect(f.rows()).toHaveLength(23);
});
test('a second connection cannot reclaim a crashed classification or create another action',()=>{
 const f=fixture();f.controller.admit(f.input);const other=openDb(f.path);cleanup.push(()=>other.close());
 const restarted=createCodingTrial({...f.options,db:other});
 expect(()=>restarted.admit(f.input)).toThrow('already_attempted');
 expect(()=>restarted.admit({...f.input,actionType:'start_coding'})).toThrow('classification_changed_or_consumed');
 expect(f.rows()).toHaveLength(1);expect(f.ledger.status('ticket')?.attemptCount).toBe(0);
});
test('completed classification may continue after restart, but coding crash cannot restart',()=>{
 const f=fixture();f.classify();const other=openDb(f.path);cleanup.push(()=>other.close());const restart=createCodingTrial({...f.options,db:other});
 const action=restart.admit({...f.input,actionType:'start_coding',fingerprint:'state2'});action.assertActive();
 expect(()=>f.code()).toThrow();expect(f.rows()).toHaveLength(2);
});
for(const kind of ['history','preclassified','policy','human','classification','newer'] as const)test('denies '+kind+' before new action or paid work',()=>{
 const f=fixture();let admit=()=>f.controller.admit(f.input);
 if(kind==='history')recordActionStart(f.db,{ticketLinearId:'ticket',stateFingerprint:'old',actionType:'classify'});
 else if(kind==='preclassified')setClassification(f.db,{linearId:'ticket',classification:'CODE',confidence:.9,scope:'S'});
 else{f.classify();admit=f.code;
  if(kind==='policy')admit=()=>createCodingTrial({...f.options,policyFingerprint:'different'}).admit({...f.input,actionType:'start_coding'});
  if(kind==='human')admit=()=>f.controller.admit({...f.input,actionType:'start_coding',humanSignature:'changed'});
  if(kind==='classification')setClassification(f.db,{linearId:'ticket',classification:'CODE',confidence:.99,scope:'M'});
  if(kind==='newer')recordActionStart(f.db,{ticketLinearId:'ticket',stateFingerprint:'newer',actionType:'bounce'});
 }
 const before=f.rows();expect(admit).toThrow();expect(f.rows()).toEqual(before);expect(f.ledger.status('ticket')?.attemptCount).toBe(0);
});
for(const kind of ['ANSWER','BOUNCE','low','large','rate_limited','error'] as const)test(kind+' consumes trial and cannot retry',()=>{
 const f=fixture();const a=f.controller.admit(f.input);
 setClassification(f.db,{linearId:'ticket',classification:kind==='ANSWER'||kind==='BOUNCE'?kind:'CODE',confidence:kind==='low'?.1:.99,scope:kind==='large'?'L':'S'});
 a.complete(!['rate_limited','error'].includes(kind),kind==='rate_limited'?'rate_limited':kind==='error'?'error':'handled');
 expect(f.ledger.status('ticket')?.state).toBe('closed');expect(f.db.query<{phase:string},[]>('SELECT phase FROM hermes_coding_trials').get()?.phase).toBe('closed');
 expect(()=>f.controller.admit(f.input)).toThrow();expect(()=>f.code()).toThrow();expect(f.rows()).toHaveLength(1);
});
test('newer canonical action fences paid work and publication without rewriting history',()=>{
 const f=fixture();f.classify();const a=f.code();recordActionStart(f.db,{ticketLinearId:'ticket',stateFingerprint:'newer',actionType:'bounce'});
 expect(()=>a.assertActive()).toThrow('superseded');a.complete(false,'error');expect(f.rows()).toHaveLength(3);
});
test('unclaimed action cannot call activated coding factory binding',()=>{
 const f=fixture();const id=recordActionStart(f.db,{ticketLinearId:'ticket',stateFingerprint:'state2',actionType:'start_coding',provider:'deepseek',model:'deepseek-v4-pro'});
 const b=bindCanonicalCodeAction({db:f.db,ledger:f.ledger,actionId:id,fingerprint:'state2',issue:{id:'ticket'} as AssignedIssue,provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'});
 expect(()=>f.controller.assertCodingAction(b.admission)).toThrow('action_binding');b.close();
});


test('a different issue cannot bypass an unfinished classification claim without a code owner',()=>{
 const f=fixture();f.controller.admit(f.input);
 upsertTicket(f.db,{linearId:'other',identifier:'ERT-2'});f.ledger.enrollTicket('trial','other',10,{draftPr:true});
 const other=createCodingTrial({...f.options,issueId:'other'});
 expect(()=>other.admit({...f.input,issueId:'other'})).toThrow('other_trial_unfinished');expect(f.rows()).toHaveLength(1);
});
test('oversized trial allocation is rejected before claim or action',()=>{
 const f=fixture();upsertTicket(f.db,{linearId:'large',identifier:'ERT-3'});
 f.ledger.createCampaign('large',11);f.ledger.enrollTicket('large','large',11,{draftPr:true});
 const large=createCodingTrial({...f.options,issueId:'large'});
 expect(()=>large.admit({...f.input,issueId:'large'})).toThrow('allocation');expect(f.rows()).toHaveLength(0);
});
