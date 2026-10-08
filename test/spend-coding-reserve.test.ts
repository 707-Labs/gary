import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger, CODING_SPEND_RESERVE_POLICY as P, SPEND_CONTEXT_TOKENS, spendReservationMicros, type CodingSpendRole } from '../src/spend.ts';
const clean:Array<()=>void>=[];
afterEach(()=>{for(const f of clean.splice(0).reverse())f();});
const url='https://api.deepseek.com/anthropic/v1/messages';
function fixture(protectedCoding=true){
 const dir=mkdtempSync(join(tmpdir(),'coding-floor-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'spend.db'),ledger=new SpendLedger(path);clean.push(()=>ledger.close());
 ledger.createCampaign('coding',10);ledger.enrollTicket('coding','fresh',10,{draftPr:true,codingReviewReserve:protectedCoding});
 const sql=new Database(path);clean.push(()=>sql.close());
 const charge=(n:number)=>sql.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('fresh','deepseek','deepseek-v4-pro',8192,?,?,'settled')").run(n,n);
 return {path,ledger,sql,charge};
}
function response(input=SPEND_CONTEXT_TOKENS){return Response.json({id:'offline',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'text',text:'offline'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:input,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}});}
function send(ledger:SpendLedger,max=8192,role?:CodingSpendRole,inner:typeof fetch=(async()=>response()) as unknown as typeof fetch){
 return ledger.withSpendScope('fresh',()=>ledger.guardedFetch('deepseek',inner)(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-v4-pro',max_tokens:max,messages:[{role:'user',content:'offline'}]})}),role?{codingRole:role}:{});
}
test('fixed floors exactly fund next review and body/title at canonical tariff',()=>{
 const review=spendReservationMicros('deepseek',4096),body=spendReservationMicros('deepseek',1024),title=spendReservationMicros('deepseek',128);
 expect(Number(P.workFloorMicros)).toBe(review+body+title);expect(Number(P.reviewFloorMicros)).toBe(body+title);expect(Number(P.publicationBodyFloorMicros)).toBe(title);
 expect(P.workFloorMicros).toBe(4_173_145);expect(P.capMicros).toBe(10_000_000);
});
test('fresh exact draft enrollment alone installs immutable policy and reopening cannot renew',()=>{
 const f=fixture();expect(f.ledger.hasCodingReviewReserve('fresh')).toBe(true);
 expect(()=>f.ledger.enrollTicket('coding','fresh',10,{draftPr:true})).toThrow('immutable');
 f.ledger.markTerminal('fresh','done');f.ledger.enrollTicket('coding','fresh',10,{draftPr:true,codingReviewReserve:true});
 expect(f.ledger.status('fresh')?.state).toBe('closed');expect(f.ledger.hasCodingReviewReserve('fresh')).toBe(true);
});
test('old enrollment cannot gain policy even unused, and invalid caps/draft insert no ticket',()=>{
 const f=fixture(false);expect(()=>f.ledger.enrollTicket('coding','fresh',10,{draftPr:true,codingReviewReserve:true})).toThrow('immutable');
 for(const [name,cap,draft] of [['small',5,true],['nondraft',10,false]] as const){f.ledger.createCampaign(name,cap);expect(()=>f.ledger.enrollTicket(name,name,cap,{draftPr:draft,codingReviewReserve:true})).toThrow('exact $10');expect(f.ledger.status(name)).toBeNull();}
});
for(const [role,max,floor] of [['work',8192,P.workFloorMicros],['review',4096,P.reviewFloorMicros],['publication_body',1024,P.publicationBodyFloorMicros],['publication_title',128,0]] as const){
 test(role+' boundary admits exactly one request while preserving required floor',async()=>{const f=fixture();f.charge(P.capMicros-floor-spendReservationMicros('deepseek',max));await send(f.ledger,max,role);expect(f.ledger.status('fresh')?.remainingMicros).toBe(floor);});
 test(role+' one micro below boundary blocks HTTP without inserting an attempt',async()=>{const f=fixture();f.charge(P.capMicros-floor-spendReservationMicros('deepseek',max)+1);let calls=0;await expect(send(f.ledger,max,role,(async()=>{calls++;return response();}) as unknown as typeof fetch)).rejects.toThrow('protected coding reserve');expect(calls).toBe(0);expect(f.ledger.status('fresh')?.attemptCount).toBe(1);});
}
test('settlement replenishes actual headroom without changing cap or protected policy',async()=>{const f=fixture();for(let i=0;i<20;i++)await send(f.ledger,8192,'work',(async()=>response(100)) as unknown as typeof fetch);expect(f.ledger.status('fresh')?.chargedMicros).toBe(20*Math.ceil((100*132+8192*396)/100));expect(f.ledger.status('fresh')?.capMicros).toBe(P.capMicros);expect(f.ledger.hasCodingReviewReserve('fresh')).toBe(true);});
test('policy survives fresh connection and omitted role defaults to protected work',async()=>{const f=fixture();f.charge(P.capMicros-P.workFloorMicros);const other=new SpendLedger(f.path);clean.push(()=>other.close());expect(other.hasCodingReviewReserve('fresh')).toBe(true);await expect(send(other,128)).rejects.toThrow('protected coding reserve');});
test('separate writer connections cannot race past reservation or unresolved request',async()=>{const f=fixture();const other=new SpendLedger(f.path);clean.push(()=>other.close());let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);let calls=0;const first=send(f.ledger,8192,'work',(async()=>{calls++;started();await wait;return response(100);}) as unknown as typeof fetch);await ready;await expect(send(other)).rejects.toThrow('unresolved request');expect(calls).toBe(1);release();await first;expect(other.status('fresh')?.unknownAttempts).toBe(0);});
test('unknown request blocks every protected role and never releases reservation',async()=>{const f=fixture();await expect(send(f.ledger,8192,'work',(async()=>{throw Error('offline disconnect');}) as unknown as typeof fetch)).rejects.toThrow('disconnect');for(const role of ['work','review','publication_body','publication_title'] as const)await expect(send(f.ledger,128,role)).rejects.toThrow('unresolved request');expect(f.ledger.status('fresh')?.chargedMicros).toBe(spendReservationMicros('deepseek',8192));expect(f.ledger.status('fresh')?.attemptCount).toBe(1);});
test('parallel ALS scopes and nested omitted scope cannot leak reviewer authority',async()=>{const f=fixture();f.charge(P.capMicros-P.workFloorMicros);let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);const review=f.ledger.withSpendScope('fresh',async()=>{entered();await waiting;await send(f.ledger,4096);},{codingRole:'review'});await ready;await expect(send(f.ledger,128)).rejects.toThrow('protected coding reserve');release();await review;await expect(send(f.ledger,128)).rejects.toThrow('protected coding reserve');});
for(const [role,max] of [['review',4097],['publication_body',1025],['publication_title',129]] as const)test('rejects excessive '+role+' output before HTTP',async()=>{const f=fixture();await expect(send(f.ledger,max,role)).rejects.toThrow('role output');expect(f.ledger.status('fresh')?.attemptCount).toBe(0);});
test('legacy/DM allocation behavior and unknown history remain unaffected',async()=>{const f=fixture(false);f.charge(8_000_000);await send(f.ledger);expect(f.ledger.status('fresh')?.attemptCount).toBe(2);expect(f.ledger.hasCodingReviewReserve('fresh')).toBe(false);f.ledger.createCampaign('dm',5);f.ledger.enrollTicket('dm','local:dm',5);expect(f.ledger.hasCodingReviewReserve('local:dm')).toBe(false);});
test('untrusted role HTTP field cannot select publication privilege',async()=>{const f=fixture();f.charge(P.capMicros-P.workFloorMicros);let calls=0;await expect(f.ledger.withSpendScope('fresh',()=>f.ledger.guardedFetch('deepseek',(async()=>{calls++;return response();}) as unknown as typeof fetch)(url,{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_tokens:128,role:'publication_title',messages:[{role:'user',content:'offline'}]})}))).rejects.toThrow();expect(calls).toBe(0);});
