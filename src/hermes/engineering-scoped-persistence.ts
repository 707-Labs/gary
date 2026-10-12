/** Host-owned, audience/project scoped native data. Canonical stores are never
 * worker mounts. Every restore is a fresh copy; executable configuration and
 * process capabilities are deliberately not persistent data. */
import { Database } from 'bun:sqlite';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SpendLedger } from '../spend.ts';
import { assertStandingEngineeringTaskBudget, type StandingEngineeringTaskBudget } from './engineering-standing-budget.ts';
import { EngineeringSkillRegistry, engineeringSkillScopeKey, type EngineeringSkillScope, type EngineeringSkillSnapshot } from './engineering-skills.ts';
import { fingerprintJson } from './audit-trace.ts';
import { captureEngineeringSkillDraft, type EngineeringSkillCandidate } from './engineering-skills.ts';
import { canonicalizeConversation } from './conversation.ts';

export const ENGINEERING_SCOPED_LIMITS = Object.freeze({ sessionBytes: 16 * 1024 * 1024, sessionFiles: 256,
  scopeBytes: 256 * 1024 * 1024, historyBytes: 2 * 1024 * 1024 });
export interface EngineeringScopedPromotionResult { passed: boolean; evidenceDigest: string; attemptIds: readonly number[]; }
export interface EngineeringScopedPromotionHooks {
  modelJournalDb: Database;
  /** Existing guarded parent transport only. No separate allocation or provider. */
  evaluate(input: { taskId: string; allocationId: string; candidate: EngineeringSkillCandidate; signal: AbortSignal }): Promise<EngineeringScopedPromotionResult>;
  /** Required for non-document candidates. Must run approved sandbox checks;
   * prompt-only semantic evaluation cannot stand in for execution evidence. */
  evaluateSandbox?: EngineeringScopedPromotionHooks['evaluate'];
  /** Fresh independent context; actor identity is fixed by the host task grant. */
  review(input: { taskId: string; allocationId: string; candidate: EngineeringSkillCandidate;
    evaluation: EngineeringScopedPromotionResult; signal: AbortSignal }): Promise<EngineeringScopedPromotionResult>;
}
export interface EngineeringScopedDraftResult {
  readonly skillName: string; readonly status: 'promoted' | 'unchanged' | 'incomplete' | 'blocked';
  readonly candidateHash?: string; readonly reason?: 'evaluation_unavailable' | 'evaluation_failed' | 'review_failed' | 'budget_unavailable' | 'promotion_limit' | 'promotion_unavailable' | 'draft_rejected';
}
export interface EngineeringScopedTaskInput {
  taskId: string; sessionId: string; scope: EngineeringSkillScope; sourceRevision: string; deadlineMs: number;
  budget: StandingEngineeringTaskBudget;
  allowedCapabilities: readonly string[]; authorId: string; evaluatorId: string; reviewerId: string;
  autoPromotion: boolean;
  promotion?: EngineeringScopedPromotionHooks;
  /** Rechecks authenticated owner, immutable audience/project and current task. */
  assertCurrent(): void;
  /** Must prove native/build/child writers physically absent, not just cancelled. */
  assertQuiescent(): void;
}
export interface EngineeringScopedMaterialization {
  readonly taskId: string; readonly sessionId: string; readonly scopeKey: string;
  readonly homeDirectory: string; readonly memoryDirectory: string; readonly sessionDatabasePath: string;
  readonly approvedSkillsDirectory: string; readonly draftSkillsDirectory: string;
  readonly approvedSkillsSha256: string; readonly restoredSnapshotHash: string | null;
  readonly history: unknown;
  assertCurrent(): void;
}
export interface EngineeringScopedCheckpoint {
  readonly taskId: string; readonly sessionId: string; readonly scopeKey: string; readonly snapshotHash: string;
  readonly predecessorHash: string | null; readonly bytes: number;
}
type File = { path: string; contentBase64: string; sha256: string; size: number };
type Snapshot = { version: 1; taskId: string; sessionId: string; scopeKey: string; sourceRevision: string;
  predecessorHash: string | null; files: File[]; drafts: File[]; history: unknown; bytes: number };
