import { RuntimeDiagnosticError } from '../../src/hermes/runtime-diagnostics.ts';
import { ExecutorCleanupUncertainError } from '../../src/executors/cleanup-guard.ts';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLMClient } from '../../src/adapters/glm.ts';
import type { AssignedIssue, LinearAdapter } from '../../src/adapters/linear.ts';
import type { GitHubClient } from '../../src/adapters/github.ts';
import type { AgentLoopArgs } from '../../src/agent/loop.ts';
import * as classifier from '../../src/handlers/classifier.ts';
import * as codeHandler from '../../src/handlers/code.ts';
import { createCodingTrial, type CodingTrial } from '../../src/hermes/coding-trial.ts';
import { HERMES_CODING_RUNTIME_POLICY } from '../../src/hermes/coding-runtime-policy.ts';
import type { CodeActionAdmission } from '../../src/hermes/canonical-admission.ts';
import { runLoop, tick, type LoopDeps } from '../../src/loop.ts';
import { AllProvidersExhaustedError, createProvider, createProviderChain } from '../../src/providers.ts';
import { SpendLedger } from '../../src/spend.ts';
import { openDb } from '../../src/state/db.ts';
import { recordActionStart, recordPr, upsertTicket } from '../../src/state/queries.ts';

const repo='fixture/repo',policyFingerprint='sha256:'+'a'.repeat(64);
const result={status:'finished' as const,summary:'offline',iterations:0,inputTokens:0,outputTokens:0,
  cacheCreationTokens:0,cacheReadTokens:0,phase:'hermes',runLog:[]};
const classification:classifier.Classification={classification:'CODE',confidence:.99,scope:'S',reasoning:'offline fixture'};
type ActionRow={id:number;action_type:string;completed_at:string|null;success:number|null;outcome:string;state_fingerprint:string};
type ClaimRow={phase:string;classify_action:number;code_action:number|null;policy_fingerprint:string;epoch:string};

