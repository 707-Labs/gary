import { Database } from 'bun:sqlite';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ENGINEERING_SKILL_LIMITS = Object.freeze({ files: 32, bytes: 1024 * 1024, promotionsPerTask: 2 });

/** Host-derived identity, never a model-selected scope. DM audienceId is the owner;
 * channel audienceId is the channel. Thread IDs deliberately are not scope keys. */
export interface EngineeringSkillScope {
  teamId: string;
  surface: 'private_dm' | 'shared_channel';
  audienceId: string;
  projectId: string;
}

export interface EngineeringSkillTaskGrant {
  taskId: string;
  scope: EngineeringSkillScope;
  sourceRevision: string;
  allowedCapabilities: readonly string[];
  authorId: string;
  evaluatorId: string;
  reviewerId: string;
  expiresAt: number;
  autoPromotion: boolean;
}

export interface EngineeringSkillFile {
  path: string;
  bytes: string | Uint8Array;
}

export interface EngineeringSkillStoredFile {
  readonly path: string;
  readonly contentBase64: string;
  readonly sha256: string;
  readonly size: number;
}

export interface EngineeringSkillCandidate {
  readonly hash: string;
  readonly taskId: string;
  readonly skillName: string;
  readonly scope: EngineeringSkillScope;
  readonly sourceRevision: string;
  readonly capabilities: readonly string[];
  readonly predecessorHash: string | null;
  readonly files: readonly EngineeringSkillStoredFile[];
}

export interface EngineeringSkillEvaluationInput {
  id: string;
  taskId: string;
  candidateHash: string;
  sourceRevision: string;
  evaluatorId: string;
  passed: boolean;
  evidenceDigest: string;
  expiresAt: number;
}

export interface EngineeringSkillReviewInput {
  id: string;
  taskId: string;
  candidateHash: string;
  sourceRevision: string;
  reviewerId: string;
  evaluationReceiptHash: string;
  approved: boolean;
  evidenceDigest: string;
  expiresAt: number;
}

export type EngineeringSkillReceipt<T> = Readonly<T & { hash: string }>;

export interface EngineeringSkillSnapshot {
  readonly scope: EngineeringSkillScope;
  readonly sourceRevision: string;
  readonly skills: readonly EngineeringSkillCandidate[];
  readonly hash: string;
}

type CandidateBody = Omit<EngineeringSkillCandidate, 'hash'>;
interface Event {
  id: string;
  taskId: string;
  kind: 'promotion' | 'rollback';
  scopeKey: string;
  skillName: string;
  candidateHash: string | null;
  previousHash: string | null;
  previousEventId: string | null;
  evaluationId: string | null;
  reviewId: string | null;
}
interface RecordRow { id: string; kind: string; body: string; seal: string }

function fail(message: string): never { throw new Error(`engineering skills: ${message}`); }
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/.test(value)) fail(`invalid ${label}`);
  return value;
}
function hash(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`invalid ${label}`);
  return value;
}
function source(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) fail('invalid source revision');
  return value;
}
function scope(value: EngineeringSkillScope): EngineeringSkillScope {
  if (value.surface !== 'private_dm' && value.surface !== 'shared_channel') fail('invalid surface');
  return { teamId: identifier(value.teamId, 'team'), surface: value.surface, audienceId: identifier(value.audienceId, 'audience'), projectId: identifier(value.projectId, 'project') };
}
export function engineeringSkillScopeKey(value: EngineeringSkillScope): string {
  const s = scope(value);
  return JSON.stringify([s.teamId, s.surface, s.audienceId, s.projectId]);
}
function capabilities(values: readonly string[]): string[] {
  const result = values.map(v => identifier(v, 'capability')).sort();
  if (new Set(result).size !== result.length) fail('duplicate capabilities');
  return result;
}
function subset(values: readonly string[], envelope: readonly string[]): void {
  if (values.some(v => !envelope.includes(v))) fail('capability expansion');
}
function skillName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) fail('invalid skill name');
  return value;
}
function filePath(value: string): string {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_./-]+$/.test(value)
      || value.split('/').some(p => !p || p.startsWith('.')) || isAbsolute(value)) fail('unsafe file path');
  return value;
}
function validatedFiles(files: readonly EngineeringSkillFile[]): EngineeringSkillStoredFile[] {
  if (!files.length || files.length > ENGINEERING_SKILL_LIMITS.files) fail('file count limit');
  let total = 0;
  const seen = new Set<string>();
  const result = files.map(file => {
    const path = filePath(file.path);
    const folded = path.toLowerCase();
    if (seen.has(folded)) fail('duplicate file path');
    seen.add(folded);
    if (typeof file.bytes !== 'string' && !(file.bytes instanceof Uint8Array)) fail('invalid file bytes');
    const bytes = Buffer.from(file.bytes);
    total += bytes.length;
    if (total > ENGINEERING_SKILL_LIMITS.bytes) fail('byte limit');
    if (path === 'SKILL.md') {
      try { if (!new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()) fail('empty SKILL.md'); }
      catch { fail('invalid SKILL.md'); }
    }
    return { path, contentBase64: bytes.toString('base64'), sha256: digest(bytes), size: bytes.length };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!result.some(f => f.path === 'SKILL.md')) fail('missing SKILL.md');
  for (const path of seen) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
    if (seen.has(parent)) fail('file/directory collision');
  }
  return result;
}