type Row = { id: string; kind: string; body: string; seal: string };
const materializations = new WeakMap<object, () => void>();
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const encode = (v: unknown) => JSON.stringify(v);
function fail(code: string): never { throw Error('engineering_scoped:' + code); }
function id(v: string): string { if (typeof v !== 'string' || v.length > 160 || v.trim() !== v || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v)) fail('identity'); return v; }
function digest(v: string, length = 64): string { if (typeof v !== 'string' || v.length !== length || !/^[a-f0-9]+$/.test(v)) fail('hash'); return v; }
function sync(fn: () => void): void { if (fn() !== undefined) fail('asynchronous_guard'); }
function freeze<T>(v: T): T { if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; }
export function engineeringScopedIdentity(scope: EngineeringSkillScope): string {
  if (!scope || Object.keys(scope).sort().join(',') !== 'audienceId,projectId,surface,teamId') fail('scope');
  for (const v of [scope.teamId, scope.audienceId, scope.projectId]) id(v);
  return 'scope-' + sha(engineeringSkillScopeKey(scope));
}
function directory(path: string): Stats {
  const st = lstatSync(path);
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !st.isDirectory()
      || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) fail('directory');
  return st;
}
function ensure(path: string): void {
  directory(dirname(path));
  try { fresh(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  directory(path);
}
function fresh(path: string): void {
  directory(dirname(path)); mkdirSync(path, { mode: 0o700 });
  const fd = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function sameDir(path: string, before: Stats): void {
  const after = directory(path); if (after.dev !== before.dev || after.ino !== before.ino) fail('directory_replaced');
}
function writeImmutable(path: string, value: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
}
function bytes(path: string, limit: number): Buffer {
  const pre = lstatSync(path);
  if (!pre.isFile() || pre.isSymbolicLink() || pre.nlink !== 1 || pre.uid !== process.getuid?.()
      || (pre.mode & 0o077) !== 0 || pre.size > limit || realpathSync(path) !== path) fail('file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd); if (a.dev !== pre.dev || a.ino !== pre.ino) fail('file_changed');
    const data = readFileSync(fd), b = fstatSync(fd), c = lstatSync(path);
    if (data.length !== a.size || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs
        || b.dev !== c.dev || b.ino !== c.ino || b.size !== c.size || b.ctimeMs !== c.ctimeMs) fail('file_changed');
    return data;
  } finally { closeSync(fd); }
}
function storageBytes(path: string, limit: number): number {
  let total = 0, entries = 0;
  function walk(p: string): void {
    directory(p);
    for (const name of readdirSync(p)) {
      if (++entries > 100_000) fail('quota');
      const child = join(p, name), st = lstatSync(child);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(child);
      else { if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.()) fail('store_file'); total += st.size; }
      if (total > limit) fail('quota');
    }
  }
  walk(path); return total;
}
function snapshotFileAllowed(path: string): boolean {
  return ['hermes/memory/MEMORY.md', 'hermes/memory/USER.md', 'hermes/session.sqlite'].includes(path);
}
function draftPath(path: string): boolean {
  return typeof path === 'string' && path.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(path)
    && path.split('/').every(part => !!part && !part.startsWith('.'));
}
function captureDrafts(root: string): File[] {
  const result: File[] = []; const seen = new Set<string>(); let size = 0, entries = 0;
  function walk(path: string): void {
    directory(path);
    for (const name of readdirSync(path).sort()) {
      if (++entries > 1024) fail('draft_quota');
      const child = join(path, name), rel = relative(root, child), st = lstatSync(child);
      if (!draftPath(rel) || seen.has(rel.toLowerCase())) fail('draft_path'); seen.add(rel.toLowerCase());
      if (st.isDirectory() && !st.isSymbolicLink()) walk(child);
      else {
        if (result.length >= 32) fail('draft_quota');
        const data = bytes(child, 1024 * 1024 - size); size += data.length;
        result.push({ path: rel, contentBase64: data.toString('base64'), sha256: sha(data), size: data.length });
      }
    }
  }
  walk(root); return result;
}
export function assertEngineeringScopedMaterialization(value: EngineeringScopedMaterialization): void {
  const check = materializations.get(value); if (!check) fail('untrusted_materialization'); check();
}

export function createEngineeringScopedPersistence(options: {
  root: string; db: Database; ledger: SpendLedger; integrityKey: Uint8Array;
  limits?: Partial<Record<keyof typeof ENGINEERING_SCOPED_LIMITS, number>>; now?: () => number;
}) {
  const root = options.root, rootIdentity = directory(root), db = options.db, now = options.now ?? Date.now;
  if (!(db instanceof Database) || !(options.ledger instanceof SpendLedger) || options.integrityKey.byteLength < 32) fail('configuration');
  const limits = { ...ENGINEERING_SCOPED_LIMITS, ...options.limits };
  for (const k of Object.keys(ENGINEERING_SCOPED_LIMITS) as Array<keyof typeof limits>) {
    if (!Number.isSafeInteger(limits[k]) || limits[k] <= 0 || limits[k] > ENGINEERING_SCOPED_LIMITS[k]) fail('quota_configuration');
  }
  for (const name of ['runtime', 'sessions', 'skills', 'journals']) ensure(join(root, name));
  if (dirname(db.filename) !== join(root, 'journals')) fail('journal_path');
  const journalIdentity = lstatSync(db.filename);
  if (!journalIdentity.isFile() || journalIdentity.isSymbolicLink() || journalIdentity.nlink !== 1
      || journalIdentity.uid !== process.getuid?.() || (journalIdentity.mode & 0o077) !== 0
      || realpathSync(db.filename) !== db.filename) fail('journal_file');
  const key = Buffer.from(options.integrityKey);
  const seal = (kind: string, rid: string, body: string) => createHmac('sha256', key).update(encode([kind, rid, body])).digest('hex');
  db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS engineering_scoped_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,seal TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS engineering_scoped_no_update BEFORE UPDATE ON engineering_scoped_records BEGIN SELECT RAISE(ABORT,'immutable scoped record'); END;
    CREATE TRIGGER IF NOT EXISTS engineering_scoped_no_delete BEFORE DELETE ON engineering_scoped_records BEGIN SELECT RAISE(ABORT,'immutable scoped record'); END;`);
  const registry = new EngineeringSkillRegistry(db, key, now);
  function records(): Array<{ id: string; kind: string; value: any }> {
    return (db.query('SELECT id,kind,body,seal FROM engineering_scoped_records ORDER BY sequence').all() as Row[]).map(r => {
      digest(r.seal); if (!timingSafeEqual(Buffer.from(r.seal, 'hex'), Buffer.from(seal(r.kind, r.id, r.body), 'hex'))) fail('record_tampering');
      return { id: r.id, kind: r.kind, value: JSON.parse(r.body) };
    });
  }
  function put(kind: string, rid: string, value: unknown): void {
    const body = encode(value); db.query('INSERT INTO engineering_scoped_records(id,kind,body,seal) VALUES(?,?,?,?)').run(rid, kind, body, seal(kind, rid, body));
  }
  function head(scopeKey: string): EngineeringScopedCheckpoint | null {
    let current: EngineeringScopedCheckpoint | null = null;
    for (const row of records().filter(r => r.kind === 'checkpoint' && r.value.scopeKey === scopeKey)) {
      if (row.value.predecessorHash !== (current?.snapshotHash ?? null)) fail('broken_history'); current = row.value;
    }
    return current;
  }
  function readSnapshot(h: EngineeringScopedCheckpoint): Snapshot {
    const path = join(root, 'sessions', h.scopeKey, h.sessionId, h.snapshotHash, 'snapshot.json');
    const raw = bytes(path, limits.sessionBytes * 2 + limits.historyBytes + 131072);
    if (sha(raw) !== h.snapshotHash) fail('snapshot_hash');
    const v = JSON.parse(raw.toString('utf8')) as Snapshot;
    if (v.version !== 1 || v.taskId !== h.taskId || v.sessionId !== h.sessionId || v.scopeKey !== h.scopeKey
        || v.predecessorHash !== h.predecessorHash || v.bytes !== h.bytes || !Array.isArray(v.files) || !Array.isArray(v.drafts)
        || v.files.length + v.drafts.length > limits.sessionFiles || v.drafts.length > 32 || v.bytes > limits.sessionBytes) fail('snapshot_binding');
    let total = 0; const seen = new Set<string>();
    for (const f of v.files) {
      const data = Buffer.from(f.contentBase64, 'base64');
      if (!snapshotFileAllowed(f.path) || seen.has(f.path) || data.length !== f.size || sha(data) !== f.sha256
          || data.toString('base64') !== f.contentBase64) fail('snapshot_file');
      seen.add(f.path); total += data.length;
    }
    let draftBytes = 0; const draftNames = new Set<string>();
    for (const f of v.drafts) {
      const data = Buffer.from(f.contentBase64, 'base64');
      if (!draftPath(f.path) || draftNames.has(f.path.toLowerCase()) || data.length !== f.size || sha(data) !== f.sha256
          || data.toString('base64') !== f.contentBase64) fail('snapshot_draft');
      draftNames.add(f.path.toLowerCase()); draftBytes += data.length;
    }
    if (draftBytes > 1024 * 1024) fail('snapshot_draft'); total += draftBytes;
    if (total !== v.bytes || Buffer.byteLength(encode(v.history)) > limits.historyBytes) fail('snapshot_size');
    canonicalizeConversation(v.history);
    return v;
  }
  function bindTask(input: EngineeringScopedTaskInput) {
    const task = { ...input, scope: freeze({ ...input.scope }), allowedCapabilities: Object.freeze([...input.allowedCapabilities]) };
    id(task.taskId); id(task.sessionId); digest(task.sourceRevision, 40);
    if (!Number.isSafeInteger(task.deadlineMs)) fail('deadline');
    const scopeKey = engineeringScopedIdentity(task.scope);
    function live(): void {
      sameDir(root, rootIdentity); if (now() >= task.deadlineMs) fail('deadline'); sync(task.assertCurrent);
      const journal = lstatSync(db.filename);
      if (journal.dev !== journalIdentity.dev || journal.ino !== journalIdentity.ino || journal.nlink !== 1
          || journal.uid !== journalIdentity.uid || journal.mode !== journalIdentity.mode) fail('journal_changed');
      assertStandingEngineeringTaskBudget(task.budget, options.ledger, task.taskId, task.budget.allocationId);
    }
    live();
    const grant = { taskId: task.taskId, sessionId: task.sessionId, scope: task.scope, scopeKey,
      sourceRevision: task.sourceRevision, deadlineMs: task.deadlineMs, allocationId: task.budget.allocationId,
      allowedCapabilities: task.allowedCapabilities, authorId: task.authorId, evaluatorId: task.evaluatorId,
      reviewerId: task.reviewerId, autoPromotion: task.autoPromotion };
    for (const dir of ['sessions', 'skills']) ensure(join(root, dir, scopeKey));
    const checkQuota = (additional = 0) => {
      const all = records(), scoped = all.filter(r => r.value.scopeKey === scopeKey);
      const taskIds = new Set(scoped.filter(r => r.kind === 'task').map(r => r.value.taskId as string));
      let used = storageBytes(join(root, 'sessions', scopeKey), limits.scopeBytes)
        + storageBytes(join(root, 'skills', scopeKey), limits.scopeBytes)
        + scoped.reduce((sum, r) => sum + Buffer.byteLength(encode(r.value)) + 256, 0);
      // Validate the sealed registry before counting its candidate bodies. Failed
      // promotions remain stored and count toward the same scope's quota.
      if (taskIds.has(task.taskId)) registry.approvedSnapshot(task.taskId);
      for (const r of db.query('SELECT body FROM engineering_skill_records').all() as Array<{body:string}>) {
        if (taskIds.has(JSON.parse(r.body).taskId)) used += Buffer.byteLength(r.body) + 256;
      }
      const runtimeTasks = new Set(readdirSync(join(root, 'runtime')));
      for (const taskId of taskIds) if (runtimeTasks.has(taskId)) used += storageBytes(join(root, 'runtime', taskId), limits.scopeBytes);
      if (used + additional > limits.scopeBytes) fail('quota');
    };
    db.transaction(() => {
      live(); const old = records().find(r => r.id === 'task:' + task.taskId);
      if (old) { if (old.kind !== 'task' || encode(old.value) !== encode(grant)) fail('task_rebinding'); }
      else { registry.admitTask({ ...grant, expiresAt: task.deadlineMs }); put('task', 'task:' + task.taskId, grant); }
      checkQuota();
    }).immediate();
    const api = {
      scopeKey, grant: freeze(grant), assertCurrent: live,
      approvedSkills() { live(); return registry.approvedSnapshot(task.taskId); },
      rollbackSkill(input: { id: string; skillName: string; expectedCurrentHash: string }) {
        live(); sync(task.assertQuiescent); return registry.rollback({ ...input, taskId: task.taskId });
      },
      /** Host controller only. Native discovery gets the approved materialized
       * copy, never this registry or any canonical directory. */
      assertQuiescent() { live(); sync(task.assertQuiescent); },
      materialize(): EngineeringScopedMaterialization {
        live(); sync(task.assertQuiescent); checkQuota();
        const previous = head(scopeKey), prior = previous ? readSnapshot(previous) : null;
        const approvedBefore = registry.approvedSnapshot(task.taskId);
        checkQuota((prior?.bytes ?? 0) + approvedBefore.skills.reduce((sum, skill) => sum + skill.files.reduce((n, f) => n + f.size, 0), 0));
        const taskRoot = join(root, 'runtime', task.taskId); ensure(taskRoot);
        const target = join(taskRoot, randomUUID()); fresh(target);
        const homeDirectory = join(target, 'home'); fresh(homeDirectory);
        ensure(join(homeDirectory, 'hermes')); ensure(join(homeDirectory, 'hermes', 'memory'));
        for (const f of prior?.files ?? []) writeFileSync(join(homeDirectory, f.path), Buffer.from(f.contentBase64, 'base64'), { flag: 'wx', mode: 0o600 });
        const approvedSkillsDirectory = join(target, 'skills-approved'), draftSkillsDirectory = join(target, 'skill-drafts');
        const approved = registry.materializeTaskSkills(task.taskId, approvedSkillsDirectory, draftSkillsDirectory);
        if (prior?.taskId === task.taskId) for (const f of prior.drafts) {
          let parent = draftSkillsDirectory;
          for (const part of f.path.split('/').slice(0, -1)) { parent = join(parent, part); ensure(parent); }
          writeFileSync(join(draftSkillsDirectory, f.path), Buffer.from(f.contentBase64, 'base64'), { flag: 'wx', mode: 0o600 });
        }
        const pinned = [target, homeDirectory, join(homeDirectory, 'hermes'), join(homeDirectory, 'hermes', 'memory'), draftSkillsDirectory]
          .map(path => ({ path, identity: directory(path) }));
        const validate = () => { live(); for (const p of pinned) sameDir(p.path, p.identity); validateApproved(approved, approvedSkillsDirectory); };
        const value = freeze({ taskId: task.taskId, sessionId: task.sessionId, scopeKey, homeDirectory,
          memoryDirectory: join(homeDirectory, 'hermes', 'memory'), sessionDatabasePath: join(homeDirectory, 'hermes', 'session.sqlite'),
          approvedSkillsDirectory, draftSkillsDirectory, approvedSkillsSha256: approved.hash,
          restoredSnapshotHash: previous?.snapshotHash ?? null, history: prior?.history ?? [], assertCurrent: validate });
        materializations.set(value, validate); return value;
      },
      checkpoint(materialization: EngineeringScopedMaterialization, history: unknown): EngineeringScopedCheckpoint {
        live(); assertEngineeringScopedMaterialization(materialization); sync(task.assertQuiescent);
        if (materialization.taskId !== task.taskId || materialization.sessionId !== task.sessionId || materialization.scopeKey !== scopeKey) fail('materialization_binding');
        const serialized = encode(canonicalizeConversation(history)); if (Buffer.byteLength(serialized) > limits.historyBytes) fail('history_limit');
        const files: File[] = []; let total = 0;
        const home = materialization.homeDirectory;
        const hermes = join(home, 'hermes');
        for (const suffix of ['-wal', '-shm', '-journal']) {
          if (readdirSync(hermes).includes('session.sqlite' + suffix)) fail('session_database_not_closed');
        }
        for (const path of ['hermes/memory/MEMORY.md', 'hermes/memory/USER.md', 'hermes/session.sqlite']) {
          const parent = dirname(join(home, path));
          if (!readdirSync(parent).includes(path.split('/').at(-1)!)) continue;
          const data = bytes(join(home, path), limits.sessionBytes - total); total += data.length;
          files.push({ path, contentBase64: data.toString('base64'), sha256: sha(data), size: data.length });
        }
        const drafts = captureDrafts(materialization.draftSkillsDirectory); total += drafts.reduce((sum, f) => sum + f.size, 0);
        if (files.length + drafts.length > limits.sessionFiles || total > limits.sessionBytes) fail('session_quota');
        const snapshot: Snapshot = { version: 1, taskId: task.taskId, sessionId: task.sessionId, scopeKey,
          sourceRevision: task.sourceRevision, predecessorHash: materialization.restoredSnapshotHash,
          files, drafts, history: JSON.parse(serialized), bytes: total };
        const raw = encode(snapshot), snapshotHash = sha(raw);
        return db.transaction(() => {
          live(); sync(task.assertQuiescent); assertEngineeringScopedMaterialization(materialization);
          if ((head(scopeKey)?.snapshotHash ?? null) !== snapshot.predecessorHash) fail('stale_checkpoint');
          checkQuota(Buffer.byteLength(raw));
          const sessionRoot = join(root, 'sessions', scopeKey, task.sessionId); ensure(sessionRoot);
          const version = join(sessionRoot, snapshotHash); fresh(version);
          writeImmutable(join(version, 'snapshot.json'), raw);
          const receipt = freeze({ taskId: task.taskId, sessionId: task.sessionId, scopeKey, snapshotHash,
            predecessorHash: snapshot.predecessorHash, bytes: total });
          put('checkpoint', 'checkpoint:' + snapshotHash, receipt); checkQuota(); return receipt;
        }).immediate();
      },
      /** Retained immutable approved version; no caller-selected destination. */
      preserveApprovedVersion(snapshot: EngineeringSkillSnapshot): void {
        live(); if (engineeringScopedIdentity(snapshot.scope) !== scopeKey || snapshot.sourceRevision !== task.sourceRevision) fail('skill_scope');
        const actual = registry.approvedSnapshot(task.taskId); if (actual.hash !== snapshot.hash) fail('skill_snapshot');
        const raw = encode(actual); checkQuota(Buffer.byteLength(raw));
        const version = join(root, 'skills', scopeKey, digest(snapshot.hash));
        fresh(version); writeImmutable(join(version, 'snapshot.json'), raw);
      },
      /** Drafts never enter discovery. Host controller serializes promotion with
       * ordinary work and owns both guarded callbacks. A failed attempt remains
       * consumed; it is not silently retried after restart. */
      async promoteSkill(materialization: EngineeringScopedMaterialization, input: {
        skillName: string; expectedPredecessorHash: string | null; capabilities: readonly string[]; signal: AbortSignal;
      }): Promise<EngineeringSkillCandidate> {
        live(); sync(task.assertQuiescent); assertEngineeringScopedMaterialization(materialization);
        if (materialization.taskId !== task.taskId || materialization.scopeKey !== scopeKey || !task.autoPromotion || !task.promotion) fail('promotion_unavailable');
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.skillName) || input.skillName.trim() !== input.skillName) fail('skill_name');
        input.signal.throwIfAborted();
        const operationId = randomUUID();
        const candidate = db.transaction(() => {
          live();
          const all = records(), attempts = all.filter(r => r.kind === 'promotion_attempt' && r.value.taskId === task.taskId);
          if (attempts.some(r => !all.some(end => ['promoted:', 'blocked:'].some(prefix => end.id === prefix + r.id.slice('promotion:'.length))))) fail('promotion_busy_or_uncertain');
          if (attempts.length >= 2) fail('promotion_limit');
          const files = captureEngineeringSkillDraft(join(materialization.draftSkillsDirectory, input.skillName));
          if (files.some(f => !/\.(?:md|txt)$/i.test(f.path)) && !task.promotion!.evaluateSandbox) fail('evaluation_unavailable');
          const c = registry.createCandidate({ taskId: task.taskId, skillName: input.skillName,
            predecessorHash: input.expectedPredecessorHash, capabilities: input.capabilities,
            files });
          put('promotion_attempt', 'promotion:' + operationId, { taskId: task.taskId, allocationId: task.budget.allocationId,
            scopeKey, candidateHash: c.hash }); checkQuota(); return c;
        }).immediate();
        const allocationId = task.budget.allocationId;
        const accounting = new Database(options.ledger.databasePath, { readonly: true, create: false });
        accounting.exec('PRAGMA query_only=ON');
        const rows = () => accounting.query('SELECT a.*,r.reason,r.details_json FROM spend_attempts a LEFT JOIN spend_receipts r ON r.attempt_id=a.id WHERE a.ticket_id=? ORDER BY a.id').all(allocationId) as Array<Record<string, any>>;
        const timerSignal = AbortSignal.timeout(Math.max(1, Math.min(120_000, task.deadlineMs - now())));
        const signal = AbortSignal.any([input.signal, timerSignal]);
        async function call(stage: 'evaluation' | 'review', callback: () => Promise<EngineeringScopedPromotionResult>) {
          live(); signal.throwIfAborted(); const before = rows();
          if (before.some(r => r.state !== 'settled')) fail('unresolved_accounting');
          const modelState = () => ({ requests: task.promotion!.modelJournalDb.query('SELECT * FROM engineering_model_requests WHERE allocation_id=? ORDER BY rowid').all(allocationId),
            origins: task.promotion!.modelJournalDb.query('SELECT * FROM engineering_model_request_origins WHERE allocation_id=? ORDER BY rowid').all(allocationId) });
          const beforeModel = encode(modelState());
          let result: EngineeringScopedPromotionResult;
          try { result = await callback(); } catch (error) {
            live(); signal.throwIfAborted(); sync(task.assertQuiescent);
            const message = error instanceof Error ? error.message : '';
            if (['engineering_policy_rejected:request_limit', 'engineering_policy_rejected:headroom',
              'engineering_policy_rejected:review_already_completed'].includes(message)
                && encode(rows()) === encode(before) && encode(modelState()) === beforeModel) fail('promotion_budget_unavailable');
            throw error;
          }
          live(); signal.throwIfAborted(); sync(task.assertQuiescent);
          if (!result || typeof result.passed !== 'boolean' || Object.keys(result).sort().join(',') !== 'attemptIds,evidenceDigest,passed') fail('promotion_result');
          digest(result.evidenceDigest);
          const after = rows(), added = after.slice(before.length);
          if (encode(after.slice(0, before.length)) !== encode(before) || !Array.isArray(result.attemptIds)
              || encode(result.attemptIds) !== encode(added.map(r => r.id)) || added.length > (stage === 'evaluation' ? 2 : 1)
              || (stage === 'review' && added.length !== 1)) fail('promotion_accounting');
          for (const row of added) {
            const joined = task.promotion!.modelJournalDb.query(`SELECT r.state,r.receipt_hash,o.task_id,o.parent_session_id,o.purpose,o.context_id,
              (SELECT count(*) FROM engineering_model_request_origins x WHERE x.context_id=o.context_id) context_uses
              FROM engineering_model_requests r JOIN engineering_model_request_origins o ON o.request_id=r.request_id AND o.allocation_id=r.allocation_id
              WHERE r.allocation_id=? AND r.ledger_attempt=?`).all(allocationId, row.id) as Array<{state:string;receipt_hash:string;
                task_id:string;parent_session_id:string;purpose:string;context_id:string;context_uses:number}>;
            if (row.state !== 'settled' || row.reason !== 'accepted' || joined.length !== 1 || joined[0]!.state !== 'settled'
                || joined[0]!.receipt_hash !== fingerprintJson(row).sha256 || joined[0]!.task_id !== task.taskId
                || joined[0]!.parent_session_id !== task.sessionId || joined[0]!.purpose !== 'skill_' + stage
                || !joined[0]!.context_id || joined[0]!.context_uses !== 1) fail('promotion_receipt');
          }
          return freeze({ ...result, attemptIds: [...result.attemptIds] });
        }
        try {
          const evaluate = candidate.files.some(f => !/\.(?:md|txt)$/i.test(f.path)) ? task.promotion!.evaluateSandbox! : task.promotion!.evaluate;
          const evaluation = await call('evaluation', () => evaluate({ taskId: task.taskId, allocationId, candidate, signal }));
          const evaluationReceipt = db.transaction(() => { const receipt = registry.recordEvaluation({ id: 'eval-' + operationId, taskId: task.taskId, candidateHash: candidate.hash,
            sourceRevision: task.sourceRevision, evaluatorId: task.evaluatorId, passed: evaluation.passed,
            evidenceDigest: evaluation.evidenceDigest, expiresAt: task.deadlineMs }); checkQuota(); return receipt; }).immediate();
          if (!evaluation.passed) fail('evaluation_failed');
          const reviewed = await call('review', () => task.promotion!.review({ taskId: task.taskId, allocationId, candidate, evaluation, signal }));
          const reviewReceipt = db.transaction(() => { const receipt = registry.recordReview({ id: 'review-' + operationId, taskId: task.taskId, candidateHash: candidate.hash,
            sourceRevision: task.sourceRevision, reviewerId: task.reviewerId, approved: reviewed.passed,
            evidenceDigest: reviewed.evidenceDigest, evaluationReceiptHash: evaluationReceipt.hash, expiresAt: task.deadlineMs }); checkQuota(); return receipt; }).immediate();
          if (!reviewed.passed) fail('review_failed');
          live(); signal.throwIfAborted(); sync(task.assertQuiescent);
          const raw = encode(candidate); checkQuota(Buffer.byteLength(raw));
          const version = join(root, 'skills', scopeKey, candidate.hash); fresh(version);
          writeImmutable(join(version, 'candidate.json'), raw);
          return db.transaction(() => { const promoted = registry.activate({ id: 'promote-' + operationId, taskId: task.taskId, candidateHash: candidate.hash,
            evaluationId: evaluationReceipt.id, reviewId: reviewReceipt.id, expectedPredecessorHash: input.expectedPredecessorHash });
          put('promotion_complete', 'promoted:' + operationId, { taskId: task.taskId, allocationId, scopeKey,
            candidateHash: promoted.hash, evaluation: evaluationReceipt.hash, review: reviewReceipt.hash,
            evaluationAttempts: evaluation.attemptIds, reviewAttempts: reviewed.attemptIds });
          checkQuota(); return promoted; }).immediate();
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (['engineering_scoped:evaluation_failed', 'engineering_scoped:review_failed', 'engineering_scoped:promotion_budget_unavailable'].includes(code)) {
            db.transaction(() => { put('promotion_blocked', 'blocked:' + operationId, { taskId: task.taskId, scopeKey,
              candidateHash: candidate.hash, reason: code.slice('engineering_scoped:'.length) }); checkQuota(); }).immediate();
          }
          throw error;
        } finally { accounting.close(); }
      },
      async promoteDrafts(materialization: EngineeringScopedMaterialization, input: { signal: AbortSignal }): Promise<readonly EngineeringScopedDraftResult[]> {
        live(); sync(task.assertQuiescent); assertEngineeringScopedMaterialization(materialization);
        if (materialization.taskId !== task.taskId || materialization.scopeKey !== scopeKey) fail('materialization_binding');
        const names = readdirSync(materialization.draftSkillsDirectory).sort();
        if (names.length > 32) fail('draft_quota');
        const complete: string[] = [], results: EngineeringScopedDraftResult[] = [];
        for (const name of names) {
          if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) fail('skill_name');
          const path = join(materialization.draftSkillsDirectory, name), st = lstatSync(path);
          if (st.isSymbolicLink() || !st.isDirectory()) fail('draft_path'); directory(path);
          if (!readdirSync(path).includes('SKILL.md')) results.push({ skillName: name, status: 'incomplete' });
          else complete.push(name);
        }
        if (complete.length > 2) return freeze(complete.map(skillName => ({ skillName, status: 'blocked' as const, reason: 'promotion_limit' as const })));
        for (const skillName of complete) {
          input.signal.throwIfAborted(); live(); sync(task.assertQuiescent);
          const previous = registry.approvedSnapshot(task.taskId).skills.find(s => s.skillName === skillName);
          try {
            const files = captureEngineeringSkillDraft(join(materialization.draftSkillsDirectory, skillName));
            if (previous && encode(files.map(f => [f.path, sha(Buffer.from(f.bytes))]).sort())
                === encode(previous.files.map(f => [f.path, f.sha256]).sort())) { results.push({ skillName, status: 'unchanged' }); continue; }
            const promoted = await api.promoteSkill(materialization, { skillName, expectedPredecessorHash: previous?.hash ?? null,
              capabilities: previous?.capabilities ?? task.allowedCapabilities, signal: input.signal });
            results.push({ skillName, status: 'promoted', candidateHash: promoted.hash });
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const safe: Record<string, NonNullable<EngineeringScopedDraftResult['reason']>> = {
              'engineering_scoped:evaluation_unavailable': 'evaluation_unavailable', 'engineering_scoped:evaluation_failed': 'evaluation_failed',
              'engineering_scoped:review_failed': 'review_failed', 'engineering_scoped:promotion_budget_unavailable': 'budget_unavailable',
              'engineering_scoped:promotion_limit': 'promotion_limit', 'engineering_scoped:promotion_unavailable': 'promotion_unavailable' };
            if (!Object.hasOwn(safe, message)) throw error;
            const reason = safe[message]!;
            results.push({ skillName, status: 'blocked', reason });
          }
        }
        return freeze(results);
      },
    };
    return api;
  }
  return { bindTask };
}

function validateApproved(snapshot: EngineeringSkillSnapshot, root: string): void {
  const expected = new Map(snapshot.skills.flatMap(s => s.files.map(f => [s.skillName + '/' + f.path, f] as const)));
  let count = 0;
  function walk(path: string): void {
    directory(path);
    for (const name of readdirSync(path)) {
      const child = join(path, name), st = lstatSync(child);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(child);
      else { const f = expected.get(relative(root, child)); if (!f || ++count > expected.size || sha(bytes(child, f.size)) !== f.sha256) fail('approved_skills_changed'); }
    }
  }
  walk(root); if (count !== expected.size) fail('approved_skills_changed');
}
