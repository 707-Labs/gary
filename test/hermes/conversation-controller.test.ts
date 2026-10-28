import { afterEach, beforeEach, expect, test } from 'bun:test';
import { openDb } from '../../src/state/db.ts';
import { SpendLedger } from '../../src/spend.ts';
import { createConversationController, type ConversationControllerOptions, type ConversationControllerRuntime } from '../../src/hermes/conversation-controller.ts';
import type { ProjectIntegrationBinding } from '../../src/hermes/project-integrations.ts';

const project = { id:'mulligan',teamKey:'ERT',repo:'707-Labs/mulligan-labs',sharedChannelIds:['CLOCAL'] };
const binding:ProjectIntegrationBinding = { projectId:project.id,repo:project.repo,teamKey:project.teamKey,
  audience:{surface:'private_dm',requesterId:'UOWNER',teamId:'TLOCAL',channelId:'DLOCAL',threadTs:'123.456'} };
const fingerprint='sha256:'+'a'.repeat(64);
let db:ReturnType<typeof openDb>,ledger:SpendLedger,options:ConversationControllerOptions,wakes:number;
let runtime:ConversationControllerRuntime;
beforeEach(()=>{
  db=openDb(':memory:');ledger=new SpendLedger(':memory:');wakes=0;
  db.query("INSERT INTO tickets(linear_id,identifier) VALUES('admitted','ERT-1'),('old','ERT-2'),('private','BIRD-3')").run();
  ledger.createCampaign('existing-campaign',10);
  ledger.enrollTicket('existing-campaign','admitted',10,{draftPr:true,codingReviewReserve:true});
  runtime={loopState:'idle',dispatchReady:true};
  options={db,ledger,teamId:'TLOCAL',ownerUserId:'UOWNER',projects:[project],
    activation:{issueId:'admitted',repo:project.repo,policyFingerprint:fingerprint,allowedActionTypes:new Set(['classify','start_coding'])},
    runtime:()=>runtime,wake:()=>{wakes++;return true;}};
});
afterEach(()=>{db.close();ledger.close();});
const request=(operation:'status'|'handoff'='status',ticket='ERT-1')=>({operation,ticket,requestId:'slack-event:tool-call'});
const execute=(r=request(),b=binding)=>createConversationController(options)(b,r);
function classification(phase='classified') {
  db.query("UPDATE tickets SET classification='CODE',classification_confidence=.9,classification_scope='S' WHERE linear_id='admitted'").run();
  db.query("INSERT INTO actions(id,ticket_linear_id,action_type,state_fingerprint,started_at,completed_at,success,outcome) VALUES(1,'admitted','classify','fp','2026-10-10T10:00:00Z','2026-10-10T10:01:00Z',1,'handled')").run();
  db.query('INSERT INTO hermes_coding_trials(issue_id,policy_fingerprint,campaign_id,cap_micros,phase,epoch,classify_action,human_signature,confidence,scope) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('admitted',fingerprint,'existing-campaign',10_000_000,phase,'private-epoch',1,'private-signature',.9,'S');
}

test('status reports exact existing allocation/readiness without inferring worker health or exposing foreign work',async()=>{
  const before=db.query('SELECT * FROM events').all(),spend=ledger.status('admitted');
  const result=await execute();
  expect(result.status).toBe('observed');expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ticket:'ERT-1',workerState:'not_observed',admission:{handoffEligible:true,blockedReason:null},
    budget:{capMicros:10_000_000,chargedMicros:0,unresolvedAttempts:0,codingReviewReserve:true,nextRequestFits:true}});
  expect(result.runtime).toEqual({loopState:'idle',dispatchReady:true});
  expect(JSON.stringify(result)).not.toContain('BIRD-3');expect(JSON.stringify(result)).not.toContain('existing-campaign');
  expect(db.query('SELECT * FROM events').all()).toEqual(before);expect(ledger.status('admitted')).toEqual(spend);expect(wakes).toBe(0);
});

