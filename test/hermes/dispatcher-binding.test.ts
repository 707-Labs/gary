import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AssignedIssue, LinearAdapter } from '../../src/adapters/linear.ts';
import type { GitHubClient } from '../../src/adapters/github.ts';
import { GLMClient } from '../../src/adapters/glm.ts';
import type { AgentLoopArgs } from '../../src/agent/loop.ts';
import * as codeHandler from '../../src/handlers/code.ts';
import type { AdmittedCodeLoopRunner } from '../../src/handlers/code.ts';
import type { CodeActionAdmission } from '../../src/hermes/canonical-admission.ts';
import { tick, type LoopDeps } from '../../src/loop.ts';
import { createProvider, createProviderChain } from '../../src/providers.ts';
import { openDb, type DB } from '../../src/state/db.ts';
import { recordActionStart, setClassification, upsertTicket } from '../../src/state/queries.ts';
import { openSpendLedger, type SpendLedger } from '../../src/spend.ts';

const issue: AssignedIssue = {
  id:'dispatcher-ticket',identifier:'ERT-123',title:'Offline dispatcher fixture',description:'Make one bounded change.',
  url:'https://linear.invalid/ERT-123',stateName:'Todo',stateType:'unstarted',createdAt:'2026-10-07T00:00:00Z',
  updatedAt:'2026-10-07T00:00:00Z',creatorId:null,creatorName:null,teamId:'team-one',teamKey:'ERT',blockedBy:[],
};
type ActionRow = { id:number; ticket_linear_id:string; state_fingerprint:string; action_type:string;
  provider:string; model:string; completed_at:string|null; success:number; outcome:string|null; error_message:string|null };
let db:DB, ledger:SpendLedger|undefined, deps:LoopDeps;
let coding:ReturnType<typeof spyOn<typeof codeHandler,'runCodeHandler'>>;
let networkCalls = 0;

beforeEach(()=>{
  db=openDb(':memory:'); networkCalls=0;
  upsertTicket(db,{linearId:issue.id,identifier:issue.identifier});
  setClassification(db,{linearId:issue.id,classification:'CODE',confidence:0.99,scope:'S'});
  const provider=createProvider({name:'deepseek',model:'deepseek-v4-pro',apiKey:'offline-only',baseUrl:'https://provider.invalid',defaultBackoffMs:1000},
    {fetch:(async()=>{networkCalls++;throw new Error('network forbidden in dispatcher test');}) as unknown as typeof fetch});
  deps={db,linear:{linearUserId:'gary',fetchAssignedIssues:async()=>[issue],fetchCommentMeta:async()=>[],fetchComments:async()=>[],
    postComment:async()=>{},unassign:async()=>{}} as unknown as LinearAdapter,
    github:{} as GitHubClient,glm:new GLMClient(createProviderChain([provider])),cloudflare:null,
    repoMap:new Map([['ERT','707-Labs/fixture']]),allowlistedMentionUserIds:[],reposDir:'/offline/repos',workspacesDir:'/offline/workspaces',
    agentLoopMaxIterations:5,agentLoopTimeoutMs:1000,maxCiAttempts:3,maxAttemptsPerTicket:5,circuitBreakerWindowHours:6,stalePrAfterMs:1000,
    review:{providerOrder:['deepseek'],maxRounds:1,iterationCap:1,timeoutMs:1000}};
  coding=spyOn(codeHandler,'runCodeHandler');
});
afterEach(()=>{
  coding.mockRestore();ledger?.close();ledger=undefined;db.close();expect(networkCalls).toBe(0);
});
function enroll():SpendLedger {
  ledger=openSpendLedger(':memory:');ledger.createCampaign('offline',10);ledger.enrollTicket('offline',issue.id,5,{draftPr:true});deps.spend=ledger;return ledger;
}
function rows():ActionRow[] {return db.query<ActionRow,[]>('SELECT id,ticket_linear_id,state_fingerprint,action_type,provider,model,completed_at,success,outcome,error_message FROM actions ORDER BY id').all();}
function ownerRows():{action_id:number;owner_epoch:string}[] {return db.query<{action_id:number;owner_epoch:string},[]>('SELECT action_id,owner_epoch FROM hermes_action_owners ORDER BY action_id').all();}
const offlineResult={status:'finished' as const,summary:'offline',iterations:0,inputTokens:0,outputTokens:0,cacheCreationTokens:0,cacheReadTokens:0,phase:'hermes',runLog:[]};

