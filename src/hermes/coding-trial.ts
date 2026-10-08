/** One durable classify -> code trial. Composition is inert; admission owns all writes. */
import { randomUUID } from 'node:crypto';
import { HERMES_CODING_RUNTIME_POLICY } from './coding-runtime-policy.ts';
import type { DB } from '../state/db.ts';
import type { SpendLedger } from '../spend.ts';
import { recordActionStart, recordActionEnd, type ActionOutcome } from '../state/queries.ts';
import type { CodeActionAdmission } from './canonical-admission.ts';

type Claim = { issue_id:string; policy_fingerprint:string; campaign_id:string; cap_micros:number;
  phase:string; epoch:string; classify_action:number; code_action:number|null; human_signature:string;
  confidence:number|null; scope:string|null };
export interface CodingTrialAction {
  actionId:number;
  assertActive(allowPending?:boolean):void;
  complete(success:boolean,outcome:ActionOutcome,errorMessage?:string):void;
}
export interface CodingTrial {
  admit(input:{issueId:string;actionType:string;fingerprint:string;humanSignature:string;provider:string;model:string;repo:string}):CodingTrialAction;
  assertCodingAction(action:CodeActionAdmission):void;
}
export function createCodingTrial(options:{db:DB;ledger:SpendLedger;issueId:string;repo:string;policyFingerprint:string}):CodingTrial {
  const {db,ledger,issueId,repo,policyFingerprint}=options;
  const get=()=>db.query<Claim,[string]>('SELECT * FROM hermes_coding_trials WHERE issue_id=?').get(issueId);
  const reject=(reason:string):never=>{throw new Error('coding_trial_rejected:'+reason);};
  const funding=(claim?:Claim,allowPending=false)=>{
    const s=ledger.status(issueId);
    if(!s||s.state!=='active'||!s.draftPr||!ledger.hasCodingReviewReserve(issueId)||s.capMicros>HERMES_CODING_RUNTIME_POLICY.maxAllocationMicros||(s.unknownAttempts>(allowPending?1:0)))return reject('allocation');
    if(claim&&(s.campaignId!==claim.campaign_id||s.capMicros!==claim.cap_micros))return reject('allocation_changed');
    return s;
  };
  const assertClaim=(claim:Claim)=>{
    if(claim.issue_id!==issueId||claim.policy_fingerprint!==policyFingerprint)return reject('policy_changed');
    funding(claim);
  };
  return Object.freeze({
    admit(input:Parameters<CodingTrial['admit']>[0]){
      if(input.issueId!==issueId||input.repo!==repo||input.provider!=='deepseek'||input.model!=='deepseek-v4-pro'
        ||!['classify','start_coding'].includes(input.actionType))return reject('scope');
      // Per-connection durability is established even when Slack is disabled.
      db.exec('PRAGMA synchronous = FULL');
      if(db.query<{synchronous:number},[]>('PRAGMA synchronous').get()?.synchronous!==2)return reject('durability');
      const epoch=randomUUID();
      const actionId=db.transaction(()=>{
        const s=funding(); const claim=get();
        if(db.query<{n:number},[string]>("SELECT count(*) n FROM hermes_coding_trials WHERE issue_id<>? AND phase<>'closed'").get(issueId)!.n!==0)return reject('other_trial_unfinished');
        const ticket=db.query<{classification:string|null;classification_confidence:number|null;classification_scope:string|null;terminal_state:string|null},[string]>(
          'SELECT classification,classification_confidence,classification_scope,terminal_state FROM tickets WHERE linear_id=?').get(issueId);
        if(!ticket||ticket.terminal_state!==null)return reject('ticket_state');
        if(db.query<{n:number},[]>('SELECT count(*) n FROM hermes_action_owners o LEFT JOIN actions a ON a.id=o.action_id WHERE a.id IS NULL OR a.completed_at IS NULL').get()!.n!==0)return reject('unfinished_owner');
        if(input.actionType==='classify'){
          if(claim||ticket.classification!==null||db.query<{n:number},[string]>('SELECT count(*) n FROM actions WHERE ticket_linear_id=?').get(issueId)!.n!==0)return reject('already_attempted');
        }else{
          if(!claim)return reject('classification_missing'); assertClaim(claim);
          const previous=db.query<{id:number;success:number;outcome:string;completed_at:string|null},[string]>('SELECT id,success,outcome,completed_at FROM actions WHERE ticket_linear_id=? ORDER BY id DESC LIMIT 1').get(issueId);
          if(claim.phase!=='classified'||claim.code_action!==null||!previous||previous.id!==claim.classify_action||previous.success!==1||previous.outcome!=='handled'||!previous.completed_at
            ||claim.human_signature!==input.humanSignature||ticket.classification!=='CODE'||ticket.classification_confidence!==claim.confidence||ticket.classification_scope!==claim.scope)return reject('classification_changed_or_consumed');
        }
        const id=recordActionStart(db,{ticketLinearId:issueId,stateFingerprint:input.fingerprint,actionType:input.actionType,provider:input.provider,model:input.model});
        if(input.actionType==='classify')db.query('INSERT INTO hermes_coding_trials(issue_id,policy_fingerprint,campaign_id,cap_micros,phase,epoch,classify_action,human_signature) VALUES(?,?,?,?,?,?,?,?)')
          .run(issueId,policyFingerprint,s.campaignId,s.capMicros,'classifying',epoch,id,input.humanSignature);
        else db.query("UPDATE hermes_coding_trials SET phase='coding',epoch=?,code_action=? WHERE issue_id=?").run(epoch,id,issueId);
        return id;
      }).immediate();
      let finished=false;
      const assertActive=(allowPending=false)=>{
        const claim=get();
        if(finished||!claim||claim.epoch!==epoch||claim.policy_fingerprint!==policyFingerprint||claim.phase!==(input.actionType==='classify'?'classifying':'coding'))return reject('inactive');
        funding(claim,allowPending);
        const latest=db.query<{id:number;completed_at:string|null;state_fingerprint:string;provider:string;model:string},[string]>('SELECT id,completed_at,state_fingerprint,provider,model FROM actions WHERE ticket_linear_id=? ORDER BY id DESC LIMIT 1').get(issueId);
        if(!latest||latest.id!==actionId||latest.completed_at!==null||latest.state_fingerprint!==input.fingerprint||latest.provider!==input.provider||latest.model!==input.model)return reject('superseded');
      };
      return Object.freeze({actionId,assertActive,complete(success:boolean,outcome:ActionOutcome,errorMessage?:string){
        if(finished)return reject('already_completed');
        let continues=false;
        db.transaction(()=>{
          const claim=get(); if(!claim||claim.epoch!==epoch)return reject('superseded');
          if(success)assertActive();
          const t=db.query<{classification:string|null;classification_confidence:number|null;classification_scope:string|null;terminal_state:string|null},[string]>('SELECT classification,classification_confidence,classification_scope,terminal_state FROM tickets WHERE linear_id=?').get(issueId)!;
          continues=success&&outcome==='handled'&&input.actionType==='classify'&&t.classification==='CODE'&&(t.classification_confidence??0)>=0.5&&['S','M'].includes(t.classification_scope??'')&&t.terminal_state===null;
          recordActionEnd(db,{id:actionId,success,outcome,...(errorMessage===undefined?{}:{errorMessage})});
          db.query('UPDATE hermes_coding_trials SET phase=?,confidence=?,scope=? WHERE issue_id=? AND epoch=?').run(continues?'classified':'closed',t.classification_confidence,t.classification_scope,issueId,epoch);
        }).immediate();
        finished=true;
        if(!continues)ledger.markTerminal(issueId,success&&outcome==='pr_opened'?'pr_opened':'coding_trial_closed');
      }});
    },
    assertCodingAction(action:CodeActionAdmission){
      const claim=get();if(!claim||claim.phase!=='coding'||String(claim.code_action)!==action.actionId||action.ticketId!==issueId||action.repo!==repo||action.ledger!==ledger)return reject('action_binding');
      assertClaim(claim);action.assertActive();
    },
  });
}