function makeFixture(){
  const directory=mkdtempSync(join(tmpdir(),'gary-trial-dispatch-'));
  const dbPath=join(directory,'gary.db'),ledgerPath=join(directory,'spend.db');
  let db=openDb(dbPath),ledger=new SpendLedger(ledgerPath);
  const issue:AssignedIssue={id:'trial-dispatch-ticket',identifier:'FIX-123',title:'Offline coding trial',description:'One bounded change.',
    url:'https://linear.invalid/FIX-123',stateName:'Todo',stateType:'unstarted',createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z',
    creatorId:null,creatorName:null,teamId:'fixture',teamKey:'FIX',blockedBy:[]};
  upsertTicket(db,{linearId:issue.id,identifier:issue.identifier});
  ledger.createCampaign('offline-trial',10);ledger.enrollTicket('offline-trial',issue.id,10,{draftPr:true,codingReviewReserve:true});
  let forbiddenNetwork=0,fakeRequests=0,publications=0,admission:CodeActionAdmission|undefined;
  const provider=createProvider({name:'deepseek',model:'deepseek-v4-pro',apiKey:'fake-only',baseUrl:'https://provider.invalid',defaultBackoffMs:1000},
    {fetch:(async()=>{forbiddenNetwork++;throw new Error('network forbidden in offline dispatcher test');}) as unknown as typeof fetch});
  const controller=(fingerprint=policyFingerprint)=>createCodingTrial({db,ledger,issueId:issue.id,repo,policyFingerprint:fingerprint});
  const deps:LoopDeps={db,spend:ledger,codingTrial:controller(),codingExecutorProfile:HERMES_CODING_RUNTIME_POLICY.executor,allowedIssueIds:new Set([issue.id]),allowedActionTypes:new Set(['classify','start_coding']),
    linear:{linearUserId:'gary',fetchAssignedIssues:async()=>[issue],fetchCommentMeta:async()=>[],fetchComments:async()=>[],
      postComment:async()=>{},moveToInProgress:async()=>{},unassign:async()=>{}} as unknown as LinearAdapter,
    github:{} as GitHubClient,glm:new GLMClient(createProviderChain([provider])),cloudflare:null,repoMap:new Map([['FIX',repo]]),
    allowlistedMentionUserIds:[],reposDir:'/offline/repos',workspacesDir:'/offline/workspaces',agentLoopMaxIterations:28,agentLoopTimeoutMs:1000,
    maxCiAttempts:3,maxAttemptsPerTicket:5,circuitBreakerWindowHours:6,stalePrAfterMs:1000,
    review:{providerOrder:['deepseek'],maxRounds:1,iterationCap:1,timeoutMs:1000},
    createAdmittedCodeLoop:action=>{admission=action;deps.codingTrial!.assertCodingAction(action);return async()=>{
      deps.codingTrial!.assertCodingAction(action);return result;
    };},
  };
  const realClassify=classifier.classifyTicket,realComment=classifier.generateClassificationComment;
  const classify=spyOn(classifier,'classifyTicket').mockResolvedValue({...classification});
  const comment=spyOn(classifier,'generateClassificationComment').mockResolvedValue('offline classification');
  const coding=spyOn(codeHandler,'runCodeHandler').mockImplementation(async(handler,args)=>{
    expect(handler.strictPublicationArtifact).toBe(true);expect(args.draftPr).toBe(true);
    expect(handler.workspaceExecutorProfile).toBe(HERMES_CODING_RUNTIME_POLICY.executor);
    expect(await handler.runAdmittedAgentLoop!({} as AgentLoopArgs)).toEqual(result);
    handler.assertCanPublish!();publications++;
    return {status:'pr_opened',branch:'offline-trial',summary:'offline only'};
  });
  return {deps,issue,classify,comment,coding,realClassify,realComment,
    db:()=>db,ledger:()=>ledger,admission:()=>admission,publications:()=>publications,fakeRequests:()=>fakeRequests,
    actions:()=>db.query<ActionRow,[]>('SELECT id,action_type,completed_at,success,outcome,state_fingerprint FROM actions ORDER BY id').all(),
    claim:()=>db.query<ClaimRow,[]>('SELECT phase,classify_action,code_action,policy_fingerprint,epoch FROM hermes_coding_trials').get(),
    async fakeModel(known=true){
      const guarded=ledger.guardedFetch('deepseek',(async()=>{fakeRequests++;return Response.json({
        id:'offline-response',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'text',text:'offline'}],stop_reason:'end_turn',
        ...(known?{usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}}:{}),
      });}) as unknown as typeof fetch);
      return guarded('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({model:'deepseek-v4-pro',max_tokens:32,messages:[{role:'user',content:'offline'}]})});
    },
    restart(fingerprint=policyFingerprint){db.close();ledger.close();db=openDb(dbPath);ledger=new SpendLedger(ledgerPath);
      deps.db=db;deps.spend=ledger;deps.codingTrial=controller(fingerprint);},
    crashBeforeCompletion(){const live=deps.codingTrial!;deps.codingTrial={assertCodingAction:action=>live.assertCodingAction(action),
      admit(input){const admitted=live.admit(input);return {...admitted,complete(){throw new Error('offline simulated process interruption');}};},
    } satisfies CodingTrial;},
    cleanup(){coding.mockRestore();comment.mockRestore();classify.mockRestore();db.close();ledger.close();rmSync(directory,{recursive:true,force:true});expect(forbiddenNetwork).toBe(0);},
  };
}
let f:ReturnType<typeof makeFixture>;
beforeEach(()=>{f=makeFixture();});
afterEach(()=>f.cleanup());

for (const knownUsage of [true, false]) test(`cleanup fence closes canonical action/claim without releasing ${knownUsage ? 'settled' : 'unknown'} liability or reopening after restart`, async () => {
  expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
  let charge = 0;
  f.coding.mockImplementation(async () => {
    if (knownUsage) await f.fakeModel(true);
    else await expect(f.fakeModel(false)).rejects.toThrow();
    charge = f.ledger().status(f.issue.id)!.chargedMicros;
    throw new ExecutorCleanupUncertainError(Object.freeze({container:'gary-exec-offline-fixture',
      reason:'removal_failed',exitCode:1,timedOut:false}));
  });
  expect((await tick(f.deps)).actionsTaken).toEqual(['start_coding']);
  expect(f.actions()[1]).toMatchObject({action_type:'start_coding',success:0,outcome:'error'});
  expect(f.actions()[1]!.completed_at).not.toBeNull();
  expect(f.claim()?.phase).toBe('closed');
  expect(f.ledger().status(f.issue.id)).toMatchObject({state:'closed',attemptCount:1,chargedMicros:charge,unknownAttempts:knownUsage ? 0 : 1});
  expect(f.publications()).toBe(0);
  const actions=f.actions(); f.restart(); f.issue.description+=' changed human context';
  expect((await tick(f.deps)).actionsTaken).toEqual([]);
  expect(f.actions()).toEqual(actions); expect(f.coding).toHaveBeenCalledTimes(1); expect(f.fakeRequests()).toBe(1);
  expect(f.ledger().status(f.issue.id)).toMatchObject({state:'closed',chargedMicros:charge,unknownAttempts:knownUsage ? 0 : 1});
});