/** Capture a sealed, task-owned export. The caller must first stop draft writers.
 * Links, special files, changing files and oversized trees are rejected. */
export function captureEngineeringSkillDraft(directory: string): readonly EngineeringSkillFile[] {
  if (!isAbsolute(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail('invalid draft directory');
  const root = realpathSync(directory);
  const files: EngineeringSkillFile[] = [];
  let total = 0;
  let bytesCaptured = 0;
  let entries = 0;
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      if (++entries > 1024) fail('draft entry limit');
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) fail('draft contains a link');
      if (entry.isDirectory()) { filePath(relative(root, path)); walk(path); continue; }
      if (!entry.isFile() || entry.nlink !== 1) fail('draft contains a non-regular or hard-linked file');
      const relativePath = filePath(relative(root, path));
      if (++total > ENGINEERING_SKILL_LIMITS.files) fail('file count limit');
      bytesCaptured += entry.size;
      if (bytesCaptured > ENGINEERING_SKILL_LIMITS.bytes) fail('byte limit');
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(descriptor);
        if (before.dev !== entry.dev || before.ino !== entry.ino || !before.isFile()) fail('draft changed during capture');
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || bytes.length !== before.size || realpathSync(path) !== path) fail('draft changed during capture');
        files.push({ path: relativePath, bytes });
      } finally { closeSync(descriptor); }
    }
  }
  walk(root);
  validatedFiles(files);
  return files;
}

/** Host-only persistence API. Grants and receipts must come from authenticated host
 * policy/evaluation/review code, never directly from an agent tool's arguments.
 * The host owns both the injected database and a persistent >=32-byte integrity
 * key outside the sandbox. No constructor discovers paths or enables access.
 * Signatures detect changed rows; protection against restoring/deleting the whole
 * database remains the host's storage/backup responsibility. */
