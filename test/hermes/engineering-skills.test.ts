import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureEngineeringSkillDraft, EngineeringSkillRegistry, engineeringSkillScopeKey } from '../../src/hermes/engineering-skills.ts';
import type { EngineeringSkillCandidate, EngineeringSkillFile, EngineeringSkillScope, EngineeringSkillTaskGrant } from '../../src/hermes/engineering-skills.ts';

const sourceRevision = 'e849a0d1200b8e6f178be8a92e6478868deacb62';
const scope: EngineeringSkillScope = { teamId: 'team-test', surface: 'private_dm', audienceId: 'owner-test', projectId: 'project-test' };
const key = Buffer.alloc(32, 7);
const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    function writable(path: string): void {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) writable(join(path, entry.name));
    }
    writable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-engineering-skills-test-')));
  roots.push(root);
  const db = new Database(join(root, 'skills.sqlite'));
  databases.push(db);
  let time = 1_000;
  const registry = new EngineeringSkillRegistry(db, key, () => time);
  function admit(taskId = 'task-1', overrides: Partial<EngineeringSkillTaskGrant> = {}) {
    registry.admitTask({ taskId, scope, sourceRevision, allowedCapabilities: ['file.read', 'test.run'], authorId: 'worker', evaluatorId: 'test-host', reviewerId: 'independent-reviewer', expiresAt: 50_000, autoPromotion: true, ...overrides });
  }
  admit();
  function candidate(taskId = 'task-1', predecessorHash: string | null = null, text = '# Reliable tests\nRun the repository test command.', name = 'test-procedure', files?: EngineeringSkillFile[]): EngineeringSkillCandidate {
    return registry.createCandidate({ taskId, skillName: name, predecessorHash, capabilities: ['file.read'], files: files ?? [{ path: 'SKILL.md', bytes: text }] });
  }
  let serial = 0;
  function receipts(value: EngineeringSkillCandidate, options: { passed?: boolean; approved?: boolean; expiresAt?: number } = {}) {
    const suffix = String(++serial);
    const evaluation = registry.recordEvaluation({ id: `evaluation-${suffix}`, taskId: value.taskId, candidateHash: value.hash, sourceRevision, evaluatorId: 'test-host', passed: options.passed ?? true, evidenceDigest: 'a'.repeat(64), expiresAt: options.expiresAt ?? 40_000 });
    const review = registry.recordReview({ id: `review-${suffix}`, taskId: value.taskId, candidateHash: value.hash, sourceRevision, reviewerId: 'independent-reviewer', evaluationReceiptHash: evaluation.hash, approved: options.approved ?? true, evidenceDigest: 'b'.repeat(64), expiresAt: options.expiresAt ?? 40_000 });
    return { evaluation, review };
  }
  function promote(value: EngineeringSkillCandidate) {
    const proof = receipts(value);
    registry.activate({ id: `activation-${serial}`, taskId: value.taskId, candidateHash: value.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: value.predecessorHash });
    return proof;
  }
  return { root, db, registry, admit, candidate, receipts, promote, setTime: (value: number) => { time = value; } };
}