describe('durable coding trial through the actual dispatcher, offline only',()=>{
  test('good classification permits exactly one coding action and closes the same real ledger',async()=>{
    f.classify.mockImplementation(async()=>{expect((await f.fakeModel()).status).toBe(200);return {...classification};});
    f.comment.mockImplementation(async()=>{expect((await f.fakeModel()).status).toBe(200);return 'offline classification';});
    expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
    expect(f.actions()).toHaveLength(1);expect(f.actions()[0]).toMatchObject({action_type:'classify',success:1,outcome:'handled'});
    expect(f.claim()).toMatchObject({phase:'classified',classify_action:f.actions()[0]!.id,code_action:null});
    expect(f.ledger().status(f.issue.id)).toMatchObject({state:'active',attemptCount:2,unknownAttempts:0});
    const handler=f.coding.getMockImplementation()!;
    f.coding.mockImplementation(async(deps,args)=>{expect((await f.fakeModel()).status).toBe(200);return handler(deps,args);});
    expect((await tick(f.deps)).actionsTaken).toEqual(['start_coding']);
    expect(f.actions()).toHaveLength(2);expect(f.actions()[1]).toMatchObject({action_type:'start_coding',success:1,outcome:'pr_opened'});
    expect(f.actions().every(row=>row.completed_at!==null)).toBe(true);
    expect(f.claim()).toMatchObject({phase:'closed',code_action:f.actions()[1]!.id});
    expect(f.ledger().status(f.issue.id)).toMatchObject({state:'closed',terminalReason:'pr_opened',attemptCount:3,unknownAttempts:0});
    expect(f.publications()).toBe(1);expect(()=>f.admission()!.assertActive()).toThrow('canonical_action_inactive');
    const before=f.actions();f.restart();f.issue.description+=' new human context';
    expect((await tick(f.deps)).actionsTaken).toEqual([]);expect(f.actions()).toEqual(before);
    expect(f.classify).toHaveBeenCalledTimes(1);expect(f.coding).toHaveBeenCalledTimes(1);expect(f.fakeRequests()).toBe(3);
  });

  for(const kind of ['low-confidence','ANSWER','BOUNCE','large','rate-limit','failure'] as const) test(kind+' classification consumes the trial and cannot rerun after restart',async()=>{
    if(kind==='rate-limit')f.classify.mockRejectedValue(new AllProvidersExhaustedError(null));
    else if(kind==='failure')f.classify.mockRejectedValue(new Error('offline classifier failure'));
    else f.classify.mockResolvedValue({...classification,classification:kind==='ANSWER'||kind==='BOUNCE'?kind:'CODE',
      confidence:kind==='low-confidence'?.1:.99,scope:kind==='large'?'L':'S'});
    expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
    expect(f.claim()?.phase).toBe('closed');expect(f.actions()).toHaveLength(1);
    expect(f.actions()[0]?.completed_at).not.toBeNull();
    if(kind==='rate-limit')expect(f.actions()[0]).toMatchObject({success:0,outcome:'rate_limited'});
    expect(f.ledger().status(f.issue.id)).toMatchObject({state:'closed',terminalReason:'coding_trial_closed',attemptCount:0});
    const before=f.actions();f.restart();f.issue.description+=' corrected human context';
    expect((await tick(f.deps)).actionsTaken).toEqual([]);expect((await tick(f.deps)).actionsTaken).toEqual([]);
    expect(f.actions()).toEqual(before);expect(f.classify).toHaveBeenCalledTimes(1);expect(f.coding).not.toHaveBeenCalled();
  });

  for(const phase of ['classify','start_coding'] as const) test('interruption after '+phase+' admission leaves a durable claim that cannot create another action',async()=>{
    if(phase==='start_coding')expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
    f.crashBeforeCompletion();expect((await tick(f.deps)).actionsTaken).toEqual([]);
    const before=f.actions();expect(before.at(-1)).toMatchObject({action_type:phase,completed_at:null,success:null});
    expect(f.claim()?.phase).toBe(phase==='classify'?'classifying':'coding');expect(f.ledger().status(f.issue.id)?.state).toBe('active');
    f.restart();expect((await tick(f.deps)).actionsTaken).toEqual([]);expect((await tick(f.deps)).actionsTaken).toEqual([]);
    expect(f.actions()).toEqual(before);expect(f.classify).toHaveBeenCalledTimes(1);expect(f.coding).toHaveBeenCalledTimes(phase==='classify'?0:1);
    expect(f.ledger().status(f.issue.id)?.terminalReason).toBe('coding_trial_admission_denied');
  });

  for(const change of ['policy','human-context','newer-action'] as const) test('stale '+change+' blocks coding before a fresh action row is inserted',async()=>{
    expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
    if(change==='policy')f.restart('sha256:'+'b'.repeat(64));
    if(change==='human-context')f.issue.description+=' changed requirements';
    if(change==='newer-action')recordActionStart(f.db(),{ticketLinearId:f.issue.id,stateFingerprint:'newer',actionType:'classify'});
    const before=f.actions();expect((await tick(f.deps)).actionsTaken).toEqual([]);
    expect(f.actions()).toEqual(before);expect(f.coding).not.toHaveBeenCalled();expect(f.classify).toHaveBeenCalledTimes(1);
    expect(f.ledger().status(f.issue.id)?.state).toBe('closed');
  });

  test('unknown usage during coding prevents publication and closes instead of retrying',async()=>{
    expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
    let published=false;
    f.coding.mockImplementation(async deps=>{expect((await f.fakeModel(false)).status).toBe(200);
      deps.assertCanPublish!();published=true;return {status:'pr_opened',branch:'offline-trial',summary:'must not reach'};});
    expect((await tick(f.deps)).actionsTaken).toEqual(['start_coding']);
    expect(published).toBe(false);expect(f.claim()?.phase).toBe('closed');
    expect(f.actions()[1]).toMatchObject({success:0,outcome:'error'});
    expect(f.ledger().status(f.issue.id)).toMatchObject({state:'closed',unknownAttempts:1,attemptCount:1});
    const before=f.actions();f.restart();expect((await tick(f.deps)).actionsTaken).toEqual([]);expect(f.actions()).toEqual(before);
  });
});