test('handoff records one scoped durable intent and wakes only the existing loop, including after helper restart',async()=>{
  const spend=ledger.status('admitted');
  const first=await execute(request('handoff'));
  expect(first.status).toBe('reconsideration_requested');expect('receiptId' in first&&first.receiptId).toBe(1);expect(wakes).toBe(1);
  const again=await execute(request('handoff'));
  expect(again.status).toBe('reconsideration_already_recorded');expect(wakes).toBe(1);
  expect(db.query('SELECT * FROM actions').all()).toEqual([]);expect(db.query('SELECT * FROM hermes_coding_trials').all()).toEqual([]);
  expect(db.query('SELECT * FROM events').all()).toHaveLength(1);expect(ledger.status('admitted')).toEqual(spend);
  expect(JSON.stringify(db.query('SELECT * FROM events').all())).not.toContain('slack-event:tool-call');
  const shared={...binding,audience:{...binding.audience,surface:'shared_channel' as const,channelId:'CLOCAL'}};
  expect((await execute(request('handoff'),shared)).status).toBe('reconsideration_requested');expect(wakes).toBe(2);
  expect(db.query('SELECT * FROM events').all()).toHaveLength(2);
});

test('successful classification can only request reconsideration; the existing loop rechecks upstream fingerprint and blockers',async()=>{
  classification();
  expect((await execute(request('handoff'))).status).toBe('reconsideration_requested');
  expect(db.query("SELECT phase,code_action FROM hermes_coding_trials").get()).toEqual({phase:'classified',code_action:null});
  expect(db.query('SELECT * FROM actions').all()).toHaveLength(1);expect(wakes).toBe(1);
});

for(const closed of ['trial','allocation','terminal'] as const) test(closed+' stop survives changed request and no intent is written',async()=>{
  classification(closed==='trial'?'closed':'classified');
  if(closed==='allocation')ledger.markTerminal('admitted','hard_progress_stop');
  if(closed==='terminal')db.query("UPDATE tickets SET terminal_state='escalated' WHERE linear_id='admitted'").run();
  const actions=db.query('SELECT * FROM actions').all(),trials=db.query('SELECT * FROM hermes_coding_trials').all(),spend=ledger.status('admitted');
  const result=await execute(request('handoff'));
  expect(result.status).toBe('blocked');expect('reason' in result&&result.reason).toBe({trial:'trial_closed',allocation:'allocation_closed',terminal:'ticket_terminal'}[closed]);
  if(closed==='allocation')expect(result.items[0]?.budget?.terminalReason).toBe('hard_progress_stop');
  expect(db.query('SELECT * FROM actions').all()).toEqual(actions);expect(db.query('SELECT * FROM hermes_coding_trials').all()).toEqual(trials);
  expect(ledger.status('admitted')).toEqual(spend);expect(wakes).toBe(0);expect(db.query('SELECT * FROM events').all()).toEqual([]);
});

test('unfinished owned action is explicitly liveness-unknown even while host is polling; no competing retry',async()=>{
  classification('coding');runtime={loopState:'polling',dispatchReady:true};
  db.query("INSERT INTO actions(id,ticket_linear_id,action_type,state_fingerprint,started_at) VALUES(2,'admitted','start_coding','fp','2026-01-01T00:00:00Z')").run();
  db.query("UPDATE hermes_coding_trials SET code_action=2").run();
  db.query("INSERT INTO hermes_action_owners VALUES(2,'private-owner-epoch')").run();
  const result=await execute(request('handoff'));
  expect(result.status).toBe('blocked');expect('reason' in result&&result.reason).toBe('unfinished_action_not_reclaimable');
  expect(result.items[0]).toMatchObject({workerState:'unfinished_record_liveness_unknown',latestAction:{recordedOwner:true,completedAt:null}});
  expect(JSON.stringify(result)).not.toContain('private-owner-epoch');expect(JSON.stringify(result)).not.toContain('private-signature');expect(wakes).toBe(0);
});

test('missing activation, different issue, and unknown ticket give concrete distinct blocked reasons',async()=>{
  expect((await execute(request('handoff','ERT-2')))).toMatchObject({status:'blocked',reason:'outside_current_admission'});
  expect((await execute(request('handoff','ERT-987')))).toMatchObject({status:'blocked',reason:'ticket_not_recorded_in_controller'});
  delete options.activation;
  expect((await execute(request('handoff')))).toMatchObject({status:'blocked',reason:'controller_not_activated'});expect(wakes).toBe(0);
});

test('current action and reserve policies are immutable handoff gates',async()=>{
  classification();db.query("UPDATE hermes_coding_trials SET policy_fingerprint='changed'").run();
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'trial_policy_changed'});
  db.query('UPDATE hermes_coding_trials SET policy_fingerprint=?').run(fingerprint);
  options.activation!.allowedActionTypes=new Set(['classify']);
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'action_not_admitted'});
  options.activation!.allowedActionTypes=new Set(['start_coding']);db.query("UPDATE tickets SET classification_scope='M' WHERE linear_id='admitted'").run();
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'classification_changed_or_consumed'});expect(wakes).toBe(0);
});