export class EngineeringSkillRegistry {
  private readonly key: Buffer;
  constructor(private readonly db: Database, integrityKey: Uint8Array, private readonly now: () => number = Date.now) {
    if (integrityKey.byteLength < 32) fail('integrity key must be at least 32 bytes');
    this.key = Buffer.from(integrityKey);
    db.exec(`CREATE TABLE IF NOT EXISTS engineering_skill_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, seal TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS engineering_skill_records_no_update BEFORE UPDATE ON engineering_skill_records
      BEGIN SELECT RAISE(ABORT, 'immutable engineering skill record'); END;
    CREATE TRIGGER IF NOT EXISTS engineering_skill_records_no_delete BEFORE DELETE ON engineering_skill_records
      BEGIN SELECT RAISE(ABORT, 'immutable engineering skill record'); END;`);
  }
  private seal(kind: string, id: string, body: string): string {
    return createHmac('sha256', this.key).update(canonical([kind, id, body])).digest('hex');
  }
  private put(kind: string, id: string, value: unknown): void {
    if (this.db.query('SELECT id FROM engineering_skill_records WHERE id = ?').get(id)) fail('replayed record ID');
    const body = canonical(value);
    this.db.query('INSERT INTO engineering_skill_records(id, kind, body, seal) VALUES (?, ?, ?, ?)').run(id, kind, body, this.seal(kind, id, body));
  }
  private decode<T>(row: RecordRow, kind: string): T {
    if (row.kind !== kind || !/^[a-f0-9]{64}$/.test(row.seal)
        || !timingSafeEqual(Buffer.from(row.seal, 'hex'), Buffer.from(this.seal(row.kind, row.id, row.body), 'hex'))) fail('record tampering');
    return JSON.parse(row.body) as T;
  }
  private get<T>(kind: string, id: string): T {
    const row = this.db.query('SELECT id, kind, body, seal FROM engineering_skill_records WHERE id = ?').get(id) as RecordRow | null;
    if (!row) fail(`missing ${kind}`);
    return this.decode<T>(row, kind);
  }
  private events(): Event[] {
    // Validate every row before filtering, so changing an event's kind cannot
    // hide its activation or a consumed receipt from quota/replay accounting.
    const result: Event[] = [];
    for (const row of this.db.query('SELECT id, kind, body, seal FROM engineering_skill_records ORDER BY sequence').all() as RecordRow[]) {
      const value = this.decode<unknown>(row, row.kind);
      if (row.kind === 'event') result.push(value as Event);
    }
    return result;
  }
  private grant(taskId: string): EngineeringSkillTaskGrant {
    const value = this.get<EngineeringSkillTaskGrant>('grant', `grant:${identifier(taskId, 'task')}`);
    if (this.now() >= value.expiresAt) fail('expired task grant');
    return value;
  }
  private candidate(candidateHash: string): EngineeringSkillCandidate {
    const body = this.get<CandidateBody>('candidate', `candidate:${hash(candidateHash, 'candidate hash')}`);
    if (digest(canonical(body)) !== candidateHash) fail('candidate hash mismatch');
    const files = validatedFiles(body.files.map(f => ({ path: f.path, bytes: Buffer.from(f.contentBase64, 'base64') })));
    if (canonical(files) !== canonical(body.files)) fail('candidate file tampering');
    return freeze({ ...body, hash: candidateHash });
  }
  private taskCandidate(taskId: string, candidateHash: string): { grant: EngineeringSkillTaskGrant; candidate: EngineeringSkillCandidate } {
    const grant = this.grant(taskId);
    const candidate = this.candidate(candidateHash);
    if (candidate.taskId !== taskId || engineeringSkillScopeKey(candidate.scope) !== engineeringSkillScopeKey(grant.scope)
        || candidate.sourceRevision !== grant.sourceRevision) fail('candidate task/scope/source mismatch');
    subset(candidate.capabilities, grant.allowedCapabilities);
    return { grant, candidate };
  }
  private head(scopeKey: string, name: string, events = this.events()): Event | null {
    let previous: Event | null = null;
    for (const event of events.filter(e => e.scopeKey === scopeKey && e.skillName === name)) {
      if (event.previousEventId !== (previous?.id ?? null) || event.previousHash !== (previous?.candidateHash ?? null)) fail('broken activation history');
      previous = event;
    }
    return previous;
  }
  private expiry(value: number, grant: EngineeringSkillTaskGrant): void {
    if (!Number.isSafeInteger(value) || value <= this.now() || value > grant.expiresAt) fail('invalid or expired receipt');
  }

  admitTask(input: EngineeringSkillTaskGrant): void {
    const value: EngineeringSkillTaskGrant = {
      taskId: identifier(input.taskId, 'task'), scope: scope(input.scope), sourceRevision: source(input.sourceRevision),
      allowedCapabilities: capabilities(input.allowedCapabilities), authorId: identifier(input.authorId, 'author'),
      evaluatorId: identifier(input.evaluatorId, 'evaluator'), reviewerId: identifier(input.reviewerId, 'reviewer'),
      expiresAt: input.expiresAt, autoPromotion: input.autoPromotion,
    };
    if (typeof value.autoPromotion !== 'boolean' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()) fail('invalid task grant');
    if (value.reviewerId === value.authorId || value.reviewerId === value.evaluatorId) fail('review is not independent');
    this.put('grant', `grant:${value.taskId}`, value);
  }

  createCandidate(input: { taskId: string; skillName: string; predecessorHash: string | null; capabilities: readonly string[]; files: readonly EngineeringSkillFile[] }): EngineeringSkillCandidate {
    const grant = this.grant(input.taskId);
    const required = capabilities(input.capabilities);
    subset(required, grant.allowedCapabilities);
    const body: CandidateBody = {
      taskId: grant.taskId, skillName: skillName(input.skillName), scope: grant.scope, sourceRevision: grant.sourceRevision,
      capabilities: required, predecessorHash: input.predecessorHash === null ? null : hash(input.predecessorHash, 'predecessor hash'),
      files: validatedFiles(input.files),
    };
    const current = this.head(engineeringSkillScopeKey(grant.scope), body.skillName);
    if ((current?.candidateHash ?? null) !== body.predecessorHash) fail('stale predecessor');
    if (current?.candidateHash) subset(required, this.candidate(current.candidateHash).capabilities);
    const candidateHash = digest(canonical(body));
    this.put('candidate', `candidate:${candidateHash}`, body);
    return this.candidate(candidateHash);
  }

