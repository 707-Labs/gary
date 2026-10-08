import { expect, test } from 'bun:test';
import { openDb } from '../../src/state/db.ts';
import { recordActionEnd, recordActionStart, recordPr, upsertTicket } from '../../src/state/queries.ts';
import { createCanaryReadiness } from '../../src/hermes/host-readiness.ts';
import type { CodePublicationReceipt } from '../../src/handlers/code.ts';
import { bindCanonicalCodeAction, type CodeActionAdmission } from '../../src/hermes/canonical-admission.ts';
import type { HermesActivationBinding, RuntimeHealthEvidence } from '../../src/hermes/activation.ts';
import { SpendLedger, type SpendStatus } from '../../src/spend.ts';

function fixture(legacyActions=0) {
  const db = openDb(':memory:');
  const issueId = '10000000-0000-4000-8000-000000000001', repo = 'fixture/repo', head = 'a'.repeat(40);
  for(let index=0;index<legacyActions;index++) {
    const ticketLinearId='legacy-ticket-'+index;
    upsertTicket(db,{linearId:ticketLinearId,identifier:'LEGACY-'+index});
    recordActionStart(db,{ticketLinearId,stateFingerprint:'historical-'+index,actionType:index%2===0?'start_coding':'classify'});
  }
  upsertTicket(db, { linearId: issueId, identifier: 'ERT-1' });
  const id = recordActionStart(db, { ticketLinearId: issueId, stateFingerprint: 'fp', actionType: 'start_coding', provider: 'deepseek', model: 'deepseek-v4-pro' });
  db.query('INSERT INTO hermes_action_owners(action_id,owner_epoch) VALUES(?,?)').run(id, 'owner');
  const allocation: SpendStatus = { ticketId: issueId, campaignId: 'fixture', state: 'closed', terminalReason: 'pr_opened', draftPr: true,
    capMicros: 10_000_000, chargedMicros: 1, remainingMicros: 9_999_999, attemptCount: 1, unknownAttempts: 0,
    campaignCapMicros: 10_000_000, campaignChargedMicros: 1 };
  const ledger = { status: () => allocation } as unknown as SpendLedger;
  const evidence: RuntimeHealthEvidence[] = [{ actionId: String(id), ownerEpoch: 'owner', ticketId: issueId, runtime: 'hermes',
    terminalStatus: 'finished', traceClosed: true, publicationApproved: false, taskId: 'task', requestId: 'request', tracePath: '/private/fake', completedAt: new Date().toISOString() }];
  const activation = { getHealthEvidence: () => evidence } as unknown as HermesActivationBinding;
  const monitor = createCanaryReadiness({ db, ledger, activation, issueId, repo });
  const observation = () => ({ headSha: head, worktreeClean: true });
  const receipt: CodePublicationReceipt = { issueId, repo, branch: 'gary/canary', prNumber: 42, prUrl: 'https://github.com/fixture/repo/pull/42',
    draft: true, admittedRuntime: true, requiredCheck: { command: 'bun run check', passed: true, exitCode: 0, timedOut: false, afterCheck: observation() },
    review: { fingerprint: 'independent-review-fingerprint', verdict: 'approve', afterApproval: observation() },
    publication: { beforePush: observation(), afterPush: observation(), remoteHeadSha: head }, postRebaseCheck: 'not_run' };
  const admission = { actionId: String(id), fingerprint: 'fp', ownerEpoch: 'owner', ledger, ticketId: issueId, repo, assertActive() {} } as CodeActionAdmission;
  function complete() {
    recordPr(db, { githubId: 42, ticketLinearId: issueId, repo, prNumber: 42, branch: 'gary/canary' });
    recordActionEnd(db, { id, success: true, outcome: 'pr_opened' });
  }
  return { db, monitor, receipt, admission, evidence, allocation, complete, id, issueId };
}
test('native finish alone and handled success do not claim whole-host readiness', () => {
  const f = fixture();
  try {
    expect(f.monitor.check().ready).toBe(false);
    f.monitor.recordPublication(f.admission, f.receipt);
    expect(f.monitor.check().ready).toBe(false);
    recordActionEnd(f.db, { id: f.id, success: true, outcome: 'handled' });
    expect(f.monitor.check().ready).toBe(false);
    f.complete();
    expect(f.monitor.check()).toMatchObject({ ready: true, hermesCanarySucceeded: true });
    expect(f.monitor.check().receiptId).toMatch(/^sha256:[0-9a-f]{64}$/);
  } finally { f.db.close(); }
});
test('ledger closure, native ownership, actual publication, and unchanged clean HEAD are required', () => {
  for (const mutation of [
    (f:ReturnType<typeof fixture>) => { f.allocation.state='active'; },
    (f:ReturnType<typeof fixture>) => { f.allocation.unknownAttempts=1; },
    (f:ReturnType<typeof fixture>) => { f.allocation.terminalReason='operator_stopped'; },
    (f:ReturnType<typeof fixture>) => { f.evidence.splice(0); },
    (f:ReturnType<typeof fixture>) => { f.receipt.publication.remoteHeadSha='b'.repeat(40); },
    (f:ReturnType<typeof fixture>) => { f.receipt.review.afterApproval.worktreeClean=false; },
    (f:ReturnType<typeof fixture>) => { f.receipt.requiredCheck.afterCheck.headSha=null; },
    (f:ReturnType<typeof fixture>) => { f.receipt.requiredCheck.timedOut=true; },
    (f:ReturnType<typeof fixture>) => { f.receipt.admittedRuntime=false; },
    (f:ReturnType<typeof fixture>) => { f.receipt.prNumber=43; },
  ]) {
    const f=fixture();
    try { f.complete(); mutation(f); f.monitor.recordPublication(f.admission,f.receipt); expect(f.monitor.check().ready).toBe(false); }
    finally { f.db.close(); }
  }
});
test('stale action, in-flight action, altered owner and mismatched receipt fail closed', () => {
  const f=fixture();
  try {
    f.complete(); f.monitor.recordPublication(f.admission,f.receipt);
    f.db.query("UPDATE hermes_action_owners SET owner_epoch='other' WHERE action_id=?").run(f.id);
    expect(f.monitor.check().ready).toBe(false);
    f.db.query("UPDATE hermes_action_owners SET owner_epoch='owner' WHERE action_id=?").run(f.id);
    recordActionStart(f.db,{ticketLinearId:f.issueId,stateFingerprint:'other',actionType:'start_coding',provider:'deepseek',model:'deepseek-v4-pro'});
    expect(f.monitor.check().ready).toBe(false);
    expect(()=>f.monitor.recordPublication(f.admission,{...f.receipt,repo:'other/repo'})).toThrow('publication_readiness_binding_mismatch');
  } finally { f.db.close(); }
});

