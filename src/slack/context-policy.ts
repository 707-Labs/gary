/** Explicit policy-only migration. No event, session, receipt or stop can be reset here. */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { DMReplyError, type DMText } from '../hermes/dm-conversation.ts';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stateDigest(db:Database):string {
  const compactions=db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_compactions'").get()
    ? db.query('SELECT * FROM history_compactions ORDER BY event_key').all():[];
  return digest({control:db.query('SELECT id,blocked FROM control ORDER BY id').all(),
    sessions:db.query('SELECT * FROM sessions ORDER BY session_key').all(),
    events:db.query('SELECT * FROM events ORDER BY event_key').all(),
    notices:db.query('SELECT * FROM notices ORDER BY event_key').all(),compactions});
}
export interface ContextMigrationReceipt { fromFingerprint:string; toFingerprint:string; stateSha256:string; migratedAt:string }
export function migrateContextPolicy(db:Database,fromFingerprint:string,toFingerprint:string):ContextMigrationReceipt|null {
  db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
  if((db.query('PRAGMA synchronous').get() as {synchronous:number}).synchronous!==2)throw new Error('dm_context_not_durable');
  return db.transaction(()=>{
    const current=db.query('SELECT fingerprint FROM control WHERE id=1').get() as {fingerprint:string}|null;
    if(current?.fingerprint===toFingerprint)return null;
    if(current?.fingerprint!==fromFingerprint)throw new Error('dm_context_config_mismatch');
    if(db.query('SELECT 1 FROM events WHERE cleanup<>1 LIMIT 1').get())throw new Error('dm_context_migration_not_drained');
    const receipt={fromFingerprint,toFingerprint,stateSha256:stateDigest(db),migratedAt:new Date().toISOString()};
    db.exec('CREATE TABLE IF NOT EXISTS policy_migrations (id INTEGER PRIMARY KEY,from_fingerprint TEXT NOT NULL,to_fingerprint TEXT NOT NULL,state_sha256 TEXT NOT NULL,migrated_at TEXT NOT NULL,rolled_back_at TEXT)');
    // Migrations chain: a new one may start only from the state the latest
    // un-rolled-back receipt landed on (e.g. v1->v2 then v2->v3).
    const latest=db.query('SELECT to_fingerprint FROM policy_migrations WHERE rolled_back_at IS NULL ORDER BY id DESC LIMIT 1').get() as {to_fingerprint:string}|null;
    if(latest&&latest.to_fingerprint!==fromFingerprint)throw new Error('dm_context_migration_active_receipt');
    db.query('INSERT INTO policy_migrations(from_fingerprint,to_fingerprint,state_sha256,migrated_at) VALUES (?,?,?,?)').run(fromFingerprint,toFingerprint,receipt.stateSha256,receipt.migratedAt);
    db.query('UPDATE control SET fingerprint=? WHERE id=1 AND fingerprint=?').run(toFingerprint,fromFingerprint);
    if(stateDigest(db)!==receipt.stateSha256)throw new Error('dm_context_migration_changed_state');
    return receipt;
  }).immediate();
}
/** Reverse only an unused migration; once any conversation state changes, operator reconciliation is needed. */
export function rollbackContextPolicy(db:Database,fromFingerprint:string,toFingerprint:string):void {
  db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
  db.transaction(()=>{
    const rows=db.query('SELECT id,state_sha256 FROM policy_migrations WHERE from_fingerprint=? AND to_fingerprint=? AND rolled_back_at IS NULL ORDER BY id DESC LIMIT 2').all(fromFingerprint,toFingerprint) as {id:number;state_sha256:string}[];
    const row=rows.length===1?rows[0]:null;
    if(!row||(db.query('SELECT fingerprint FROM control WHERE id=1').get() as {fingerprint:string})?.fingerprint!==toFingerprint
      ||row.state_sha256!==stateDigest(db))throw new Error('dm_context_rollback_state_changed');
    db.query('UPDATE control SET fingerprint=? WHERE id=1').run(fromFingerprint);
    db.query('UPDATE policy_migrations SET rolled_back_at=? WHERE id=? AND rolled_back_at IS NULL').run(new Date().toISOString(),row.id);
  }).immediate();
}

/** Retain recent complete turns; never split a sender/answer pair or invent a model-authored summary. */
export function boundedHistory(history:readonly DMText[],text:string,maxContextBytes:number,maxReplyBytes:number):{history:DMText[];dropped:DMText[]} {
  if(!Array.isArray(history)||history.length%2||history.some((m,i)=>!m||Object.keys(m).sort().join(',')!=='content,role'
    ||m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'))throw new DMReplyError('dm_history_rejected');
  const kept=history.map(m=>({...m})),dropped:DMText[]=[];
  const fits=()=>Buffer.byteLength(JSON.stringify([...kept,{role:'user',content:text}]))+maxReplyBytes+128<=maxContextBytes;
  while(!fits()&&kept.length)dropped.push(...kept.splice(0,2));
  if(!fits())throw new DMReplyError('dm_context_limit');
  return {history:kept,dropped};
}
export function recordHistoryCompaction(db:Database,eventKey:string,sessionKey:string,before:readonly DMText[],after:readonly DMText[],dropped:readonly DMText[]):void {
  if(!dropped.length)return;
  // Same audience and private store as the original context. These are archival transcript facts, not instructions.
  db.query('INSERT INTO history_compactions VALUES (?,?,?,?,?,?,?,?)').run(eventKey,sessionKey,dropped.length,digest(before),digest(after),JSON.stringify(dropped),Buffer.byteLength(JSON.stringify(dropped)),new Date().toISOString());
}

export function replacedHistoryPrefix(before:readonly DMText[],after:readonly DMText[]):DMText[] {
  let common=0;
  while(common+2<=before.length&&common+2<=after.length
    &&JSON.stringify(before.slice(before.length-common-2,before.length-common))===JSON.stringify(after.slice(after.length-common-2,after.length-common)))common+=2;
  return before.slice(0,before.length-common).map(message=>({...message}));
}