for(const kind of ['missing','foreign','without-trial'] as const)test('executor profile '+kind+' fails before polling or action creation',async()=>{
  const poll=spyOn(f.deps.linear,'fetchAssignedIssues');
  try{
    if(kind==='missing')delete f.deps.codingExecutorProfile;
    else if(kind==='foreign')f.deps.codingExecutorProfile={...HERMES_CODING_RUNTIME_POLICY.executor};
    else delete f.deps.codingTrial;
    await expect(tick(f.deps)).rejects.toThrow('invalid_coding_executor_profile');
    expect(poll).not.toHaveBeenCalled();expect(f.actions()).toEqual([]);expect(f.classify).not.toHaveBeenCalled();expect(f.coding).not.toHaveBeenCalled();
  }finally{poll.mockRestore();}
});


test('actual dispatcher preserves the protected stacked base for the sole admitted code handler', async () => {
  f.deps.codingBase = Object.freeze({ branch: 'codex/baseline-test-repairs', commit: 'b'.repeat(40) });
  expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
  expect((await tick(f.deps)).actionsTaken).toEqual(['start_coding']);
  expect(f.coding).toHaveBeenCalledTimes(1);
  expect(f.coding.mock.calls[0]?.[0].codeBase).toBe(f.deps.codingBase);
  expect(f.fakeRequests()).toBe(0);
});