describe('optional Hermes factory at the actual Gary dispatcher boundary',()=>{
  test('factory receives the canonical action row, same ledger, selected route and mapped repository',async()=>{
    const spend=enroll();let admission:CodeActionAdmission|undefined, factoryCalls=0, runnerCalls=0;
    const runner:AdmittedCodeLoopRunner=async()=>{runnerCalls++;admission!.assertActive();return offlineResult;};
    deps.createAdmittedCodeLoop=value=>{
      admission=value;factoryCalls++;
      const row=rows()[0]!;
      expect(value.actionId).toBe(String(row.id));expect(value.ticketId).toBe(row.ticket_linear_id);
      expect(value.fingerprint).toBe(row.state_fingerprint);expect(value.fingerprint.length).toBeGreaterThan(0);
      expect(value.provider).toBe(row.provider);expect(value.model).toBe(row.model);
      expect(value.provider).toBe('deepseek');expect(value.model).toBe('deepseek-v4-pro');expect(value.repo).toBe('707-Labs/fixture');
      expect(value.ledger).toBe(spend);expect(value.issue).toEqual(issue);expect(value.issue).not.toBe(issue);
      expect(Object.isFrozen(value)).toBe(true);expect(Object.isFrozen(value.issue)).toBe(true);
      expect(row.action_type).toBe('start_coding');expect(row.completed_at).toBeNull();
      expect(ownerRows()).toEqual([{action_id:row.id,owner_epoch:value.ownerEpoch}]);value.assertActive();return runner;
    };
    coding.mockImplementation(async(handler,args)=>{
      expect(handler.runAdmittedAgentLoop).toBe(runner);expect(args.repo).toBe('707-Labs/fixture');expect(args.draftPr).toBe(true);
      expect(await handler.runAdmittedAgentLoop!({} as AgentLoopArgs)).toBe(offlineResult);
      handler.assertCanPublish!();return {status:'pr_opened',branch:'fixture',summary:'offline'};
    });
    expect((await tick(deps)).actionsTaken).toEqual(['start_coding']);
    expect(factoryCalls).toBe(1);expect(runnerCalls).toBe(1);expect(coding).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({success:1,outcome:'pr_opened'});expect(rows()[0]!.completed_at).not.toBeNull();
    expect(()=>admission!.assertActive()).toThrow('canonical_action_inactive');expect(spend.status(issue.id)?.attemptCount).toBe(0);
  });

  for(const funded of [false,true]) test(`omitting the factory retains legacy handler dispatch (funded=${funded})`,async()=>{
    if(funded)enroll();
    coding.mockImplementation(async handler=>{
      expect(handler.runAdmittedAgentLoop).toBeUndefined();
      if(funded)expect(()=>handler.assertCanPublish!()).not.toThrow();else expect(handler.assertCanPublish).toBeUndefined();
      return {status:'no_changes',branch:'fixture',summary:'offline'};
    });
    expect((await tick(deps)).actionsTaken).toEqual(['start_coding']);expect(coding).toHaveBeenCalledTimes(1);
    expect(rows()[0]?.outcome).toBe('no_changes');expect(ownerRows()).toEqual([]);
  });

  test('canonical owner remains active through awaited final publication then is revoked at handler completion',async()=>{
    enroll();let admission:CodeActionAdmission|undefined,publishGuard:(()=>void)|undefined;const stages:string[]=[];
    deps.createAdmittedCodeLoop=value=>{admission=value;return async()=>offlineResult;};
    coding.mockImplementation(async handler=>{
      publishGuard=handler.assertCanPublish;expect(publishGuard).toBeFunction();
      admission!.assertActive();stages.push('primary');await Promise.resolve();
      admission!.assertActive();stages.push('post-finish-check');await Promise.resolve();
      admission!.assertActive();stages.push('independent-review');await Promise.resolve();
      expect(rows()[0]!.completed_at).toBeNull();expect(()=>publishGuard!()).not.toThrow();stages.push('publication');
      return {status:'pr_opened',branch:'fixture',summary:'offline'};
    });
    await tick(deps);expect(stages).toEqual(['primary','post-finish-check','independent-review','publication']);
    expect(()=>admission!.assertActive()).toThrow('canonical_action_inactive');expect(()=>publishGuard!()).toThrow('canonical_action_inactive');
    expect(rows()[0]!.completed_at).not.toBeNull();
  });

  test('a newer action row invalidates publication even while the shared spending allocation is active',async()=>{
    const spend=enroll();let admission:CodeActionAdmission|undefined,published=false;
    deps.createAdmittedCodeLoop=value=>{admission=value;return async()=>offlineResult;};
    coding.mockImplementation(async handler=>{
      expect(()=>handler.assertCanPublish!()).not.toThrow();
      recordActionStart(db,{ticketLinearId:issue.id,stateFingerprint:'newer-fingerprint',actionType:'start_coding',provider:'deepseek',model:'deepseek-v4-pro'});
      expect(spend.status(issue.id)?.state).toBe('active');expect(()=>admission!.assertActive()).toThrow('canonical_action_superseded');
      handler.assertCanPublish!();published=true;return {status:'pr_opened',branch:'fixture',summary:'must not reach'};
    });
    expect((await tick(deps)).actionsTaken).toEqual(['start_coding']);expect(published).toBe(false);
    expect(rows()).toHaveLength(2);expect(rows()[0]).toMatchObject({success:0,outcome:'error',error_message:'canonical_action_superseded'});
    expect(rows()[0]!.completed_at).not.toBeNull();expect(rows()[1]!.completed_at).toBeNull();
    expect(()=>admission!.assertActive()).toThrow('canonical_action_inactive');expect(spend.status(issue.id)?.attemptCount).toBe(0);
  });

  test('configured factory without a ledger refuses before factory or handler execution',async()=>{
    let factoryCalls=0;deps.createAdmittedCodeLoop=()=>{factoryCalls++;return async()=>offlineResult;};
    expect((await tick(deps)).actionsTaken).toEqual(['start_coding']);expect(factoryCalls).toBe(0);expect(coding).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({success:0,outcome:'error',error_message:'Hermes requires the canonical spending ledger'});
    expect(ownerRows()).toEqual([]);
  });

  test('factory failure never falls back to legacy execution and closes the claimed owner',async()=>{
    const spend=enroll();let admission:CodeActionAdmission|undefined;
    deps.createAdmittedCodeLoop=value=>{admission=value;value.assertActive();throw new Error('offline factory failed');};
    expect((await tick(deps)).actionsTaken).toEqual(['start_coding']);expect(coding).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({success:0,outcome:'error',error_message:'offline factory failed'});expect(ownerRows()).toHaveLength(1);
    expect(()=>admission!.assertActive()).toThrow('canonical_action_inactive');expect(spend.status(issue.id)?.attemptCount).toBe(0);
  });
});
