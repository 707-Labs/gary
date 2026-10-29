/** Finite, operator-funded standing pool. No existing campaign is adopted and
 * terminal unused commitments are released only with durable cleanup proof. All enrollment shares the canonical
 * spend database's SQLite writer lock; model reservations remain SpendLedger's. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { SpendLedger, codingReservePolicyVersion } from '../spend.ts';
import { fingerprintJson } from './audit-trace.ts';
import { ENGINEERING_STANDING_MIN_TASK_CAP_MICROS, engineeringStandingBudgetPolicySha256 } from './engineering-policy.ts';
import { initializeStandingReconciliation, assertStandingReconciliationSchema, standingReconciliationAmounts,
  retainStandingAuxiliaryCharges, reconcileStandingTerminal, withStandingTerminalJournal, STANDING_CHAT_TICKET, standingTaskConversationCharge } from './engineering-standing-reconciliation.ts';

export interface StandingEngineeringBudgetAuthority {
  version: 1;
  poolId: string;
  campaignId: string;
  capMicros: number;
  taskCapMicros: number;
  /** Host-verified standing user authority and a distinct funded aggregate hold. */
  authoritySha256: string;
  holdReceiptSha256: string;
}
export interface StandingEngineeringTaskBudget {
  readonly requestId: string;
  readonly requestHash: string;
  readonly taskId: string;
  readonly allocationId: string;
  readonly campaignId: string;
  readonly taskCapMicros: number;
  readonly poolCapMicros: number;
  readonly policySha256: string;
  assertCurrent(): void;
  assertReservation(reservedMicros: number): void;
}
export interface StandingEngineeringBudgetStatus {
  readonly enrolled: boolean;
  readonly poolCapMicros: number;
  readonly committedCapMicros: number;
  readonly uncommittedCapMicros: number;
  /** Includes full charged reservations and unknown holds, not just settled bills. */
  readonly chargedMicros: number;
  readonly chargedHeadroomMicros: number;
  readonly canAllocate: boolean;
  readonly grossCommittedCapMicros: number;
  readonly releasedCapMicros: number;
  readonly auxiliaryChargeMicros: number;
}
interface TaskRow { pool_id: string; request_id: string; request_hash: string; task_id: string; allocation_id: string; cap_micros: number }
const minted = new WeakMap<object, { ledgerPath: string; assert(): void }>();
const id = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
const digest = (v: unknown) => fingerprintJson(v).sha256;
function fail(code: string): never { throw new Error('engineering_standing_budget:' + code); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every(k => Object.hasOwn(descriptors,k)
    && Object.hasOwn(descriptors[k]!, 'value'));
}
function identity(path: string) {
  if (!isAbsolute(path) || realpathSync(path) !== path) fail('ledger_path');
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o022)) fail('ledger_metadata');
  return {dev:s.dev,ino:s.ino,uid:s.uid,gid:s.gid,mode:s.mode & 0o777,nlink:s.nlink};
}