test('unknown paid receipt remains charged and bars handoff without any provider retry',async()=>{
  let fakeCalls=0;
  const guarded=ledger.guardedFetch('openrouter',(async()=>{fakeCalls++;return Response.json({id:'mock',type:'message',model:'deepseek/deepseek-v4.1-flash',role:'assistant',content:[{type:'text',text:'offline'}],stop_reason:'end_turn'});}) as unknown as typeof fetch);
  await ledger.withSpendScope('admitted',()=>guarded('https://openrouter.ai/api/v1/messages',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek/deepseek-v4.1-flash',provider:{data_collection:'deny',max_price:{prompt:0.6,completion:2.4}}, max_tokens:32,messages:[{role:'user',content:'offline-only'}]})}));
  const spend=ledger.status('admitted');
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'unresolved_spend'});
  expect(ledger.status('admitted')).toEqual(spend);expect(fakeCalls).toBe(1);expect(wakes).toBe(0);
});

test('shared readers get status but only Tanner can hand off; wrong audience/project/ticket binding is denied',async()=>{
  const reader={...binding,audience:{...binding.audience,surface:'shared_channel' as const,channelId:'CLOCAL',requesterId:'UREADER'}};
  expect((await execute(request(),reader)).status).toBe('observed');
  await expect(execute(request('handoff'),reader)).rejects.toThrow('controller_handoff_denied');
  for(const b of [{...binding,repo:'707-Labs/other'}, {...binding,teamKey:'BIRD'},
    {...reader,audience:{...reader.audience,channelId:'COTHER'}}, {...binding,audience:{...binding.audience,teamId:'TOTHER'}}]) {
    await expect(execute(request(),b)).rejects.toThrow('controller_scope_denied');
  }
  await expect(execute(request('status','BIRD-3'))).rejects.toThrow('invalid_arguments');expect(wakes).toBe(0);
});

test('safe finite diagnostic exposes the known cause, never arbitrary error text',async()=>{
  classification('closed');
  const diag={origin:'worker',code:'model_output_cap_exceeded',stage:'model_response',category:'none'} as const;
  db.query('UPDATE actions SET error_message=?').run('coding trial stopped; diagnostic='+JSON.stringify(diag));
  expect((await execute()).items[0]?.latestAction?.diagnostic).toEqual(diag);
  db.query('UPDATE actions SET error_message=?').run('coding trial stopped; diagnostic='+JSON.stringify({...diag,secret:'private'}));
  expect((await execute()).items[0]?.latestAction?.diagnostic).toBeNull();
  db.query('UPDATE actions SET error_message=?').run('private prompt and credential xoxb-private-data');
  const result=await execute();expect(result.items[0]?.latestAction?.diagnostic).toBeNull();expect(JSON.stringify(result)).not.toContain('private prompt');
});

test('cancelled or stopped controller cannot request a wake; rejected wake never claims success',async()=>{
  const abort=new AbortController();abort.abort();
  await expect(createConversationController(options)(binding,request('handoff'),abort.signal)).rejects.toThrow('operation_cancelled');
  runtime={loopState:'stopped',dispatchReady:true};
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'controller_not_ready'});
  runtime={loopState:'idle',dispatchReady:true};options.wake=()=>false;
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'controller_stopped_before_wake'});
  expect(await execute(request('handoff'))).toMatchObject({status:'reconsideration_already_recorded'});expect(wakes).toBe(0);
});

test('missing funding and reserved headroom are reported instead of silently increasing the allocation',async()=>{
  options.ledger={status:()=>null,hasCodingReviewReserve:()=>false,canDispatch:()=>false};
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'allocation_not_enrolled'});
  options.ledger={status:id=>ledger.status(id),hasCodingReviewReserve:()=>true,canDispatch:()=>false};
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'insufficient_reserved_headroom'});expect(wakes).toBe(0);
  options.ledger={status:id=>({...ledger.status(id)!,remainingMicros:1_500_000}),hasCodingReviewReserve:()=>true,canDispatch:()=>true};
  expect(await execute(request('handoff'))).toMatchObject({status:'blocked',reason:'protected_coding_reserve_would_be_consumed'});expect(wakes).toBe(0);
});
