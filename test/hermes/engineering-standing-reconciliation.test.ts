import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {createStandingEngineeringBudget} from '../../src/hermes/engineering-standing-budget.ts';
import {fingerprintJson} from '../../src/hermes/audit-trace.ts';
import {standingBudgetFixture} from './fixtures/engineering-standing.ts';
const hash=(v:unknown)=>fingerprintJson(v).sha256;
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(f=>f()));
function fixture(){
 const f=standingBudgetFixture(5_000_000,20_000_000);clean.push(()=>f.dispose());f.allocator.enrollPool();
 const path=join(f.root,'journal.sqlite'),journal=new Database(path);
 journal.exec(`CREATE TABLE engineering_tasks(task_id TEXT PRIMARY KEY,state TEXT,cleanup_confirmed INTEGER,spec_json TEXT,spec_hash TEXT,session_id TEXT,owner_epoch TEXT);
 CREATE TABLE engineering_cleanup_proofs(receipt_id TEXT,task_id TEXT,session_id TEXT,owner_epoch TEXT);
 CREATE TABLE engineering_ingress_requests(request_id TEXT,final_json TEXT,stage TEXT);
 CREATE TABLE engineering_model_requests(allocation_id TEXT,state TEXT);`);clean.push(()=>journal.close());
 const pool=createStandingEngineeringBudget({ledger:f.ledger,authority:f.authority,assertAuthority:f.assertAuthority,terminalJournalPath:path});clean.push(()=>pool.close());
 function terminal(n:number,charge=100_000){const input=f.input(n),allocation=pool.allocate(input),spec={taskId:input.taskId,requestId:input.requestId,allocationId:allocation.allocationId};
 journal.query('INSERT INTO engineering_tasks VALUES(?,\'blocked\',1,?,?,\'session\',\'owner\')').run(input.taskId,JSON.stringify(spec),hash(spec));
 journal.query('INSERT INTO engineering_cleanup_proofs VALUES(?,?,\'session\',\'owner\')').run('cleanup-'+n,input.taskId);
 journal.query('INSERT INTO engineering_ingress_requests VALUES(?,?,\'blocked\')').run(input.requestId,JSON.stringify({...spec,phase:'final',status:'blocked'}));
 const attempt=f.db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'deepseek','deepseek-v4-pro',128,1000000,?,'settled')").run(allocation.allocationId,charge);
 f.db.query("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(?,'accepted','{}')").run(attempt.lastInsertRowid);
 return allocation;}
 const reconcile=(taskIds:string[],historicalChatAttemptIds:number[]=[])=>pool.reconcileTerminalTasks({taskIds,historicalChatAttemptIds,operatorEvidenceSha256:'d'.repeat(64)});
 return {...f,pool,journal,terminal,reconcile};
}
test('four terminal tasks release only unused commitments; replay preserves charges and receipts, fresh task fits',()=>{
 const f=fixture(),tasks=[1,2,3,4].map(n=>f.terminal(n));expect(f.pool.ready()).toBe(false);
 const before=f.db.query('SELECT * FROM spend_receipts').all(),out=f.reconcile(tasks.map(x=>x.taskId));
 expect(out.status).toMatchObject({grossCommittedCapMicros:20_000_000,releasedCapMicros:19_600_000,committedCapMicros:400_000,chargedMicros:400_000,canAllocate:true});
 expect(f.reconcile(tasks.map(x=>x.taskId))).toEqual(out);expect(f.db.query('SELECT * FROM spend_receipts').all()).toEqual(before);
 expect(()=>tasks[0]!.assertCurrent()).toThrow('task_unavailable');f.pool.allocate(f.input(5)).assertCurrent();
 expect(f.pool.status().committedCapMicros).toBe(5_400_000);
});
test('unknown/in-flight liabilities or unconfirmed cleanup block atomic batch release',()=>{
 const f=fixture(),a=f.terminal(1),b=f.terminal(2);
 f.db.query("UPDATE spend_attempts SET state='unknown',charged_micros=reserved_micros WHERE ticket_id=?").run(b.allocationId);
 expect(()=>f.reconcile([a.taskId,b.taskId])).toThrow('unresolved_attempts');expect(f.pool.status().releasedCapMicros).toBe(0);
 f.journal.query('UPDATE engineering_tasks SET cleanup_confirmed=0 WHERE task_id=?').run(a.taskId);
 expect(()=>f.reconcile([a.taskId])).toThrow('terminal_cleanup_required');expect(f.ledger.status(a.allocationId)!.state).toBe('active');
});
test('tampered terminal proof and historical receipts fail closed',()=>{
 const f=fixture(),a=f.terminal(1);f.reconcile([a.taskId]);
 f.db.exec("UPDATE spend_receipts SET details_json='{\"changed\":true}'");expect(()=>f.pool.status()).toThrow('release_binding');
});
test('future coding chats retain reservations and unknown charges; associated task shares $5 ceiling',async()=>{
 const f=fixture();f.ledger.createCampaign('chat',20);f.ledger.enrollTicket('chat','local:hermes-dm-20261008-tanner',20);
 let task:any;
 await f.pool.withCodingConversation('local:hermes-dm-20261008-tanner',async()=>{
  f.db.exec("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('local:hermes-dm-20261008-tanner','deepseek','deepseek-v4-pro',128,1000000,1000000,'unknown')");
  task=f.pool.allocate(f.input(1));expect(()=>task.assertReservation(4_100_000)).toThrow('task_conversation_cap');task.assertReservation(4_000_000);
  expect(f.pool.status().auxiliaryChargeMicros).toBe(1_000_000);
  await expect(f.pool.withCodingConversation('local:hermes-dm-20261008-tanner',async()=>{})).rejects.toThrow('conversation_busy');
 });
 expect(f.pool.status()).toMatchObject({committedCapMicros:6_000_000,chargedMicros:1_000_000});
 expect(f.ledger.status('local:hermes-dm-20261008-tanner')!.unknownAttempts).toBe(1);
});
test('historical coding-chat receipts are added once, without adopting unrelated history',()=>{
 const f=fixture(),a=f.terminal(1);f.ledger.createCampaign('chat',20);f.ledger.enrollTicket('chat','local:hermes-dm-20261008-tanner',20);
 const id=Number(f.db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('local:hermes-dm-20261008-tanner','deepseek','deepseek-v4-pro',128,1000000,25000,'settled')").run().lastInsertRowid);
 f.db.query("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(?,'accepted','{}')").run(id);
 f.reconcile([a.taskId],[id]);f.reconcile([a.taskId],[id]);expect(f.pool.status()).toMatchObject({committedCapMicros:125000,chargedMicros:125000,auxiliaryChargeMicros:25000});
});