describe('host-managed engineering skill lifecycle', () => {
  test('drafts never autoload; approval is durable, immutable, and reusable in the same scope', () => {
    const f = fixture();
    const mutableBytes = Buffer.from('# Scoped procedure\nUse the offline fixture.');
    const candidate = f.candidate('task-1', null, '', 'fixture-guide', [{ path: 'SKILL.md', bytes: mutableBytes }, { path: 'references/example.txt', bytes: 'example' }]);
    mutableBytes.fill(0);
    expect(f.registry.approvedSnapshot('task-1').skills).toHaveLength(0);
    const evaluation = f.receipts(candidate);
    expect(f.registry.approvedSnapshot('task-1').skills).toHaveLength(0);
    f.registry.activate({ id: 'activate-first', taskId: 'task-1', candidateHash: candidate.hash, evaluationId: evaluation.evaluation.id, reviewId: evaluation.review.id, expectedPredecessorHash: null });
    f.admit('task-2');
    const reopened = new EngineeringSkillRegistry(f.db, key, () => 2_000);
    const snapshot = reopened.approvedSnapshot('task-2');
    expect(snapshot.skills[0]?.hash).toBe(candidate.hash);
    expect(Buffer.from(snapshot.skills[0]!.files.find(file => file.path === 'SKILL.md')!.contentBase64, 'base64').toString()).toBe('# Scoped procedure\nUse the offline fixture.');
    expect(Object.isFrozen(snapshot.skills[0]?.files)).toBe(true);
    expect(() => { (snapshot.skills as EngineeringSkillCandidate[]).pop(); }).toThrow();
  });

  test('hash covers exact file bytes and all file paths, with stable ordering', () => {
    const a = fixture(); const b = fixture(); const c = fixture(); const d = fixture();
    const files = [{ path: 'SKILL.md', bytes: '# A' }, { path: 'scripts/check.ts', bytes: 'return 1;\n' }];
    const first = a.candidate('task-1', null, '', 'test-procedure', files);
    const reordered = b.candidate('task-1', null, '', 'test-procedure', [...files].reverse());
    const changedBytes = c.candidate('task-1', null, '', 'test-procedure', [files[0]!, { path: 'scripts/check.ts', bytes: 'return 1;' }]);
    const changedPath = d.candidate('task-1', null, '', 'test-procedure', [files[0]!, { path: 'scripts/check.js', bytes: files[1]!.bytes }]);
    expect(reordered.hash).toBe(first.hash);
    expect(changedBytes.hash).not.toBe(first.hash);
    expect(changedPath.hash).not.toBe(first.hash);
  });

  test('every identity dimension isolates approved skills, including surface with the same audience ID', () => {
    const f = fixture(); const first = f.candidate(); f.promote(first);
    const variants: EngineeringSkillScope[] = [
      { ...scope, teamId: 'other-team' }, { ...scope, surface: 'shared_channel' },
      { ...scope, audienceId: 'other-owner' }, { ...scope, projectId: 'other-project' },
    ];
    for (const [i, variant] of variants.entries()) {
      const taskId = `isolated-${i}`;
      f.admit(taskId, { scope: variant });
      expect(f.registry.approvedSnapshot(taskId).skills).toHaveLength(0);
      expect(() => f.registry.rollback({ id: `rollback-${i}`, taskId, skillName: first.skillName, expectedCurrentHash: first.hash })).toThrow('stale rollback');
    }
    expect(engineeringSkillScopeKey(scope)).toBe('["team-test","private_dm","owner-test","project-test"]');
  });

  test('cannot self-review, substitute an evaluator, or bind evidence to a different source', () => {
    const f = fixture(); const value = f.candidate();
    expect(() => f.admit('self-review', { reviewerId: 'worker' })).toThrow('independent');
    expect(() => f.admit('evaluator-review', { reviewerId: 'test-host' })).toThrow('independent');
    const input = { id: 'evaluation-bad', taskId: 'task-1', candidateHash: value.hash, sourceRevision, evaluatorId: 'test-host', passed: true, evidenceDigest: 'a'.repeat(64), expiresAt: 30_000 };
    expect(() => f.registry.recordEvaluation({ ...input, evaluatorId: 'worker' })).toThrow('identity/source');
    expect(() => f.registry.recordEvaluation({ ...input, sourceRevision: '0'.repeat(40) })).toThrow('identity/source');
    expect(() => f.registry.recordReview({ id: 'review-self', taskId: 'task-1', candidateHash: value.hash, sourceRevision, reviewerId: 'worker', evaluationReceiptHash: 'a'.repeat(64), approved: true, evidenceDigest: 'b'.repeat(64), expiresAt: 30_000 })).toThrow('identity/source');
  });

  test('failed evaluations, rejected reviews, and mismatched evaluation evidence cannot promote', () => {
    for (const options of [{ passed: false }, { approved: false }]) {
      const f = fixture(); const value = f.candidate(); const proof = f.receipts(value, options);
      expect(() => f.registry.activate({ id: 'activation-fail', taskId: value.taskId, candidateHash: value.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: null })).toThrow('passing independent review');
      expect(f.registry.approvedSnapshot('task-1').skills).toHaveLength(0);
    }
    const f = fixture(); const value = f.candidate(); const first = f.receipts(value); const second = f.receipts(value);
    expect(() => f.registry.activate({ id: 'activation-mixed', taskId: value.taskId, candidateHash: value.hash, evaluationId: first.evaluation.id, reviewId: second.review.id, expectedPredecessorHash: null })).toThrow('passing independent review');
  });

  test('passing receipts cannot be applied to changed candidate bytes or another task', () => {
    const f = fixture(); const first = f.candidate(); const proof = f.receipts(first);
    const changed = f.candidate('task-1', null, '# Changed after review');
    expect(() => f.registry.activate({ id: 'activation-changed', taskId: 'task-1', candidateHash: changed.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: null })).toThrow('receipt candidate/source');
    f.admit('task-2');
    expect(() => f.registry.activate({ id: 'activation-other-task', taskId: 'task-2', candidateHash: first.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: null })).toThrow('task/scope/source');
  });

  test('receipt IDs, consumed proofs, and activation IDs cannot be replayed', () => {
    const f = fixture(); const value = f.candidate(); const proof = f.promote(value);
    expect(() => f.registry.recordEvaluation(proof.evaluation)).toThrow('replayed record ID');
    expect(() => f.registry.recordReview(proof.review)).toThrow('replayed record ID');
    expect(() => f.registry.activate({ id: 'activation-replay', taskId: 'task-1', candidateHash: value.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: null })).toThrow('replayed promotion receipt');
    expect(() => f.candidate()).toThrow('stale predecessor');
  });

  test('CAS prevents an overlapping task from replacing a newly promoted version', () => {
    const f = fixture(); f.admit('task-2');
    const first = f.candidate(); const overlapping = f.candidate('task-2', null, '# Parallel candidate');
    f.promote(first);
    const proof = f.receipts(overlapping);
    expect(() => f.registry.activate({ id: 'lost-race', taskId: overlapping.taskId, candidateHash: overlapping.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: null })).toThrow('stale predecessor');
    expect(f.registry.approvedSnapshot('task-2').skills[0]?.hash).toBe(first.hash);
  });

  test('two-promotion task cap survives reopening and does not prevent rollback', () => {
    const f = fixture(); const first = f.candidate(); f.promote(first);
    const second = f.candidate('task-1', first.hash, '# Second version'); f.promote(second);
    const third = f.candidate('task-1', second.hash, '# Third version'); const proof = f.receipts(third);
    const reopened = new EngineeringSkillRegistry(f.db, key, () => 2_000);
    expect(() => reopened.activate({ id: 'third-activation', taskId: 'task-1', candidateHash: third.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: second.hash })).toThrow('promotion limit');
    expect(reopened.rollback({ id: 'rollback-second', taskId: 'task-1', skillName: second.skillName, expectedCurrentHash: second.hash })?.hash).toBe(first.hash);
    expect(reopened.approvedSnapshot('task-1').skills[0]?.hash).toBe(first.hash);
    expect(() => reopened.rollback({ id: 'rollback-again', taskId: 'task-1', skillName: second.skillName, expectedCurrentHash: second.hash })).toThrow('stale rollback');
    expect(reopened.rollback({ id: 'disable-first', taskId: 'task-1', skillName: first.skillName, expectedCurrentHash: first.hash })).toBeNull();
    expect(reopened.approvedSnapshot('task-1').skills).toHaveLength(0);
    f.admit('task-new'); const replacement = f.candidate('task-new', null, '# Replacement after removal'); f.promote(replacement);
    expect(reopened.approvedSnapshot('task-new').skills[0]?.hash).toBe(replacement.hash);
  });

  test('capabilities cannot exceed the grant or grow on an existing skill', () => {
    const f = fixture(); const first = f.candidate(); f.promote(first);
    expect(() => f.registry.createCandidate({ taskId: 'task-1', skillName: first.skillName, predecessorHash: first.hash, capabilities: ['file.read', 'test.run'], files: [{ path: 'SKILL.md', bytes: '# More capabilities' }] })).toThrow('capability expansion');
    expect(() => f.registry.createCandidate({ taskId: 'task-1', skillName: 'host-access', predecessorHash: null, capabilities: ['host.sudo'], files: [{ path: 'SKILL.md', bytes: '# Access' }] })).toThrow('capability expansion');
    f.admit('task-less', { allowedCapabilities: [] });
    expect(() => f.registry.approvedSnapshot('task-less')).toThrow('capability expansion');
  });

  test('expired receipts, expired grants, and ungranted autopromotion fail closed', () => {
    const f = fixture(); const value = f.candidate(); const proof = f.receipts(value, { expiresAt: 2_000 });
    f.setTime(2_000);
    expect(() => f.registry.activate({ id: 'expired-proof', taskId: 'task-1', candidateHash: value.hash, evaluationId: proof.evaluation.id, reviewId: proof.review.id, expectedPredecessorHash: null })).toThrow('expired receipt');
    f.admit('no-promotion', { autoPromotion: false }); const ungranted = f.candidate('no-promotion', null, '# Draft only');
    expect(() => f.promote(ungranted)).toThrow('standing promotion grant');
    f.setTime(50_000);
    expect(() => f.registry.approvedSnapshot('task-1')).toThrow('expired task grant');
    expect(() => f.candidate()).toThrow('expired task grant');
  });

  test('a new host source needs new evaluation before old skills can load', () => {
    const f = fixture(); f.promote(f.candidate());
    f.admit('new-source', { sourceRevision: 'c'.repeat(40) });
    expect(() => f.registry.approvedSnapshot('new-source')).toThrow('current source');
  });

  test('SQL records reject ordinary updates/deletes and authenticated reads detect forced tampering', () => {
    const f = fixture(); const value = f.candidate(); f.promote(value);
    expect(() => f.db.exec("UPDATE engineering_skill_records SET body = '{}' WHERE kind = 'candidate'")).toThrow('immutable');
    expect(() => f.db.exec("DELETE FROM engineering_skill_records WHERE kind = 'evaluation'")).toThrow('immutable');
    f.db.exec('DROP TRIGGER engineering_skill_records_no_update');
    f.db.query("UPDATE engineering_skill_records SET body = ? WHERE kind = 'candidate'").run('{"files":[]}');
    expect(() => f.registry.approvedSnapshot('task-1')).toThrow('record tampering');
    const wrongKey = new EngineeringSkillRegistry(f.db, Buffer.alloc(32, 9), () => 1_000);
    expect(() => wrongKey.approvedSnapshot('task-1')).toThrow('record tampering');
  });

  test('changing an event type cannot hide an activation from replay/quota checks', () => {
    const f = fixture(); f.promote(f.candidate());
    f.db.exec('DROP TRIGGER engineering_skill_records_no_update');
    f.db.exec("UPDATE engineering_skill_records SET kind = 'hidden-event' WHERE kind = 'event'");
    expect(() => f.registry.approvedSnapshot('task-1')).toThrow('record tampering');
  });

  test('rejects oversized, ambiguous and unsafe file trees', () => {
    const f = fixture();
    const base = [{ path: 'SKILL.md', bytes: '# Valid' }];
    const invalid: EngineeringSkillFile[][] = [
      [], [{ path: 'references/readme.md', bytes: 'Missing entry' }], [{ path: 'SKILL.md', bytes: '' }],
      [...base, { path: '../escape', bytes: '' }], [...base, { path: '/absolute', bytes: '' }],
      [...base, { path: '.env', bytes: '' }], [...base, { path: 'scripts\\escape', bytes: '' }],
      [...base, { path: 'skill.md', bytes: 'Case collision' }],
      [...base, { path: 'references', bytes: '' }, { path: 'references/file', bytes: '' }],
      [...base, ...Array.from({ length: 32 }, (_, i) => ({ path: `references/${i}`, bytes: '' }))],
      [...base, { path: 'assets/oversized', bytes: new Uint8Array(1024 * 1024) }],
      [{ path: 'SKILL.md', bytes: new Uint8Array([0xff]) }],
    ];
    for (const files of invalid) expect(() => f.candidate('task-1', null, '', 'invalid', files)).toThrow();
    expect(f.registry.approvedSnapshot('task-1').skills).toHaveLength(0);
  });

  test('exactly 32 files and 1 MiB are accepted; one byte more is rejected', () => {
    const f = fixture();
    const files = [{ path: 'SKILL.md', bytes: '#' }, ...Array.from({ length: 30 }, (_, i) => ({ path: `assets/${i}`, bytes: '' })), { path: 'assets/large', bytes: Buffer.alloc(1024 * 1024 - 1) }];
    expect(f.candidate('task-1', null, '', 'boundary', files).files).toHaveLength(32);
    expect(() => f.candidate('task-1', null, '', 'overflow', [...files.slice(0, -1), { path: 'assets/large', bytes: Buffer.alloc(1024 * 1024) }])).toThrow('byte limit');
  });

  test('capturing a draft rejects links and does not read through them', () => {
    const f = fixture(); const draft = join(f.root, 'draft'); mkdirSync(draft);
    writeFileSync(join(draft, 'SKILL.md'), '# Draft');
    mkdirSync(join(draft, 'references')); writeFileSync(join(draft, 'references', 'note.txt'), 'Scoped note');
    expect(captureEngineeringSkillDraft(draft).map(file => file.path)).toEqual(['SKILL.md', 'references/note.txt']);
    writeFileSync(join(f.root, 'outside.txt'), 'Outside fixture');
    symlinkSync(join(f.root, 'outside.txt'), join(draft, 'linked.txt'));
    expect(() => captureEngineeringSkillDraft(draft)).toThrow('link');
    rmSync(join(draft, 'linked.txt'));
    linkSync(join(f.root, 'outside.txt'), join(draft, 'hardlink.txt'));
    expect(() => captureEngineeringSkillDraft(draft)).toThrow('hard-linked');
  });

  test('materializes only approved files read-only and keeps isolated drafts empty', () => {
    const f = fixture(); const first = f.candidate('task-1', null, '# Approved instructions'); f.promote(first);
    f.candidate('task-1', first.hash, '# Unreviewed draft must not load');
    const approved = join(f.root, 'approved'); const draft = join(f.root, 'draft');
    const snapshot = f.registry.materializeTaskSkills('task-1', approved, draft);
    expect(snapshot.skills[0]?.hash).toBe(first.hash);
    expect(readFileSync(join(approved, first.skillName, 'SKILL.md'), 'utf8')).toBe('# Approved instructions');
    expect(statSync(join(approved, first.skillName, 'SKILL.md')).mode & 0o777).toBe(0o400);
    expect(statSync(approved).mode & 0o777).toBe(0o500);
    expect(readdirSync(draft)).toEqual([]);
    writeFileSync(join(draft, 'SKILL.md'), '# Local modifications');
    expect(readFileSync(join(approved, first.skillName, 'SKILL.md'), 'utf8')).toBe('# Approved instructions');
    expect(() => f.registry.materializeTaskSkills('task-1', approved, join(f.root, 'another-draft'))).toThrow();
  });

  test('materialization refuses overlapping paths, linked parents and existing task data', () => {
    const f = fixture(); const path = join(f.root, 'same');
    expect(() => f.registry.materializeTaskSkills('task-1', path, path)).toThrow('overlap');
    const existing = join(f.root, 'existing'); mkdirSync(existing); writeFileSync(join(existing, 'keep.txt'), 'preserve');
    expect(() => f.registry.materializeTaskSkills('task-1', existing, join(f.root, 'draft'))).toThrow();
    expect(readFileSync(join(existing, 'keep.txt'), 'utf8')).toBe('preserve');
    const link = join(f.root, 'linked-parent'); symlinkSync(existing, link);
    expect(() => f.registry.materializeTaskSkills('task-1', join(link, 'approved'), join(f.root, 'draft'))).toThrow('noncanonical');
  });
});