  recordEvaluation(input: EngineeringSkillEvaluationInput): EngineeringSkillReceipt<EngineeringSkillEvaluationInput> {
    const { grant } = this.taskCandidate(input.taskId, input.candidateHash);
    identifier(input.id, 'evaluation ID'); hash(input.evidenceDigest, 'evidence digest');
    if (input.sourceRevision !== grant.sourceRevision || input.evaluatorId !== grant.evaluatorId || typeof input.passed !== 'boolean') fail('evaluation identity/source mismatch');
    this.expiry(input.expiresAt, grant);
    const receipt = { id: input.id, taskId: input.taskId, candidateHash: input.candidateHash, sourceRevision: input.sourceRevision,
      evaluatorId: input.evaluatorId, passed: input.passed, evidenceDigest: input.evidenceDigest, expiresAt: input.expiresAt };
    const value = { ...receipt, hash: digest(canonical(receipt)) };
    this.put('evaluation', `evaluation:${input.id}`, value);
    return freeze(value);
  }

  recordReview(input: EngineeringSkillReviewInput): EngineeringSkillReceipt<EngineeringSkillReviewInput> {
    const { grant } = this.taskCandidate(input.taskId, input.candidateHash);
    identifier(input.id, 'review ID'); hash(input.evidenceDigest, 'evidence digest'); hash(input.evaluationReceiptHash, 'evaluation hash');
    if (input.sourceRevision !== grant.sourceRevision || input.reviewerId !== grant.reviewerId || typeof input.approved !== 'boolean') fail('review identity/source mismatch');
    this.expiry(input.expiresAt, grant);
    const receipt = { id: input.id, taskId: input.taskId, candidateHash: input.candidateHash, sourceRevision: input.sourceRevision,
      reviewerId: input.reviewerId, evaluationReceiptHash: input.evaluationReceiptHash, approved: input.approved, evidenceDigest: input.evidenceDigest, expiresAt: input.expiresAt };
    const value = { ...receipt, hash: digest(canonical(receipt)) };
    this.put('review', `review:${input.id}`, value);
    return freeze(value);
  }

  activate(input: { id: string; taskId: string; candidateHash: string; evaluationId: string; reviewId: string; expectedPredecessorHash: string | null }): EngineeringSkillCandidate {
    return this.db.transaction(() => {
      const { grant, candidate } = this.taskCandidate(input.taskId, input.candidateHash);
      if (!grant.autoPromotion) fail('task has no standing promotion grant');
      const evaluation = this.get<EngineeringSkillReceipt<EngineeringSkillEvaluationInput>>('evaluation', `evaluation:${identifier(input.evaluationId, 'evaluation ID')}`);
      const review = this.get<EngineeringSkillReceipt<EngineeringSkillReviewInput>>('review', `review:${identifier(input.reviewId, 'review ID')}`);
      for (const receipt of [evaluation, review]) {
        const { hash: receiptHash, ...body } = receipt;
        if (digest(canonical(body)) !== receiptHash || receipt.taskId !== input.taskId || receipt.candidateHash !== candidate.hash || receipt.sourceRevision !== grant.sourceRevision) fail('receipt candidate/source mismatch');
        this.expiry(receipt.expiresAt, grant);
      }
      if (!evaluation.passed || !review.approved || review.evaluationReceiptHash !== evaluation.hash
          || evaluation.evaluatorId !== grant.evaluatorId || review.reviewerId !== grant.reviewerId) fail('candidate lacks passing independent review');
      const events = this.events();
      if (events.some(e => e.evaluationId === evaluation.id || e.reviewId === review.id)) fail('replayed promotion receipt');
      if (events.filter(e => e.taskId === input.taskId && e.kind === 'promotion').length >= ENGINEERING_SKILL_LIMITS.promotionsPerTask) fail('task promotion limit');
      const current = this.head(engineeringSkillScopeKey(grant.scope), candidate.skillName, events);
      if ((current?.candidateHash ?? null) !== input.expectedPredecessorHash || candidate.predecessorHash !== input.expectedPredecessorHash) fail('stale predecessor');
      if (current?.candidateHash) subset(candidate.capabilities, this.candidate(current.candidateHash).capabilities);
      this.put('event', `event:${identifier(input.id, 'activation ID')}`, {
        id: input.id, taskId: input.taskId, kind: 'promotion', scopeKey: engineeringSkillScopeKey(grant.scope), skillName: candidate.skillName,
        candidateHash: candidate.hash, previousHash: current?.candidateHash ?? null, previousEventId: current?.id ?? null,
        evaluationId: evaluation.id, reviewId: review.id,
      } satisfies Event);
      return candidate;
    }).immediate();
  }