test('an unverified created draft closes the sole trial and retains its identity without retry', async () => {
  expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
  f.coding.mockImplementation(async (_deps, args) => {
    recordPr(f.db(), { githubId: 42, ticketLinearId: f.issue.id, repo, prNumber: 42, branch: 'preserved-draft' });
    return { status: 'blocked', branch: 'preserved-draft', prNumber: 42,
      prUrl: 'https://github.invalid/fixture/repo/pull/42', summary: 'Actual returned base is unverified.' };
  });
  expect((await tick(f.deps)).actionsTaken).toEqual(['start_coding']);
  expect(f.actions()[1]).toMatchObject({ action_type: 'start_coding', outcome: 'blocked' });
  expect(f.claim()?.phase).toBe('closed'); expect(f.ledger().status(f.issue.id)?.state).toBe('closed');
  expect(f.db().query('SELECT pr_number,branch FROM prs').get()).toEqual({ pr_number: 42, branch: 'preserved-draft' });
  const before = f.actions(); f.restart();
  expect((await tick(f.deps)).actionsTaken).toEqual([]); expect(f.actions()).toEqual(before);
  expect(f.coding).toHaveBeenCalledTimes(1); expect(f.fakeRequests()).toBe(0);
});


test('host cancellation before polling or between intake reads starts no canonical attempt', async () => {
  const host = new AbortController(); f.deps.signal = host.signal;
  const poll = spyOn(f.deps.linear, 'fetchAssignedIssues');
  try {
    host.abort(new Error('host stopped'));
    await expect(tick(f.deps)).rejects.toThrow('host stopped'); expect(poll).not.toHaveBeenCalled(); expect(f.actions()).toEqual([]);
    const second = new AbortController(); f.deps.signal = second.signal;
    poll.mockImplementation(async () => { second.abort(new Error('stopped during intake')); return [f.issue]; });
    await expect(tick(f.deps)).rejects.toThrow('stopped during intake'); expect(f.actions()).toEqual([]);
    expect(f.classify).not.toHaveBeenCalled(); expect(f.fakeRequests()).toBe(0);
  } finally { poll.mockRestore(); }
});

