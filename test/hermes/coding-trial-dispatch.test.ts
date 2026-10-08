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
import type { CodeActionAdmission } from '../../src/hermes/canonical-admission.ts';
import { tick, type LoopDeps } from '../../src/loop.ts';
import { AllProvidersExhaustedError, createProvider, createProviderChain } from '../../src/providers.ts';
import { SpendLedger } from '../../src/spend.ts';
import { openDb } from '../../src/state/db.ts';
import { recordActionStart, upsertTicket } from '../../src/state/queries.ts';

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
  ledger.createCampaign('offline-trial',10);ledger.enrollTicket('offline-trial',issue.id,5,{draftPr:true});
  let forbiddenNetwork=0,fakeRequests=0,publications=0,admission:CodeActionAdmission|undefined;
  const provider=createProvider({name:'deepseek',model:'deepseek-v4-pro',apiKey:'fake-only',baseUrl:'https://provider.invalid',defaultBackoffMs:1000},
    {fetch:(async()=>{forbiddenNetwork++;throw new Error('network forbidden in offline dispatcher test');}) as unknown as typeof fetch});
  const controller=(fingerprint=policyFingerprint)=>createCodingTrial({db,ledger,issueId:issue.id,repo,policyFingerprint:fingerprint});
  const deps:LoopDeps={db,spend:ledger,codingTrial:controller(),allowedIssueIds:new Set([issue.id]),allowedActionTypes:new Set(['classify','start_coding']),
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
  const classify=spyOn(classifier,'classifyTicket').mockResolvedValue({...classification});
  const comment=spyOn(classifier,'generateClassificationComment').mockResolvedValue('offline classification');
  const coding=spyOn(codeHandler,'runCodeHandler').mockImplementation(async(handler,args)=>{
    expect(handler.strictPublicationArtifact).toBe(true);expect(args.draftPr).toBe(true);
    expect(await handler.runAdmittedAgentLoop!({} as AgentLoopArgs)).toEqual(result);
    handler.assertCanPublish!();publications++;
    return {status:'pr_opened',branch:'offline-trial',summary:'offline only'};
  });
  return {deps,issue,classify,comment,coding,
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
