import { expect, test } from 'bun:test';
import { openDb } from '../../src/state/db.ts';
import { recordActionEnd, recordActionStart, recordPr, upsertTicket } from '../../src/state/queries.ts';
import { createCanaryReadiness } from '../../src/hermes/host-readiness.ts';
import type { CodePublicationReceipt } from '../../src/handlers/code.ts';
import type { CodeActionAdmission } from '../../src/hermes/canonical-admission.ts';
import type { HermesActivationBinding, RuntimeHealthEvidence } from '../../src/hermes/activation.ts';
import type { SpendLedger, SpendStatus } from '../../src/spend.ts';

function fixture() {
  const db = openDb(':memory:');
  const issueId = '10000000-0000-4000-8000-000000000001', repo = 'fixture/repo', head = 'a'.repeat(40);
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