export function createStandingEngineeringBudget(options: {
  ledger: SpendLedger;
  authority: StandingEngineeringBudgetAuthority;
  /** Rechecks pinned authority + distinct aggregate hold; synchronous and mandatory. */
  assertAuthority(): void;
  /** Canonical host-selected journal; never supplied by a worker or model. */
  terminalJournalPath?: string;
}) {
  if (!(options.ledger instanceof SpendLedger) || typeof options.assertAuthority !== 'function'
      || !exact(options.authority, ['version','poolId','campaignId','capMicros','taskCapMicros','authoritySha256','holdReceiptSha256'])) fail('authority');
  const a = Object.freeze(structuredClone(options.authority));
  if (a.version !== 1 || !id(a.poolId) || !id(a.campaignId) || !a.poolId.startsWith('standing-engineering-')
      || !a.campaignId.startsWith('standing-engineering-') || a.poolId === a.campaignId
      || !sha(a.authoritySha256) || !sha(a.holdReceiptSha256)
      || !Number.isSafeInteger(a.capMicros) || a.capMicros > 1_000_000_000
      || !Number.isSafeInteger(a.taskCapMicros) || a.taskCapMicros < ENGINEERING_STANDING_MIN_TASK_CAP_MICROS
      || a.taskCapMicros > a.capMicros) fail('authority');
  const ledgerPath = options.ledger.databasePath, ledgerIdentity = identity(ledgerPath), authorityHash = digest(a);
  const policySha256 = engineeringStandingBudgetPolicySha256(a.taskCapMicros);
  let closed = false;
  function guard() {
    if (closed) fail('closed');
    const result: unknown = options.assertAuthority();
    if (result !== undefined) { void Promise.resolve(result).catch(()=>{}); fail('authority_must_be_synchronous'); }
    if (options.ledger.databasePath !== ledgerPath || digest(identity(ledgerPath)) !== digest(ledgerIdentity)) fail('ledger_changed');
  }
  guard();
  const tables = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='standing_engineering_pools'").get();
  function open<T>(write: boolean, fn: (db: Database) => T): T {
    guard();
    const db = new Database(ledgerPath, {readonly:!write,create:false,strict:true});
    try {
      if (write) db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
      else db.exec('PRAGMA query_only=ON');
      return fn(db);
    } finally { db.close(); }
  }
  const retiredPool = (db: Database, poolId: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='standing_engineering_pool_retirements'").get()
    && !!db.query('SELECT 1 FROM standing_engineering_pool_retirements WHERE pool_id=?').get(poolId);
  function enrolled(db: Database): boolean {
    if (!tables(db)) return false;
    // A pool retired by a funding transfer can never allocate, converse or spend again.
    if (retiredPool(db, a.poolId)) fail('pool_retired');
    const row = db.query<{authority_hash:string;authority_json:string;ledger_identity_json:string;campaign_id:string},[string]>(
      'SELECT authority_hash,authority_json,ledger_identity_json,campaign_id FROM standing_engineering_pools WHERE pool_id=?').get(a.poolId);
    if (!row) return false;
    if (row.authority_hash !== authorityHash || digest(JSON.parse(row.authority_json)) !== authorityHash
        || row.campaign_id !== a.campaignId || digest(JSON.parse(row.ledger_identity_json)) !== digest(ledgerIdentity)) fail('pool_binding');
    const campaign = db.query<{cap_micros:number},[string]>('SELECT cap_micros FROM spend_campaigns WHERE id=?').get(a.campaignId);
    if (campaign?.cap_micros !== a.capMicros) fail('campaign_changed');
    // No external enrollments may consume this dedicated standing campaign.
    if (db.query(`SELECT 1 FROM spend_tickets t LEFT JOIN standing_engineering_allocations s ON s.allocation_id=t.ticket_id
      WHERE t.campaign_id=? AND (s.allocation_id IS NULL OR s.pool_id<>? OR s.cap_micros<>t.cap_micros OR t.draft_pr<>0) LIMIT 1`).get(a.campaignId,a.poolId)) fail('foreign_allocation');
    if (db.query(`SELECT 1 FROM standing_engineering_allocations s LEFT JOIN spend_tickets t ON t.ticket_id=s.allocation_id
      WHERE s.pool_id=? AND (t.ticket_id IS NULL OR t.campaign_id<>? OR t.cap_micros<>s.cap_micros OR s.cap_micros<>?) LIMIT 1`).get(a.poolId,a.campaignId,a.taskCapMicros)) fail('allocation_changed');
    return true;
  }
  function statusIn(db: Database): StandingEngineeringBudgetStatus {
    const exists = enrolled(db);
    const gross = exists ? db.query<{n:number},[string]>('SELECT COALESCE(SUM(cap_micros),0) n FROM spend_tickets WHERE campaign_id=?').get(a.campaignId)!.n : 0;
    const ownCharged = exists ? db.query<{n:number},[string]>(`SELECT COALESCE(SUM(x.charged_micros),0) n FROM spend_attempts x
      JOIN spend_tickets t ON t.ticket_id=x.ticket_id WHERE t.campaign_id=?`).get(a.campaignId)!.n : 0;
    const reconciled=exists?standingReconciliationAmounts(db,a):{released:0,auxiliary:0};
    const committed=gross-reconciled.released+reconciled.auxiliary,charged=ownCharged+reconciled.auxiliary;
    if (![committed,charged].every(n=>Number.isSafeInteger(n)&&n>=0) || committed > a.capMicros || charged > committed) fail('pool_accounting');
    return Object.freeze({enrolled:exists,poolCapMicros:a.capMicros,committedCapMicros:committed,
      uncommittedCapMicros:a.capMicros-committed,chargedMicros:charged,chargedHeadroomMicros:a.capMicros-charged,
      grossCommittedCapMicros:gross,releasedCapMicros:reconciled.released,auxiliaryChargeMicros:reconciled.auxiliary,
      canAllocate:exists && a.capMicros-committed >= a.taskCapMicros});
  }
  function enrollIn(db: Database): void {
        guard();
        db.exec(`CREATE TABLE IF NOT EXISTS standing_engineering_pools(pool_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL UNIQUE,
          authority_hash TEXT NOT NULL,authority_json TEXT NOT NULL,ledger_identity_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS standing_engineering_allocations(pool_id TEXT NOT NULL REFERENCES standing_engineering_pools(pool_id),
          request_id TEXT NOT NULL,request_hash TEXT NOT NULL,task_id TEXT NOT NULL UNIQUE,allocation_id TEXT NOT NULL UNIQUE REFERENCES spend_tickets(ticket_id),
          cap_micros INTEGER NOT NULL CHECK(cap_micros>0),PRIMARY KEY(pool_id,request_id));`);
        initializeStandingReconciliation(db);
        if (enrolled(db)) return;
        if (db.query('SELECT 1 FROM spend_campaigns WHERE id=?').get(a.campaignId)) fail('campaign_already_exists');
        db.query('INSERT INTO spend_campaigns(id,cap_micros) VALUES(?,?)').run(a.campaignId,a.capMicros);
        db.query('INSERT INTO standing_engineering_pools VALUES(?,?,?,?,?)').run(a.poolId,a.campaignId,authorityHash,JSON.stringify(a),JSON.stringify(ledgerIdentity));
        guard();
  }
  const allocationIdFor = (requestId: string) => {
    if (!id(requestId)) fail('request_id');
    return 'standing-engineering:' + createHash('sha256').update(JSON.stringify([a.poolId,requestId])).digest('hex');
  };
  function assertRow(db: Database, expected: TaskRow) {
    if (!enrolled(db)) fail('pool_not_enrolled');
    const row = db.query<TaskRow,[string,string]>('SELECT * FROM standing_engineering_allocations WHERE pool_id=? AND request_id=?').get(a.poolId,expected.request_id);
    if (!row || digest(row) !== digest(expected)) fail('task_binding');
    const ticket = db.query<{campaign_id:string;cap_micros:number;draft_pr:number;state:string;terminal_reason:string|null},[string]>(
      'SELECT campaign_id,cap_micros,draft_pr,state,terminal_reason FROM spend_tickets WHERE ticket_id=?').get(row.allocation_id);
    if (!ticket || ticket.campaign_id !== a.campaignId || ticket.cap_micros !== a.taskCapMicros || ticket.draft_pr !== 0
        || ticket.state !== 'active' || ticket.terminal_reason !== null
        || codingReservePolicyVersion(db,row.allocation_id)!==null) fail('task_unavailable');
    statusIn(db);
  }
  function mint(row: TaskRow): StandingEngineeringTaskBudget {
    const expected = Object.freeze({...row});
    const assertCurrent = () => open(false, db=>assertRow(db,expected));
    const value = Object.freeze({requestId:row.request_id,requestHash:row.request_hash,taskId:row.task_id,allocationId:row.allocation_id,
      campaignId:a.campaignId,taskCapMicros:a.taskCapMicros,poolCapMicros:a.capMicros,policySha256,assertCurrent,
      assertReservation(reservedMicros:number) { open(false,db=>{
        assertRow(db,expected);
        const charge=(db.query('SELECT COALESCE(SUM(charged_micros),0) n FROM spend_attempts WHERE ticket_id=?').get(row.allocation_id) as {n:number}).n;
        if(!Number.isSafeInteger(reservedMicros)||reservedMicros<0||charge+reservedMicros+standingTaskConversationCharge(db,row.allocation_id)>a.taskCapMicros)fail('task_conversation_cap');
      }); }});
    minted.set(value,{ledgerPath,assert:assertCurrent}); return value;
  }
  return {
    /** Operator-only activation after distinct funding is verified; never startup auto-enrollment. */
    enrollPool(): void { open(true, db=>db.transaction(()=>enrollIn(db)).immediate()); },
    /** Operator-only: in ONE ledger transaction, retire the transferred-from pool at
     * exactly its committed amount and enroll this pool. Refuses if the old pool
     * has an unsettled attempt, an open conversation lease, or a different commitment. */
    enrollPoolReplacing(input: { retired: StandingEngineeringBudgetAuthority; retainedMicros: number; transferReceiptSha256: string }): void {
      const r = input.retired;
      if (!exact(r, ['version','poolId','campaignId','capMicros','taskCapMicros','authoritySha256','holdReceiptSha256']) || r.poolId === a.poolId
          || r.campaignId === a.campaignId || !sha(input.transferReceiptSha256) || !Number.isSafeInteger(input.retainedMicros)
          || input.retainedMicros < 0 || input.retainedMicros + a.capMicros !== r.capMicros) fail('retirement_input');
      open(true, db=>db.transaction(()=>{
        guard();
        db.exec(`CREATE TABLE IF NOT EXISTS standing_engineering_pool_retirements(pool_id TEXT PRIMARY KEY REFERENCES standing_engineering_pools(pool_id),
          campaign_id TEXT NOT NULL,retained_micros INTEGER NOT NULL CHECK(retained_micros>=0),successor_pool_id TEXT NOT NULL,
          transfer_receipt_sha256 TEXT NOT NULL,retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
        if (retiredPool(db, r.poolId)) fail('already_retired');
        const row = db.query<{authority_hash:string;campaign_id:string},[string]>('SELECT authority_hash,campaign_id FROM standing_engineering_pools WHERE pool_id=?').get(r.poolId);
        if (!row || row.authority_hash !== digest(r) || row.campaign_id !== r.campaignId) fail('retired_pool_binding');
        if (db.query('SELECT 1 FROM standing_engineering_conversation_leases WHERE pool_id=? AND end_attempt_id IS NULL').get(r.poolId)) fail('retired_pool_conversation_open');
        if (db.query(`SELECT 1 FROM spend_attempts x JOIN spend_tickets t ON t.ticket_id=x.ticket_id WHERE t.campaign_id=? AND x.state<>'settled'`).get(r.campaignId)) fail('retired_pool_unsettled');
        const gross = db.query<{n:number},[string]>('SELECT COALESCE(SUM(cap_micros),0) n FROM spend_tickets WHERE campaign_id=?').get(r.campaignId)!.n;
        const amounts = standingReconciliationAmounts(db, r);
        if (gross - amounts.released + amounts.auxiliary !== input.retainedMicros) fail('retired_pool_commitment_changed');
        db.query('INSERT INTO standing_engineering_pool_retirements(pool_id,campaign_id,retained_micros,successor_pool_id,transfer_receipt_sha256) VALUES(?,?,?,?,?)')
          .run(r.poolId, r.campaignId, input.retainedMicros, a.poolId, input.transferReceiptSha256);
        enrollIn(db);
      }).immediate());
    },

    ready(): boolean { try { return open(false,db=>statusIn(db).canAllocate); } catch { return false; } },
    status: () => open(false,statusIn),
    /** Explicit operator action. All releases and historical auxiliary charges
     * commit together; no balance, allocation, charge or receipt is erased. */
    reconcileTerminalTasks(input:{taskIds:readonly string[];historicalChatAttemptIds:readonly number[];operatorEvidenceSha256:string}) {
      if(!options.terminalJournalPath||!exact(input,['taskIds','historicalChatAttemptIds','operatorEvidenceSha256'])
        ||!Array.isArray(input.taskIds)||input.taskIds.length>1024||new Set(input.taskIds).size!==input.taskIds.length
        ||input.taskIds.some(v=>!id(v))||!Array.isArray(input.historicalChatAttemptIds)||!sha(input.operatorEvidenceSha256))fail('reconciliation_input');
      return open(true,db=>withStandingTerminalJournal(db,options.terminalJournalPath!,ledgerPath,journalIdentity=>db.transaction(()=>{
        guard();if(!enrolled(db))fail('pool_not_enrolled');initializeStandingReconciliation(db);
        if(input.historicalChatAttemptIds.length)retainStandingAuxiliaryCharges(db,a,input.historicalChatAttemptIds,input.operatorEvidenceSha256);
        const receipts=input.taskIds.map(taskId=>reconcileStandingTerminal(db,a,taskId,journalIdentity,input.operatorEvidenceSha256));
        const status=statusIn(db);guard();return Object.freeze({receipts:Object.freeze(receipts),status});
      }).immediate()));
    },
    /** Host-owned coding conversations retain their physical API charges in the
     * same pool. The existing chat ticket and its historical receipts stay intact. */
    async withCodingConversation<T>(ticketId:string,run:()=>Promise<T>):Promise<T> {
      if(ticketId!==STANDING_CHAT_TICKET||typeof run!=='function')fail('conversation_binding');
      const lease=randomUUID();let ended=false;
      open(true,db=>db.transaction(()=>{
        guard();if(!enrolled(db))fail('pool_not_enrolled');assertStandingReconciliationSchema(db);
        if(db.query('SELECT 1 FROM standing_engineering_conversation_leases WHERE pool_id=? AND end_attempt_id IS NULL').get(a.poolId))fail('conversation_busy');
        const last=(db.query('SELECT COALESCE(MAX(id),0) n FROM spend_attempts').get() as any).n;
        db.query('INSERT INTO standing_engineering_conversation_leases(lease_id,pool_id,ticket_id,start_attempt_id) VALUES(?,?,?,?)').run(lease,a.poolId,ticketId,last);
        statusIn(db);
      }).immediate());
      const assertLease=()=>{
        if(ended)fail('conversation_closed');
        open(false,db=>{const row=db.query('SELECT * FROM standing_engineering_conversation_leases WHERE lease_id=?').get(lease) as any;
          if(!row||row.pool_id!==a.poolId||row.ticket_id!==ticketId||row.end_attempt_id!==null)fail('conversation_binding');});
      };
      try { return await options.ledger.withPaidRequestGuard(()=>assertLease(),()=>options.ledger.withReservationGuard(request=>{
        assertLease();if(request.ticketId!==ticketId)fail('conversation_foreign_request');
        // SpendLedger invokes this while holding the canonical writer lock.
        // Active lease ranges make its subsequent reservation immediately visible
        // to competing allocators before any external send is permitted.
        open(false,db=>{if(statusIn(db).uncommittedCapMicros<request.reservedMicros)fail('conversation_pool_exhausted');});
      },run)); }
      finally {
        open(true,db=>db.transaction(()=>{
          const last=(db.query('SELECT COALESCE(MAX(id),0) n FROM spend_attempts').get() as any).n;
          const result=db.query('UPDATE standing_engineering_conversation_leases SET end_attempt_id=? WHERE lease_id=? AND end_attempt_id IS NULL').run(last,lease);
          if(result.changes!==1)fail('conversation_binding');statusIn(db);guard();
        }).immediate());ended=true;
      }
    },
    allocationIdFor,
    allocate(input: {requestId:string;requestHash:string;taskId:string}): StandingEngineeringTaskBudget {
      if (!exact(input,['requestId','requestHash','taskId']) || !id(input.requestId) || !id(input.taskId) || !sha(input.requestHash)) fail('request_binding');
      const expected: TaskRow = {pool_id:a.poolId,request_id:input.requestId,request_hash:input.requestHash,task_id:input.taskId,
        allocation_id:allocationIdFor(input.requestId),cap_micros:a.taskCapMicros};
      const saved = open(true,db=>db.transaction(()=>{
        guard(); if (!enrolled(db)) fail('pool_not_enrolled');
        const old = db.query<TaskRow,[string,string]>('SELECT * FROM standing_engineering_allocations WHERE pool_id=? AND request_id=?').get(a.poolId,input.requestId);
        if (old) { if (digest(old)!==digest(expected)) fail('request_replay_mismatch'); return old; }
        if (!statusIn(db).canAllocate) fail('uncommitted_pool_exhausted');
        db.query('INSERT INTO spend_tickets(ticket_id,campaign_id,cap_micros,draft_pr) VALUES(?,?,?,0)').run(expected.allocation_id,a.campaignId,a.taskCapMicros);
        db.query('INSERT INTO standing_engineering_allocations VALUES(?,?,?,?,?,?)').run(a.poolId,input.requestId,input.requestHash,input.taskId,expected.allocation_id,a.taskCapMicros);
        if(tables(db)&&db.query("SELECT 1 FROM sqlite_master WHERE name='standing_engineering_conversation_tasks'").get()) {
          const lease=db.query('SELECT lease_id FROM standing_engineering_conversation_leases WHERE pool_id=? AND end_attempt_id IS NULL').get(a.poolId) as {lease_id:string}|null;
          if(lease)db.query('INSERT INTO standing_engineering_conversation_tasks VALUES(?,?)').run(expected.allocation_id,lease.lease_id);
        }
        assertRow(db,expected); guard(); return expected;
      }).immediate());
      return mint(saved);
    },
    assertTask(value: StandingEngineeringTaskBudget) {
      assertStandingEngineeringTaskBudget(value, options.ledger, value?.taskId, value?.allocationId);
      if (value.campaignId !== a.campaignId || value.poolCapMicros !== a.capMicros || value.taskCapMicros !== a.taskCapMicros) fail('foreign_task');
    },
    /** Closes this capability only. Never closes ledger, allocations, or releases funds. */
    close() { closed = true; },
  };
}

/** Worker-shaped objects cannot manufacture funding authority. */
export function assertStandingEngineeringTaskBudget(value: StandingEngineeringTaskBudget, ledger: SpendLedger,
  taskId: string, allocationId: string): void {
  const authority = value && minted.get(value);
  if (!authority || !(ledger instanceof SpendLedger) || authority.ledgerPath !== ledger.databasePath
      || value.taskId !== taskId || value.allocationId !== allocationId
      || value.policySha256 !== engineeringStandingBudgetPolicySha256(value.taskCapMicros)) fail('untrusted_task_budget');
  authority.assert();
}