  /** Roll back one approved predecessor; this safety operation does not consume
   * the promotion quota and cannot introduce an unreviewed version. */
  rollback(input: { id: string; taskId: string; skillName: string; expectedCurrentHash: string }): EngineeringSkillCandidate | null {
    return this.db.transaction(() => {
      const grant = this.grant(input.taskId);
      const name = skillName(input.skillName);
      const key = engineeringSkillScopeKey(grant.scope);
      const events = this.events();
      const current = this.head(key, name, events);
      if (!current?.candidateHash || current.candidateHash !== input.expectedCurrentHash) fail('stale rollback');
      const candidate = this.candidate(current.candidateHash);
      const target = candidate.predecessorHash === null ? null : this.candidate(candidate.predecessorHash);
      if (target) {
        if (target.sourceRevision !== grant.sourceRevision || engineeringSkillScopeKey(target.scope) !== key || target.skillName !== name
            || !events.some(e => e.kind === 'promotion' && e.scopeKey === key && e.skillName === name && e.candidateHash === target.hash)) fail('invalid rollback target');
        subset(target.capabilities, grant.allowedCapabilities);
      }
      this.put('event', `event:${identifier(input.id, 'rollback ID')}`, {
        id: input.id, taskId: input.taskId, kind: 'rollback', scopeKey: key, skillName: name,
        candidateHash: target?.hash ?? null, previousHash: current.candidateHash, previousEventId: current.id, evaluationId: null, reviewId: null,
      } satisfies Event);
      return target;
    }).immediate();
  }

  approvedSnapshot(taskId: string): EngineeringSkillSnapshot {
    const grant = this.grant(taskId);
    const key = engineeringSkillScopeKey(grant.scope);
    const events = this.events();
    const names = [...new Set(events.filter(e => e.scopeKey === key).map(e => e.skillName))].sort();
    const skills: EngineeringSkillCandidate[] = [];
    for (const name of names) {
      const current = this.head(key, name, events);
      if (!current?.candidateHash) continue;
      const candidate = this.candidate(current.candidateHash);
      if (candidate.sourceRevision !== grant.sourceRevision) fail('active skill requires evaluation for current source');
      subset(candidate.capabilities, grant.allowedCapabilities);
      skills.push(candidate);
    }
    const body = { scope: grant.scope, sourceRevision: grant.sourceRevision, skills };
    return freeze({ ...body, hash: digest(canonical(body)) });
  }

  /** Both new roots must be explicit children of existing canonical directories.
   * Mount approvedDirectory read-only in the sandbox: chmod alone is not a
   * security boundary against its owner. Drafts always begin empty and separate. */
  materializeTaskSkills(taskId: string, approvedDirectory: string, draftDirectory: string): EngineeringSkillSnapshot {
    const snapshot = this.approvedSnapshot(taskId);
    const paths = [approvedDirectory, draftDirectory].map(path => {
      if (!isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) fail('noncanonical snapshot/draft path');
      return path;
    });
    if (paths[0] === paths[1] || paths[0]!.startsWith(`${paths[1]}${sep}`) || paths[1]!.startsWith(`${paths[0]}${sep}`)) fail('snapshot/draft paths overlap');
    // Reserve both destinations before writing any approved files. Never adopt,
    // replace, or clean an existing directory or another task's work.
    mkdirSync(approvedDirectory, { mode: 0o700 });
    mkdirSync(draftDirectory, { mode: 0o700 });
    const directories = new Set([approvedDirectory]);
    for (const candidate of snapshot.skills) for (const file of candidate.files) {
      const path = join(approvedDirectory, candidate.skillName, file.path);
      for (let parent = dirname(path); parent !== dirname(approvedDirectory); parent = dirname(parent)) directories.add(parent);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(file.contentBase64, 'base64'), { flag: 'wx', mode: 0o400 });
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) chmodSync(directory, 0o500);
    return snapshot;
  }
}
