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
  expect(first[0]).toMatchObject({source:'gary_canonical_database',liveState:'unverified'});
  expect(Number.isFinite(Date.parse(first[0]!.observedAt!))).toBe(true);
  expect(first[0]?.pullRequestUrl).toBe('https://github.com/707-Labs/mulligan-labs/pull/1380');
  expect(JSON.stringify(first)).not.toContain('private error');expect(JSON.stringify(first)).not.toContain('BIRD-7');expect(JSON.stringify(first)).not.toContain('foreign/private');
  db.query("UPDATE actions SET completed_at='2026-10-08T10:00:00Z' WHERE ticket_linear_id='ert'").run();
  const second=await read('mulligan');expect(second[0]?.status).toBe('completed_outcome_unknown');expect(second[0]?.checks?.[0]?.status).toBe('not_available');
  await expect(read("mulligan' OR 1=1")).rejects.toThrow('project_not_available');
 } finally {db.close();}
});

test('old BirdUp rows and missing actions stay historical even when the projection is read now',async()=>{
 const db=new Database(':memory:');db.exec(readFileSync(new URL('../../src/state/schema.sql',import.meta.url),'utf8'));
 try {
  db.query("INSERT INTO tickets(linear_id,identifier) VALUES('old','BIRD-7'),('empty','BIRD-8'),('done','BIRD-9')").run();
  db.query("INSERT INTO actions(ticket_linear_id,action_type,state_fingerprint,started_at,completed_at,success,outcome) VALUES('old','start_coding','old-fp','2026-01-02T12:00:00.000Z',NULL,NULL,'unknown'),('done','start_coding','done-fp','2026-01-03T12:00:00.000Z','2026-01-03T12:02:00.000Z',1,'unknown')").run();
  const read=createCurrentWorkReader(db,[{id:'birdup',teamKey:'BIRD',repo:'707-Labs/birdup'}]);
  const before=Date.now(),rows=await read('birdup'),after=Date.now();
  expect(rows.find(row=>row.ticket==='BIRD-7')).toMatchObject({status:'recorded_in_progress',startedAt:'2026-01-02T12:00:00.000Z',liveState:'unverified'});
  expect(rows.find(row=>row.ticket==='BIRD-8')).toMatchObject({status:'no_recorded_action',liveState:'unverified'});
  expect(rows.find(row=>row.ticket==='BIRD-9')).toMatchObject({status:'completed_outcome_unknown',liveState:'unverified'});
  for(const row of rows){
   expect(row.source).toBe('gary_canonical_database');
   expect(Date.parse(row.observedAt!)).toBeGreaterThanOrEqual(before);
   expect(Date.parse(row.observedAt!)).toBeLessThanOrEqual(after);
   expect(row).not.toHaveProperty('canRetry');expect(row).not.toHaveProperty('workerRunning');
  }
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

test('recorded delivery and stop outcomes retain their actual meaning without becoming live health claims',async()=>{
 const db=new Database(':memory:');db.exec(readFileSync(new URL('../../src/state/schema.sql',import.meta.url),'utf8'));
 try {
  db.query("INSERT INTO tickets(linear_id,identifier) VALUES('record','ERT-1')").run();
  db.query("INSERT INTO actions(ticket_linear_id,action_type,state_fingerprint,started_at,completed_at,success,outcome) VALUES('record','start_coding','fp','2026-10-08','2026-10-08',1,'pr_opened')").run();
  const read=createCurrentWorkReader(db,[{id:'mulligan',teamKey:'ERT',repo:'707-Labs/mulligan-labs'}]);
  for(const outcome of ['pr_opened','no_changes','check_failed','review_failed','budget_exhausted']){
   db.query('UPDATE actions SET outcome=?').run(outcome);
   expect((await read('mulligan'))[0]).toMatchObject({status:outcome,liveState:'unverified'});
  }
 } finally {db.close();}
});
