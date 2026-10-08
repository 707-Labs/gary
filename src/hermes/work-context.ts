/** A read-only projection of Gary's canonical actions. No messages, prompts or secrets. */
import type { Database } from 'bun:sqlite';
import type { ProjectWorkItem } from './project-assistant.ts';

export interface WorkProject { id:string; teamKey:string; repo:string }
function recordedStatus(row:Record<string,unknown>):string {
  // A missing completion timestamp is a database observation, not process liveness.
  // Terminal authority survives an interrupted write to an older action row.
  if(row.terminal_state!==null)return ['merged','bounced','escalated'].includes(String(row.terminal_state))?String(row.terminal_state):'terminal_outcome_unknown';
  if(row.action_id===null)return 'no_recorded_action';
  if(row.completed_at===null)return row.trial_phase==='closed'?'closed_outcome_unknown':'recorded_in_progress';
  if(row.success===0)return 'failed';
  return ['delivered','escalated','handled'].includes(String(row.outcome))?String(row.outcome):'completed_outcome_unknown';
}
export function createCurrentWorkReader(db:Database, projects:readonly WorkProject[]) {
  const registry=new Map(projects.map(project=>[project.id,Object.freeze({...project})]));
  if(registry.size!==projects.length||projects.some(p=>!/^707-Labs\/[a-z0-9-]+$/.test(p.repo)||! /^[A-Z][A-Z0-9]{1,15}$/.test(p.teamKey)))throw new Error('project_work_registry_rejected');
  return async (projectId:string):Promise<readonly ProjectWorkItem[]>=>{
    const project=registry.get(projectId);if(!project)throw new Error('project_not_available');
    // The team prefix is host configuration, never caller SQL or an issue description.
    const rows=db.query(`SELECT t.linear_id,t.identifier,t.terminal_state,a.id AS action_id,a.action_type,
      a.started_at,a.completed_at,a.success,a.outcome,c.phase AS trial_phase
      FROM tickets t LEFT JOIN actions a ON a.id=(SELECT max(latest.id) FROM actions latest WHERE latest.ticket_linear_id=t.linear_id)
      LEFT JOIN hermes_coding_trials c ON c.issue_id=t.linear_id
      WHERE t.identifier LIKE ? ORDER BY a.started_at DESC,t.identifier LIMIT 12`).all(project.teamKey+'-%') as Array<Record<string,unknown>>;
    return rows.filter(row=>new RegExp('^'+project.teamKey+'-[0-9]+$').test(String(row.identifier))).map(row=>{
      const prs=db.query('SELECT pr_number,closed_at,merged FROM prs WHERE ticket_linear_id=? AND repo=? ORDER BY opened_at DESC LIMIT 3').all(row.linear_id as string,project.repo) as Array<{pr_number:number;closed_at:string|null;merged:number}>;
      const review=db.query('SELECT verdict,finding_count,escalated,created_at FROM review_passes WHERE issue_id=? ORDER BY id DESC LIMIT 1').get(row.linear_id as string) as {verdict:string;finding_count:number;escalated:number;created_at:string}|null;
      const pr=prs.find(pr=>Number.isSafeInteger(pr.pr_number)&&pr.pr_number>0);
      return {ticket:String(row.identifier),status:recordedStatus(row),
        ...(row.action_type?{action:String(row.action_type)}:{}),...(row.trial_phase?{phase:String(row.trial_phase)}:{}),
        ...(row.started_at?{startedAt:String(row.started_at)}:{}),...(row.completed_at?{completedAt:String(row.completed_at)}:{}),
        ...(pr?{pullRequestUrl:'https://github.com/'+project.repo+'/pull/'+pr.pr_number}:{}),
        checks:[{name:'Validation receipt (completion alone does not prove tests passed)',status:'not_available'},
          ...(review?[{name:'Latest recorded independent review',status:review.verdict}]:[])]};
    });
  };
}
