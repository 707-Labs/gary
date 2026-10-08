import { expect,test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { createCurrentWorkReader } from '../../src/hermes/work-context.ts';

test('current work is canonical project metadata, preserves unknown outcomes and excludes private content',async()=>{
 const db=new Database(':memory:');db.exec(readFileSync(new URL('../../src/state/schema.sql',import.meta.url),'utf8'));
 try {
  db.query('INSERT INTO tickets(linear_id,identifier) VALUES (?,?)').run('ert','ERT-2990');
  db.query('INSERT INTO tickets(linear_id,identifier) VALUES (?,?)').run('bird','BIRD-7');
  db.query("INSERT INTO actions(ticket_linear_id,action_type,state_fingerprint,started_at,completed_at,success,outcome,error_message) VALUES (?,?,'fp','2026-10-08',?,1,?,?)").run('ert','start_coding',null,'unknown','private error body');
  db.query("INSERT INTO actions(ticket_linear_id,action_type,state_fingerprint,started_at,completed_at,success,outcome,error_message) VALUES (?,?,'fp','2026-10-08','2026-10-08',1,'unknown','foreign error')").run('bird','start_coding');
  db.query("INSERT INTO prs VALUES(1,'ert','707-Labs/mulligan-labs',1380,'branch','2026-10-08',NULL,0)").run();
  db.query("INSERT INTO prs VALUES(2,'ert','foreign/private',4,'branch','2026-10-08',NULL,0)").run();
  const read=createCurrentWorkReader(db,[{id:'mulligan',teamKey:'ERT',repo:'707-Labs/mulligan-labs'}]);
  const first=await read('mulligan');expect(first).toHaveLength(1);expect(first[0]).toMatchObject({status:'recorded_in_progress',ticket:'ERT-2990',action:'start_coding'});
  expect(first[0]?.pullRequestUrl).toBe('https://github.com/707-Labs/mulligan-labs/pull/1380');
  expect(JSON.stringify(first)).not.toContain('private error');expect(JSON.stringify(first)).not.toContain('BIRD-7');expect(JSON.stringify(first)).not.toContain('foreign/private');
  db.query("UPDATE actions SET completed_at='2026-10-08T10:00:00Z' WHERE ticket_linear_id='ert'").run();
  const second=await read('mulligan');expect(second[0]?.status).toBe('completed_outcome_unknown');expect(second[0]?.checks?.[0]?.status).toBe('not_available');
  await expect(read("mulligan' OR 1=1")).rejects.toThrow('project_not_available');
 } finally {db.close();}
});

test('closed trial and terminal ticket override an unfinished action without inventing completion',async()=>{
 const db=new Database(':memory:');db.exec(readFileSync(new URL('../../src/state/schema.sql',import.meta.url),'utf8'));
 try {
  db.query("INSERT INTO tickets(linear_id,identifier) VALUES('stale','ERT-2990')").run();
  db.query("INSERT INTO actions(id,ticket_linear_id,action_type,state_fingerprint,started_at,completed_at,success,outcome) VALUES(1,'stale','classify','fp','2026-10-08','2026-10-08',1,'handled'),(2,'stale','start_coding','fp','2026-10-08',NULL,NULL,'unknown')").run();
  db.query("INSERT INTO hermes_coding_trials(issue_id,policy_fingerprint,campaign_id,cap_micros,phase,epoch,classify_action,code_action,human_signature) VALUES('stale','fp','fixture',1,'closed','fixture',1,2,'fixture')").run();
  const read=createCurrentWorkReader(db,[{id:'mulligan',teamKey:'ERT',repo:'707-Labs/mulligan-labs'}]);
  const closed=(await read('mulligan'))[0];expect(closed).toMatchObject({status:'closed_outcome_unknown',phase:'closed'});expect(closed?.completedAt).toBeUndefined();
  db.query("UPDATE tickets SET terminal_state='escalated' WHERE linear_id='stale'").run();
  expect((await read('mulligan'))[0]).toMatchObject({status:'escalated',phase:'closed'});
  db.query("UPDATE tickets SET terminal_state=NULL WHERE linear_id='stale'").run();
  db.query("UPDATE actions SET completed_at='2026-10-08T10:00:00Z',success=0,outcome='error' WHERE id=2").run();
  expect((await read('mulligan'))[0]).toMatchObject({status:'failed',phase:'closed'});
 } finally {db.close();}
});