for (const stage of ['classifier', 'classification-comment'] as const) test('host stop cancels physical ' + stage + ' request, drains it, and retains unknown liability', async () => {
  const host = new AbortController(); f.deps.signal = host.signal;
  f.classify.mockImplementation(f.realClassify); f.comment.mockImplementation(f.realComment);
  const post = spyOn(f.deps.linear, 'postComment');
  let entered!: () => void, sawAbort!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const aborted = new Promise<void>(resolve => { sawAbort = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  let physicalRequests = 0, cleaned = false, settled = false;
  const transport = f.ledger().guardedFetch('deepseek', (async (input: RequestInfo | URL) => {
    const request = input as Request; physicalRequests++;
    if (stage === 'classification-comment' && physicalRequests === 1) return Response.json({
      id: 'offline-classification', type: 'message', role: 'assistant', model: 'deepseek-v4-pro',
      content: [{ type: 'text', text: JSON.stringify(classification) }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    entered();
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => { sawAbort(); resolve(); }, { once: true }));
    await drain; cleaned = true; throw new Error('offline transport aborted after cleanup');
  }) as typeof fetch);
  const provider = createProvider({ name: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'offline-only',
    baseUrl: 'https://api.deepseek.com/anthropic', defaultBackoffMs: 1000 }, { fetch: transport });
  f.deps.glm = new GLMClient(createProviderChain([provider]));
  const running = tick(f.deps).then(result => { settled = true; return result; });
  try {
    await started; const chargedBefore = f.ledger().status(f.issue.id)!.chargedMicros;
    host.abort(new Error('host stopped')); await aborted; await Bun.sleep(5);
    expect(settled).toBe(false); expect(cleaned).toBe(false); expect(f.ledger().status(f.issue.id)?.state).toBe('active');
    release(); expect((await running).actionsTaken).toEqual(['classify']); expect(cleaned).toBe(true);
    expect(f.ledger().status(f.issue.id)).toMatchObject({ state: 'closed', unknownAttempts: 1,
      chargedMicros: chargedBefore, attemptCount: stage === 'classifier' ? 1 : 2 });
    expect(f.claim()?.phase).toBe('closed'); expect(f.actions()[0]).toMatchObject({ success: 0, outcome: 'error' });
    expect(f.coding).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(stage === 'classifier' ? 1 : 2);
  } finally { host.abort(); release(); await running; post.mockRestore(); }
});

test('host stop fences a caught late result, new paid reservation, and publication', async () => {
  expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
  const host = new AbortController(); f.deps.signal = host.signal;
  f.coding.mockImplementation(async deps => {
    expect(deps.signal).toBe(host.signal); host.abort(new Error('host stopped'));
    await expect(f.fakeModel()).rejects.toThrow('host stopped');
    expect(() => deps.assertCanPublish!()).toThrow('host stopped');
    return { status: 'blocked', branch: 'offline', summary: 'caught cancellation' };
  });
  expect((await tick(f.deps)).actionsTaken).toEqual(['start_coding']);
  expect(f.fakeRequests()).toBe(0); expect(f.ledger().status(f.issue.id)).toMatchObject({ state: 'closed', attemptCount: 0 });
  expect(f.actions()[1]).toMatchObject({ success: 0, outcome: 'error' }); expect(f.claim()?.phase).toBe('closed');
});

test('runLoop awaits the current admitted cleanup and skips completed-tick callbacks after host abort', async () => {
  expect((await tick(f.deps)).actionsTaken).toEqual(['classify']);
  const host = new AbortController(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  let finished = false, callbacks = 0, cleaned = false;
  f.coding.mockImplementation(async deps => {
    expect(deps.signal).toBe(host.signal); entered();
    await new Promise<void>(resolve => deps.signal!.addEventListener('abort', () => resolve(), { once: true }));
    await drain; cleaned = true; throw new Error('host stopped');
  });
  const running = runLoop({ ...f.deps, signal: host.signal, intervalMs: 60_000, onTickComplete: () => { callbacks++; } }).then(() => { finished = true; });
  await started; host.abort(); await Bun.sleep(5); expect(finished).toBe(false);
  release(); await running;
  expect(cleaned).toBe(true); expect(callbacks).toBe(0); expect(f.coding).toHaveBeenCalledTimes(1);
  expect(f.claim()?.phase).toBe('closed'); expect(f.ledger().status(f.issue.id)?.state).toBe('closed');
});

test('only branded validated diagnostics reach terminal canonical action and never reopen the claim',async()=>{
  await tick(f.deps);
  const diagnostic={origin:'worker',code:'invalid_history_content',stage:'model_response',category:'none'} as const;
  f.coding.mockImplementation(async()=>{throw new RuntimeDiagnosticError('SECRET',diagnostic);});
  expect((await tick(f.deps)).actionsTaken).toEqual(['start_coding']);
  const row=f.db().query<{error_message:string},[]>('SELECT error_message FROM actions ORDER BY id DESC LIMIT 1').get()!;
  expect(row.error_message).toBe('coding trial stopped; diagnostic='+JSON.stringify(diagnostic));expect(row.error_message).not.toContain('SECRET');
  expect(f.actions()[1]).toMatchObject({success:0,outcome:'error'});expect(f.claim()?.phase).toBe('closed');
  expect(f.ledger().status(f.issue.id)).toMatchObject({state:'closed',attemptCount:0,unknownAttempts:0});
  f.restart();expect((await tick(f.deps)).actionsTaken).toEqual([]);expect(f.actions()).toHaveLength(2);
});
test('an arbitrary thrown object cannot smuggle diagnostic or raw exception into trial persistence',async()=>{
  await tick(f.deps);
  f.coding.mockImplementation(async()=>{throw Object.assign(new Error('SECRET'),{diagnostic:{origin:'worker',code:'SECRET',stage:'model_response',category:'none'}});});
  await tick(f.deps);
  const row=f.db().query<{error_message:string},[]>('SELECT error_message FROM actions ORDER BY id DESC LIMIT 1').get()!;
  expect(row.error_message).toBe('coding trial stopped; see bounded audit evidence');
});

test('timeout metadata reaches canonical action while its original handled status and closed claim remain unchanged',async()=>{
 await tick(f.deps);
 const diagnostic={origin:'worker',code:'deadline_exceeded',stage:'stdio_read',category:'none'} as const;
 f.coding.mockResolvedValue({status:'timeout',branch:'offline',summary:'Shared execution deadline exhausted; remaining work was stopped.',diagnostic});
 await tick(f.deps);
 const row=f.db().query<{success:number;outcome:string;error_message:string},[]>('SELECT success,outcome,error_message FROM actions ORDER BY id DESC LIMIT 1').get()!;
 expect(row).toEqual({success:1,outcome:'timeout',error_message:'coding trial stopped; diagnostic='+JSON.stringify(diagnostic)});
 expect(f.claim()?.phase).toBe('closed');expect(f.publications()).toBe(0);expect(f.fakeRequests()).toBe(0);
 f.restart();expect((await tick(f.deps)).actionsTaken).toEqual([]);
});