test('21 unrelated unclaimed historical actions remain unchanged and do not block exact publication readiness',()=>{
 const f=fixture(21);
 try {
  const historical=()=>f.db.query('SELECT * FROM actions WHERE id<>? ORDER BY id').all(f.id);
  const before=JSON.stringify(historical());
  expect(historical()).toHaveLength(21);
  f.monitor.recordPublication(f.admission,f.receipt);
  expect(f.monitor.check().ready).toBe(false);
  f.complete();
  const ready=f.monitor.check();
  expect(ready).toMatchObject({ready:true,hermesCanarySucceeded:true});
  expect(f.monitor.check()).toEqual(ready);
  expect(JSON.stringify(historical())).toBe(before);
  expect(f.db.query<{n:number},[]>('SELECT count(*) AS n FROM actions WHERE completed_at IS NULL').get()!.n).toBe(21);
  expect(f.db.query('SELECT action_id,owner_epoch FROM hermes_action_owners').all()).toEqual([{action_id:f.id,owner_epoch:'owner'}]);
 }finally{f.db.close();}
});

test('unfinished canonical owner claims block globally even for older unrelated actions',()=>{
 const f=fixture(21);
 try {
  f.complete();f.monitor.recordPublication(f.admission,f.receipt);
  expect(f.monitor.check().ready).toBe(true);
  const before=f.db.query('SELECT * FROM actions WHERE id<>? ORDER BY id').all(f.id);
  const oldId=f.db.query<{id:number},[]>('SELECT id FROM actions ORDER BY id LIMIT 1').get()!.id;
  f.db.query('INSERT INTO hermes_action_owners(action_id,owner_epoch) VALUES(?,?)').run(oldId,'older-owner');
  expect(f.monitor.check().ready).toBe(false);
  expect(f.monitor.check().ready).toBe(false);
  expect(f.db.query('SELECT * FROM actions WHERE id<>? ORDER BY id').all(f.id)).toEqual(before);
 }finally{f.db.close();}
});

test('a separate currently claimed action blocks until canonical completion without deleting its owner',()=>{
 const f=fixture();
 try {
  f.complete();f.monitor.recordPublication(f.admission,f.receipt);
  upsertTicket(f.db,{linearId:'other-ticket',identifier:'OTHER-1'});
  const current=recordActionStart(f.db,{ticketLinearId:'other-ticket',stateFingerprint:'other',actionType:'start_coding',provider:'deepseek',model:'deepseek-v4-pro'});
  f.db.query('INSERT INTO hermes_action_owners(action_id,owner_epoch) VALUES(?,?)').run(current,'other-owner');
  expect(f.monitor.check().ready).toBe(false);
  recordActionEnd(f.db,{id:current,success:false,outcome:'error'});
  expect(f.monitor.check().ready).toBe(true);
  expect(f.db.query('SELECT owner_epoch FROM hermes_action_owners WHERE action_id=?').get(current)).toEqual({owner_epoch:'other-owner'});
 }finally{f.db.close();}
});

test('closing a real admission in memory does not release an unfinished durable claim',()=>{
 const f=fixture(),ledger=new SpendLedger(':memory:');
 try {
  f.complete();f.monitor.recordPublication(f.admission,f.receipt);
  const issue:CodeActionAdmission['issue']={id:'active-ticket',identifier:'ACTIVE-1',title:'offline lifecycle',description:null,
   url:'https://linear.invalid/ACTIVE-1',stateName:'Todo',stateType:'unstarted',createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z',
   creatorId:null,creatorName:null,teamId:'team',teamKey:'ERT',blockedBy:[]};
  upsertTicket(f.db,{linearId:issue.id,identifier:issue.identifier});
  ledger.createCampaign('offline',1);ledger.enrollTicket('offline',issue.id,1);
  const actionId=recordActionStart(f.db,{ticketLinearId:issue.id,stateFingerprint:'active',actionType:'start_coding',provider:'deepseek',model:'deepseek-v4-pro'});
  const binding=bindCanonicalCodeAction({db:f.db,ledger,actionId,fingerprint:'active',issue,provider:'deepseek',model:'deepseek-v4-pro',repo:'fixture/repo'});
  expect(()=>binding.admission.assertActive()).not.toThrow();expect(f.monitor.check().ready).toBe(false);
  binding.close();expect(()=>binding.admission.assertActive()).toThrow('canonical_action_inactive');
  expect(f.monitor.check().ready).toBe(false);
  recordActionEnd(f.db,{id:actionId,success:false,outcome:'error'});
  expect(f.monitor.check().ready).toBe(true);
  expect(f.db.query('SELECT owner_epoch FROM hermes_action_owners WHERE action_id=?').get(actionId)).toEqual({owner_epoch:binding.admission.ownerEpoch});
 }finally{ledger.close();f.db.close();}
});

test('any newer same-ticket action supersedes publication even without an owner or after completion',()=>{
 for(const actionType of ['start_coding','classify','review_pr']) {
  const f=fixture(21);
  try {
   f.complete();f.monitor.recordPublication(f.admission,f.receipt);
   const current=recordActionStart(f.db,{ticketLinearId:f.issueId,stateFingerprint:'newer',actionType});
   expect(f.monitor.check().ready).toBe(false);
   recordActionEnd(f.db,{id:current,success:true,outcome:'handled'});
   expect(f.monitor.check().ready).toBe(false);
  }finally{f.db.close();}
 }
});

test('admitted identity, completion, and exact clean published head stay mandatory with historical rows',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.db.query('UPDATE actions SET completed_at=NULL WHERE id=?').run(f.id);},
  (f:ReturnType<typeof fixture>)=>{f.db.query("UPDATE actions SET state_fingerprint='changed' WHERE id=?").run(f.id);},
  (f:ReturnType<typeof fixture>)=>{f.db.query('DELETE FROM hermes_action_owners WHERE action_id=?').run(f.id);},
  (f:ReturnType<typeof fixture>)=>{f.db.query("UPDATE hermes_action_owners SET owner_epoch='another' WHERE action_id=?").run(f.id);},
  (f:ReturnType<typeof fixture>)=>{f.receipt.publication.beforePush.headSha='b'.repeat(40);},
  (f:ReturnType<typeof fixture>)=>{f.receipt.publication.afterPush.worktreeClean=false;},
  (f:ReturnType<typeof fixture>)=>{f.receipt.postRebaseCheck='incomplete';},
  (f:ReturnType<typeof fixture>)=>{f.receipt.review.afterApproval.headSha='c'.repeat(40);},
 ]) {
  const f=fixture(21);
  try{f.complete();mutate(f);f.monitor.recordPublication(f.admission,f.receipt);expect(f.monitor.check().ready).toBe(false);}
  finally{f.db.close();}
 }
});

test('dangling or malformed canonical owner claims fail closed instead of disappearing from the query',()=>{
 for(const kind of ['dangling','empty-owner','wrong-action-type'] as const) {
  const f=fixture();
  try {
   f.complete();f.monitor.recordPublication(f.admission,f.receipt);
   expect(f.monitor.check().ready).toBe(true);
   if(kind==='dangling') {
    f.db.exec('PRAGMA foreign_keys=OFF');
    f.db.query('INSERT INTO hermes_action_owners(action_id,owner_epoch) VALUES(?,?)').run(f.id+100,'dangling-owner');
   }else{
    upsertTicket(f.db,{linearId:'malformed-ticket',identifier:'MALFORMED-1'});
    const current=recordActionStart(f.db,{ticketLinearId:'malformed-ticket',stateFingerprint:'malformed',actionType:kind==='empty-owner'?'start_coding':'classify'});
    recordActionEnd(f.db,{id:current,success:true,outcome:'handled'});
    f.db.query('INSERT INTO hermes_action_owners(action_id,owner_epoch) VALUES(?,?)').run(current,kind==='empty-owner'?' ':'wrong-type-owner');
   }
   expect(f.monitor.check().ready).toBe(false);
  }finally{f.db.close();}
 }
});
