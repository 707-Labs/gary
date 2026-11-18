/** Host-only publication. Importing this file performs no I/O. The runtime must
 * explicitly wire a granted publication mode, a verified execution capability,
 * and separately funded nondeploy CI. Never expose these dependencies as tools.
 *
 * A verified capture is converted to Git objects AFTER its checks/review. The
 * receipt records that derivation; it does not claim tests ran on that commit.
 * Every remote write has a durable intent first. An ambiguous write latches the
 * entire publication; reconciliation is an operator action, never a retry here.
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { GitHubClient, PullRequestRef } from '../adapters/github.ts';
import { isGitHubEngineeringToken } from '../adapters/github.ts';
import type { LinearAdapter } from '../adapters/linear.ts';
import { ENGINEERING_REPOSITORY_ARTIFACT_LIMITS, type EngineeringArtifactCapture } from './engineering-artifact.ts';

export interface VerifiedStandingPublicationArtifact {
  readonly taskId: string;
  readonly artifactReceiptId: string;
  readonly policyFingerprint: string;
  readonly publication: 'patch_only' | 'draft_pr';
  /** Minted into the opaque proof only when the authenticated host request
   * explicitly continues this completed publication. Never inferred by model. */
  readonly predecessorPublicationId?: string;
  readonly repository: { readonly repo: string; readonly repositoryId: number; readonly installationId: number };
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly capture: EngineeringArtifactCapture;
  readonly patchSha256: string;
  readonly requiredCommands: readonly string[];
  readonly tests: readonly { command: string; exitCode: number; receiptId: string; artifactDigest: string }[];
  readonly review: { verdict: 'approved'; independent: true; requestId: string; artifactDigest: string; blockingFindings: 0 };
  readonly cleanup: { authorClosed: true; verifierClosed: true; receiptSha256: string };
}
export interface StandingPublicationBinding {
  readonly taskId: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly repo: string;
  readonly artifactReceiptId: string;
  readonly artifactSha256: string;
  readonly branch: string;
  readonly predecessorPublicationId?: string;
}
/** Supplied only by host grant/CI reservation validation, never model JSON.
 * This callback must reserve/retain the allowance idempotently for this binding.
 * A draft PR can trigger CI, as can a push: both events need coverage. */
export interface StandingPublicationAuthority {
  readonly publication: 'draft_pr';
  readonly grantId: string;
  readonly authoritySha256: string;
  readonly taskId: string;
  readonly repositoryId: number;
  readonly expiresAtMs: number;
  readonly ci: {
    readonly poolId: string;
    readonly reservationId: string;
    readonly receiptSha256: string;
    readonly authoritySha256: string;
    readonly repositoryId: number;
    readonly artifactSha256: string;
    readonly branch: string;
    readonly workflowSha256: string;
    readonly runnerIdentity: string;
    readonly expiresAtMs: number;
    readonly maxRuns: 2;
    readonly maxCostMicros: number;
    readonly runnerAvailable: true;
    readonly nonDeploy: true;
    readonly events: readonly ['push', 'pull_request', 'pull_request.synchronize'];
  };
  /** Exact immutable ticket admitted by the host. No arbitrary model recipient. */
  readonly linkedLinearIssueId?: string;
}
export interface StandingPublicationTreeEntry { path: string; mode: '100644' | '100755'; type: 'blob'; sha: string | null }
export interface StandingPublicationGitHub {
  assertRepository(binding: StandingPublicationBinding): Promise<void>;
  readRef(repo: string, branch: string): Promise<string | null>;
  readCommit(repo: string, sha: string): Promise<{ sha: string; tree: string; parents: string[] }>;
  createBlob(repo: string, base64: string): Promise<string>;
  createTree(repo: string, baseTree: string, entries: StandingPublicationTreeEntry[]): Promise<string>;
  createCommit(repo: string, tree: string, parent: string, message: string): Promise<string>;
  createBranch(repo: string, branch: string, sha: string): Promise<{ ref: string; sha: string }>;
  openDraft(repo: string, head: string, base: string, title: string, body: string): Promise<PullRequestRef>;
  readDraft?(repo: string, number: number): Promise<PullRequestRef & { headRef: string; body: string }>;
  /** Must reject unsupported file modes before a ref mutation. */
  assertSuccessorFiles?(repo: string, baseTree: string, entries: StandingPublicationTreeEntry[]): Promise<void>;
  /** Atomic expected-head commit/ref mutation, never read-then-force-push. */
  advanceDraft?(repo: string, branch: string, expectedHead: string, capture: EngineeringArtifactCapture,
    message: string): Promise<{ sha: string; tree: string; parents: string[] }>;
  updateDraft?(repo: string, number: number, title: string, body: string): Promise<PullRequestRef>;
}
export interface StandingPublicationReceipt {
  readonly publicationId: string;
  readonly binding: StandingPublicationBinding;
  readonly artifactSha256: string;
  readonly captureSha256: string;
  readonly patchSha256: string;
  readonly cleanupReceiptSha256: string;
  readonly tree: string;
  readonly commit: string;
  readonly pullRequest: { number: number; url: string };
  readonly linearCommentId: string | null;
  readonly predecessorPublicationId?: string;
}
export interface StandingPublicationOptions {
  /** Dedicated host publication journal, durable file in production; FULL sync. */
  db: Database;
  proof: unknown;
  /** Must reject unknown/deserialized proof and reassert capture provenance and
   * closed author/verifier custody. Its return is a host-verified snapshot. */
  verifyArtifact(proof: unknown): VerifiedStandingPublicationArtifact;
  assertOwner(): void;
  authorizePublication(binding: StandingPublicationBinding): Promise<StandingPublicationAuthority>;
  github: StandingPublicationGitHub;
  linear?: Pick<LinearAdapter, 'postComment'>;
  now?: () => number;
}
const SHA = /^[a-f0-9]{64}$/, GIT = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO = /^707-Labs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
function fail(reason: string): never { throw new Error('standing_publication:' + reason); }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function blobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function ref(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/.test(value) && !value.includes('..') && !value.includes('//')
    && !value.endsWith('.') && !value.endsWith('/') && value.split('/').every(p => !p.endsWith('.lock'));
}
function git(value: unknown): string { if (typeof value !== 'string' || !GIT.test(value)) fail('git_identity'); return value; }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function artifactSnapshot(raw: VerifiedStandingPublicationArtifact): VerifiedStandingPublicationArtifact {
  // Serialize once: later host/model mutation cannot change the bytes we publish.
  const a = JSON.parse(JSON.stringify(raw)) as VerifiedStandingPublicationArtifact;
  if (!ID.test(a.taskId) || !ID.test(a.artifactReceiptId) || !/^sha256:[a-f0-9]{64}$/.test(a.policyFingerprint) || a.publication !== 'draft_pr'
      || a.predecessorPublicationId !== undefined && !SHA.test(a.predecessorPublicationId)
      || !REPO.test(a.repository.repo) || a.repository.repo.endsWith('.git')
      || !positive(a.repository.repositoryId) || !positive(a.repository.installationId)
      || !ref(a.baseRef) || a.baseRef.startsWith('gary/') || !GIT.test(a.baseCommit)
      || !SHA.test(a.patchSha256) || !SHA.test(a.capture.hash)
      || a.cleanup.authorClosed !== true || a.cleanup.verifierClosed !== true || !SHA.test(a.cleanup.receiptSha256)
      || !a.capture.files.length || a.capture.files.length > ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.files) fail('artifact');
  const seen = new Set<string>(); let size = 0;
  for (const file of a.capture.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.length > 512 || /[\x00-\x1f\x7f-\x9f\\:]/.test(file.path)
        || isAbsolute(file.path) || file.path.normalize('NFC') !== file.path
        || file.path.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.trim() !== p || Buffer.byteLength(p) > 255
          || /^(?:\.git|\.git-credentials|\.gitconfig|git~\d|\.hg|\.svn|\.beads|\.aws|\.ssh|\.gnupg|\.azure|\.gcloud|\.kube|\.npmrc|\.pypirc|\.netrc|\.docker|\.env.*|secrets?(?:\..*)?|credentials?(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?)$/i.test(p))
        || seen.has(file.path.toLowerCase())) fail('artifact_path');
    seen.add(file.path.toLowerCase());
    if (file.kind === 'file') {
      const bytes = Buffer.from(file.base64, 'base64'); size += bytes.length;
      if (bytes.toString('base64') !== file.base64 || hash(bytes) !== file.sha256
          || ![0o644, 0o755].includes(file.mode)) fail('artifact_bytes');
    } else if (file.kind !== 'deleted' || file.base64 !== null || file.sha256 !== null || file.mode !== null) fail('artifact_bytes');
  }
  for (const file of a.capture.files) {
    const parts = file.path.toLowerCase().split('/'); parts.pop();
    while (parts.length) { if (seen.has(parts.join('/'))) fail('artifact_path'); parts.pop(); }
  }
  if (size > ENGINEERING_REPOSITORY_ARTIFACT_LIMITS.bytes || hash(JSON.stringify({ version: 1, files: a.capture.files })) !== a.capture.hash) fail('artifact_hash');
  if (!a.requiredCommands.length || new Set(a.requiredCommands).size !== a.requiredCommands.length
      || a.tests.length !== a.requiredCommands.length || new Set(a.tests.map(t => t.command)).size !== a.tests.length
      || a.tests.some(t => !a.requiredCommands.includes(t.command) || t.exitCode !== 0 || !ID.test(t.receiptId) || t.artifactDigest !== a.capture.hash)
      || a.review.verdict !== 'approved' || a.review.independent !== true || a.review.blockingFindings !== 0
      || !ID.test(a.review.requestId) || a.review.artifactDigest !== a.capture.hash) fail('verification');
  return a;
}
function validateAuthority(a: StandingPublicationAuthority, b: StandingPublicationBinding, now: number): void {
  if (a.publication !== 'draft_pr' || !ID.test(a.grantId) || !SHA.test(a.authoritySha256)
      || a.taskId !== b.taskId || a.repositoryId !== b.repositoryId || !Number.isSafeInteger(a.expiresAtMs) || now >= a.expiresAtMs
      || !ID.test(a.ci?.poolId) || !SHA.test(a.ci?.receiptSha256) || !SHA.test(a.ci?.authoritySha256)
      || !ID.test(a.ci.reservationId) || a.ci.repositoryId !== b.repositoryId || a.ci.artifactSha256 !== b.artifactSha256
      || a.ci.branch !== b.branch || !SHA.test(a.ci.workflowSha256) || !ID.test(a.ci.runnerIdentity)
      || !Number.isSafeInteger(a.ci.expiresAtMs) || now >= a.ci.expiresAtMs || a.ci.maxRuns !== 2
      || !Number.isSafeInteger(a.ci?.maxCostMicros) || a.ci.maxCostMicros < 0
      || a.ci.runnerAvailable !== true || a.ci.nonDeploy !== true
      || JSON.stringify(a.ci.events) !== '["push","pull_request","pull_request.synchronize"]'
      || a.linkedLinearIssueId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(a.linkedLinearIssueId)) fail('authority_or_ci');
}
interface JournalRow { binding_json: string; authority_json: string; state: string; receipt_json: string | null }
interface StepRow { request_sha256: string; state: string; response_json: string | null; response_sha256: string | null }

function initializeJournal(db: Database): void {
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS standing_engineering_publications (
      id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, authority_json TEXT NOT NULL,
      state TEXT NOT NULL, receipt_json TEXT, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS standing_engineering_publication_steps (
      publication_id TEXT NOT NULL, name TEXT NOT NULL, request_sha256 TEXT NOT NULL,
      state TEXT NOT NULL, response_json TEXT, response_sha256 TEXT, PRIMARY KEY(publication_id,name));
    CREATE TABLE IF NOT EXISTS standing_engineering_publication_successors (
      predecessor_id TEXT PRIMARY KEY, successor_id TEXT NOT NULL UNIQUE);`);
}

export interface StandingPublicationTarget {
  readonly publicationId: string; readonly taskId: string; readonly repo: string;
  readonly repositoryId: number; readonly installationId: number; readonly branch: string;
  readonly commit: string; readonly baseRef: string; readonly pullRequest: { number: number; url: string };
  readonly linkedLinearIssueId?: string;
}
/** Host lookup only. This is not an execution/publication capability. The host
 * must bind an explicit authenticated follow-up to this target before cloning. */
function readCompletedTarget(db: Database, publicationId: string): StandingPublicationTarget {
  if (!SHA.test(publicationId)) fail('predecessor');
  if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='standing_engineering_publications'").get()) fail('predecessor_not_complete');
  const row = db.query<JournalRow, [string]>('SELECT * FROM standing_engineering_publications WHERE id=?').get(publicationId);
  if (!row || row.state !== 'complete' || !row.receipt_json) fail('predecessor_not_complete');
  const stored = JSON.parse(row.binding_json) as { binding: StandingPublicationBinding; artifact: VerifiedStandingPublicationArtifact };
  const receipt = JSON.parse(row.receipt_json) as StandingPublicationReceipt;
  const authority = JSON.parse(row.authority_json) as StandingPublicationAuthority;
  const a = artifactSnapshot(stored.artifact), b = stored.binding;
  if (receipt.publicationId !== publicationId || hash(JSON.stringify({ taskId: a.taskId, repositoryId: a.repository.repositoryId })) !== publicationId
      || JSON.stringify(receipt.binding) !== JSON.stringify(b) || b.artifactSha256 !== hash(JSON.stringify(a))
      || receipt.artifactSha256 !== b.artifactSha256 || receipt.captureSha256 !== a.capture.hash || receipt.patchSha256 !== a.patchSha256
      || b.taskId !== a.taskId || b.repo !== a.repository.repo || b.repositoryId !== a.repository.repositoryId
      || b.installationId !== a.repository.installationId || !/^gary\/engineering\/[a-f0-9]{32}$/.test(b.branch)
      || !GIT.test(receipt.commit) || !positive(receipt.pullRequest.number)
      || receipt.pullRequest.url !== `https://github.com/${b.repo}/pull/${receipt.pullRequest.number}`) fail('predecessor_binding');
  return Object.freeze({ publicationId, taskId: a.taskId, repo: b.repo, repositoryId: b.repositoryId,
    installationId: b.installationId, branch: b.branch, commit: receipt.commit, baseRef: a.baseRef,
    pullRequest: Object.freeze({ ...receipt.pullRequest }),
    ...(authority.linkedLinearIssueId ? { linkedLinearIssueId: authority.linkedLinearIssueId } : {}) });
}
export function readStandingPublicationTarget(db: Database, publicationId: string): StandingPublicationTarget {
  const target = readCompletedTarget(db, publicationId);
  if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='standing_engineering_publication_successors'").get()
      && db.query('SELECT successor_id FROM standing_engineering_publication_successors WHERE predecessor_id=?').get(publicationId)) fail('successor_already_claimed');
  return target;
}

export async function publishStandingEngineeringDraft(options: StandingPublicationOptions): Promise<StandingPublicationReceipt> {
  options.assertOwner();
  const a = artifactSnapshot(options.verifyArtifact(options.proof));
  const artifactJson = JSON.stringify(a), artifactSha256 = hash(artifactJson);
  const publicationId = hash(JSON.stringify({ taskId: a.taskId, repositoryId: a.repository.repositoryId }));
  const db = options.db;
  initializeJournal(db);
  const predecessor = a.predecessorPublicationId ? readCompletedTarget(db, a.predecessorPublicationId) : undefined;
  if (predecessor && (predecessor.publicationId === publicationId || predecessor.taskId === a.taskId
      || predecessor.repo !== a.repository.repo || predecessor.repositoryId !== a.repository.repositoryId
      || predecessor.installationId !== a.repository.installationId || predecessor.baseRef !== a.baseRef
      || predecessor.commit !== a.baseCommit)) fail('predecessor_binding');
  if (predecessor && (!options.github.readDraft || !options.github.assertSuccessorFiles || !options.github.advanceDraft || !options.github.updateDraft)) fail('successor_adapter_missing');
  const b: StandingPublicationBinding = Object.freeze({ taskId: a.taskId, ...a.repository,
    artifactReceiptId: a.artifactReceiptId, artifactSha256, branch: predecessor?.branch ?? `gary/engineering/${publicationId.slice(0, 32)}`,
    ...(predecessor ? { predecessorPublicationId: predecessor.publicationId } : {}) });
  const now = options.now ?? Date.now;
  let authority = JSON.parse(JSON.stringify(await options.authorizePublication(b))) as StandingPublicationAuthority;
  validateAuthority(authority, b, now());
  if (predecessor && authority.linkedLinearIssueId !== predecessor.linkedLinearIssueId) fail('linked_ticket_changed');
  if (authority.linkedLinearIssueId && !options.linear) fail('linear_adapter_missing');
  const guard = () => { options.assertOwner(); validateAuthority(authority, b, now()); };
  // Expiry may be renewed by the same host authority without changing its scope.
  const authorityJson = JSON.stringify({ ...authority, expiresAtMs: 0 });
  const reauthorize = async () => {
    guard(); const fresh = JSON.parse(JSON.stringify(await options.authorizePublication(b))) as StandingPublicationAuthority;
    validateAuthority(fresh, b, now());
    if (JSON.stringify({ ...fresh, expiresAtMs: 0 }) !== authorityJson) fail('authority_changed');
    authority = fresh; guard();
  };
  const bindingJson = JSON.stringify({ binding: b, artifact: a });
  db.transaction(() => {
    if (predecessor) {
      const next = db.query<{ successor_id: string }, [string]>('SELECT successor_id FROM standing_engineering_publication_successors WHERE predecessor_id=?').get(predecessor.publicationId);
      if (next && next.successor_id !== publicationId) fail('successor_already_claimed');
      if (!next) db.query('INSERT INTO standing_engineering_publication_successors VALUES (?,?)').run(predecessor.publicationId, publicationId);
    }
    const prior = db.query<JournalRow, [string]>('SELECT * FROM standing_engineering_publications WHERE id=?').get(publicationId);
    if (prior) {
      if (prior.binding_json !== bindingJson || prior.authority_json !== authorityJson) fail('binding_changed');
      if (prior.state === 'unknown') fail('unknown_outcome_reconciliation_required');
    } else db.query('INSERT INTO standing_engineering_publications VALUES (?,?,?,?,?,?)').run(publicationId, bindingJson, authorityJson, 'active', null, now());
  })();
  const saved = db.query<JournalRow, [string]>('SELECT * FROM standing_engineering_publications WHERE id=?').get(publicationId)!;
  if (saved.state === 'complete') return JSON.parse(saved.receipt_json!) as StandingPublicationReceipt;
  const unfinished = db.query<{ name: string }, [string]>("SELECT name FROM standing_engineering_publication_steps WHERE publication_id=? AND state!='confirmed'").get(publicationId);
  if (unfinished) fail('unknown_outcome_reconciliation_required');
  const step = async <T>(name: string, request: unknown, write: () => Promise<T>, validate: (value: T) => void): Promise<T> => {
    guard();
    const requestSha = hash(JSON.stringify(request));
    const prior = db.query<StepRow, [string, string]>('SELECT * FROM standing_engineering_publication_steps WHERE publication_id=? AND name=?').get(publicationId, name);
    if (prior) {
      if (prior.request_sha256 !== requestSha || prior.state !== 'confirmed' || !prior.response_json
          || hash(prior.response_json) !== prior.response_sha256) fail('unknown_outcome_reconciliation_required');
      const value = JSON.parse(prior.response_json) as T; validate(value); return value;
    }
    // UNIQUE key is a permanent phase claim. A second process cannot write too.
    // Reobserve funded hold, workflow and runner before every mutation; a stale
    // CI snapshot cannot authorize a later ref/PR event after lengthy uploads.
    await reauthorize();
    db.query('INSERT INTO standing_engineering_publication_steps VALUES (?,?,?,?,NULL,NULL)').run(publicationId, name, requestSha, 'in_flight');
    try {
      guard(); await options.github.assertRepository(b); guard();
      const result = await write(); validate(result); guard();
      const json = JSON.stringify(result);
      db.query("UPDATE standing_engineering_publication_steps SET state='confirmed',response_json=?,response_sha256=? WHERE publication_id=? AND name=? AND state='in_flight'").run(json, hash(json), publicationId, name);
      return result;
    } catch {
      // Deliberately exclude service error text (it can contain credentials).
      db.transaction(() => {
        db.query("UPDATE standing_engineering_publication_steps SET state='unknown' WHERE publication_id=? AND name=?").run(publicationId, name);
        db.query("UPDATE standing_engineering_publications SET state='unknown' WHERE id=?").run(publicationId);
      })();
      fail('unknown_outcome_reconciliation_required');
    }
  };
  guard(); await options.github.assertRepository(b); guard();
  const branchStep = db.query<StepRow, [string, string]>('SELECT * FROM standing_engineering_publication_steps WHERE publication_id=? AND name=?').get(publicationId, 'branch');
  if (!predecessor && !branchStep && await options.github.readRef(b.repo, b.branch) !== null) fail('branch_not_owned');
  const targetBase = await options.github.readRef(b.repo, a.baseRef);
  if (!targetBase || !predecessor && targetBase !== a.baseCommit) fail('base_changed');
  const advanceStep = db.query<StepRow, [string, string]>('SELECT * FROM standing_engineering_publication_steps WHERE publication_id=? AND name=?').get(publicationId, 'advance');
  const expectedHead = advanceStep?.response_json ? git(JSON.parse(advanceStep.response_json).sha) : predecessor?.commit;
  const assertDraft = async (head = expectedHead) => {
    if (!predecessor) return;
    const pr = await options.github.readDraft!(b.repo, predecessor.pullRequest.number);
    if (await options.github.readRef(b.repo, b.branch) !== head || pr.headSha !== head || pr.headRef !== b.branch
        || pr.owner + '/' + pr.repo !== b.repo || pr.baseRef !== a.baseRef || pr.baseSha !== targetBase
        || pr.number !== predecessor.pullRequest.number || pr.url !== predecessor.pullRequest.url
        || pr.state !== 'open' || pr.merged || !pr.isDraft
        || !pr.body.includes(`<!-- gary-standing-publication:${predecessor.publicationId} -->`)
          && !pr.body.includes(`<!-- gary-standing-publication:${publicationId} -->`)) fail('draft_changed');
    guard();
  };
  await assertDraft();
  const base = await options.github.readCommit(b.repo, a.baseCommit);
  if (base.sha !== a.baseCommit) fail('base_changed'); git(base.tree);
  if (predecessor) await options.github.assertSuccessorFiles!(b.repo, base.tree, a.capture.files.map(file => ({
    path: file.path, mode: file.mode === 0o755 ? '100755' : '100644', type: 'blob',
    sha: file.kind === 'deleted' ? null : blobSha(Buffer.from(file.base64, 'base64')) })));
  const entries: StandingPublicationTreeEntry[] = [];
  for (const [index, file] of a.capture.files.entries()) {
    const sha = file.kind === 'deleted' ? null : await step(`blob:${index}`, { path: file.path, sha256: file.sha256 },
      () => options.github.createBlob(b.repo, file.base64), value => { if (value !== blobSha(Buffer.from(file.base64, 'base64'))) fail('blob_mismatch'); });
    entries.push({ path: file.path, mode: file.mode === 0o755 ? '100755' : '100644', type: 'blob', sha });
  }
  const tree = await step('tree', { baseTree: base.tree, entries }, () => options.github.createTree(b.repo, base.tree, entries), git);
  const message = `Gary engineering task ${a.taskId}\n\nReviewed capture: ${a.capture.hash}\nPatch: ${a.patchSha256}`;
  let commit: string;
  if (predecessor) {
    // The server compares expectedHead atomically with creating the successor.
    // Prederived Git tree proves the exact capture independently of that API.
    await assertDraft();
    const advanced = await step('advance', { branch: b.branch, expectedHead: a.baseCommit, capture: a.capture, tree, message },
      () => options.github.advanceDraft!(b.repo, b.branch, a.baseCommit, a.capture, message), value => {
        git(value.sha); if (value.tree !== tree || JSON.stringify(value.parents) !== JSON.stringify([a.baseCommit])) fail('commit_mismatch');
      });
    commit = advanced.sha;
  } else {
    commit = await step('commit', { tree, parent: a.baseCommit, message }, () => options.github.createCommit(b.repo, tree, a.baseCommit, message), git);
  }
  const committed = await options.github.readCommit(b.repo, commit);
  if (committed.sha !== commit || committed.tree !== tree || JSON.stringify(committed.parents) !== JSON.stringify([a.baseCommit])) fail('commit_mismatch');
  await options.github.assertRepository(b); guard();
  if (!predecessor) await step('branch', { branch: b.branch, commit }, () => options.github.createBranch(b.repo, b.branch, commit), value => {
      if (value.ref !== `refs/heads/${b.branch}` || value.sha !== commit) fail('branch_mismatch');
    });
  if (await options.github.readRef(b.repo, b.branch) !== commit || await options.github.readRef(b.repo, a.baseRef) !== targetBase) fail('ref_changed');
  await assertDraft(commit);
  const marker = `<!-- gary-standing-publication:${publicationId} -->`;
  const title = `Gary: engineering task ${a.taskId}`;
  const body = `${marker}\n\nVerified task: ${a.taskId}\n\n${a.tests.length} required checks passed; independent review approved. Author and verifier cleanup was confirmed.\n\nReviewed capture: ${a.capture.hash}\nPatch SHA-256: ${a.patchSha256}\nDerived commit: ${commit}\n\nDraft for human review. No merge or deployment was performed.`;
  const pr = await step('pr', { head: b.branch, base: a.baseRef, title, body, draft: true, ...(predecessor ? { number: predecessor.pullRequest.number } : {}) },
    () => predecessor ? options.github.updateDraft!(b.repo, predecessor.pullRequest.number, title, body)
      : options.github.openDraft(b.repo, b.branch, a.baseRef, title, body), value => {
      if (!positive(value.number) || value.owner + '/' + value.repo !== b.repo || value.headSha !== commit
          || predecessor && value.number !== predecessor.pullRequest.number
          || value.baseRef !== a.baseRef || value.baseSha !== targetBase || value.state !== 'open' || value.merged || value.isDraft !== true
          || value.url !== `https://github.com/${b.repo}/pull/${value.number}`) fail('draft_pr_mismatch');
    });
  const comment = `${marker}\nDraft PR: ${pr.url}\n\n${a.tests.length} required checks passed and independent review approved the exact captured patch. Cleanup confirmed.\nCommit: ${commit}\nPatch SHA-256: ${a.patchSha256}`;
  const linearCommentId = authority.linkedLinearIssueId ? await step('linear', { issueId: authority.linkedLinearIssueId, body: comment },
    () => options.linear!.postComment(authority.linkedLinearIssueId!, comment), value => { if (typeof value !== 'string' || !ID.test(value)) fail('linear_receipt'); }) : null;
  const receipt: StandingPublicationReceipt = { publicationId, binding: b, artifactSha256, captureSha256: a.capture.hash,
    patchSha256: a.patchSha256, cleanupReceiptSha256: a.cleanup.receiptSha256, tree, commit,
    pullRequest: { number: pr.number, url: pr.url }, linearCommentId,
    ...(predecessor ? { predecessorPublicationId: predecessor.publicationId } : {}) };
  guard();
  db.query("UPDATE standing_engineering_publications SET state='complete',receipt_json=? WHERE id=? AND state='active'").run(JSON.stringify(receipt), publicationId);
  return receipt;
}

/** Existing App adapter supplies fresh installation identity/credentials and PR
 * creation. The narrow Git Data bridge never runs Git or persists a token. No
 * automatic retries, redirects, PAT fallback, merge, force push, or deploy API. */
export interface StandingPublicationRequestContext { assertOwner(): void; signal: AbortSignal; deadlineMs: number; now?: () => number }
export function createStandingPublicationGitHub(client: Pick<GitHubClient, 'engineeringInstallationCredential' | 'openPullRequest'>,
  expected: { appId: number; installationId: number }, fetcher: typeof fetch = fetch,
  context?: StandingPublicationRequestContext): StandingPublicationGitHub {
  if (!client.engineeringInstallationCredential || !positive(expected.appId) || !positive(expected.installationId)) fail('app_required');
  const now = context?.now ?? Date.now;
  const guard = () => { context?.assertOwner(); context?.signal.throwIfAborted(); if (context && now() >= context.deadlineMs) fail('deadline'); };
  const request = async (repo: string, suffix: string, method = 'GET', body?: unknown): Promise<any> => {
    guard();
    if (!REPO.test(repo)) fail('repository');
    const credential = await client.engineeringInstallationCredential!();
    guard();
    if (credential.kind !== 'app' || credential.appId !== expected.appId || credential.installationId !== expected.installationId
        || credential.accountLogin !== '707-Labs' || credential.permissions.contents !== 'write' || credential.permissions.pullRequests !== 'write'
        || !isGitHubEngineeringToken(credential.token) || credential.expiresAtMs <= now()
        || now() < credential.issuedAtMs || now() - credential.issuedAtMs > 60_000) fail('app_authority');
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(15_000, context ? context.deadlineMs - now() : 15_000)));
    const response = await fetcher(suffix === '@graphql' ? 'https://api.github.com/graphql' : `https://api.github.com/repos/${repo}${suffix}`, {
      method, redirect: 'error', signal: context ? AbortSignal.any([context.signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    guard();
    if (response.status === 404 && method === 'GET' && suffix.startsWith('/git/ref/')) return null;
    if (!response.ok) fail('github_response');
    const reader = response.body?.getReader(); if (!reader) fail('github_response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); guard(); if (part.done) break;
        size += part.value.byteLength; if (size > 8 * 1024 * 1024) fail('github_response_limit'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); guard(); return value;
  };
  const draft = (repo: string, data: any): PullRequestRef & { headRef: string; body: string } => {
    if (data.base?.repo?.full_name !== repo || data.head?.repo?.full_name !== repo || !positive(data.number)
        || data.html_url !== `https://github.com/${repo}/pull/${data.number}` || typeof data.head?.ref !== 'string'
        || !ref(data.head.ref) || !ref(data.base?.ref) || typeof data.draft !== 'boolean' || typeof data.merged !== 'boolean'
        || !['open', 'closed'].includes(data.state) || typeof data.body !== 'string') fail('draft_response');
    const [owner, name] = repo.split('/');
    return { owner: owner!, repo: name!, number: data.number, url: data.html_url, headSha: git(data.head.sha),
      baseRef: data.base.ref, baseSha: git(data.base.sha), state: data.state, merged: data.merged, isDraft: data.draft,
      createdAt: String(data.created_at), headRef: data.head.ref, body: data.body };
  };
  return {
    async assertRepository(b) {
      if (b.installationId !== expected.installationId) fail('installation_changed');
      const data = await request(b.repo, '');
      if (data.id !== b.repositoryId || data.full_name !== b.repo || data.archived !== false || data.disabled !== false) fail('repository_changed');
    },
    async readRef(repo, branch) {
      if (!ref(branch)) fail('ref');
      const data = await request(repo, '/git/ref/heads/' + encodeURIComponent(branch));
      if (data === null) return null;
      if (data.ref !== 'refs/heads/' + branch || data.object?.type !== 'commit') fail('ref');
      return git(data.object.sha);
    },
    async readCommit(repo, sha) {
      const data = await request(repo, '/git/commits/' + git(sha));
      if (!Array.isArray(data.parents)) fail('commit');
      return { sha: git(data.sha), tree: git(data.tree?.sha), parents: data.parents.map((p: any) => git(p.sha)) };
    },
    async createBlob(repo, base64) { return git((await request(repo, '/git/blobs', 'POST', { content: base64, encoding: 'base64' })).sha); },
    async createTree(repo, baseTree, entries) { return git((await request(repo, '/git/trees', 'POST', { base_tree: git(baseTree), tree: entries })).sha); },
    async createCommit(repo, tree, parent, message) { return git((await request(repo, '/git/commits', 'POST', { tree: git(tree), parents: [git(parent)], message })).sha); },
    async createBranch(repo, branch, sha) {
      if (!/^gary\/engineering\/[a-f0-9]{32}$/.test(branch)) fail('branch_not_owned');
      const data = await request(repo, '/git/refs', 'POST', { ref: 'refs/heads/' + branch, sha: git(sha) });
      return { ref: data.ref, sha: git(data.object?.sha) };
    },
    async openDraft(repo, head, base, title, body) {
      if (!/^gary\/engineering\/[a-f0-9]{32}$/.test(head) || !ref(base)) fail('ref');
      // The wired host path uses the fresh credential and bounded transport.
      if (context) return draft(repo, await request(repo, '/pulls', 'POST', { head, base, title, body, draft: true }));
      const [owner, name] = repo.split('/');
      return await client.openPullRequest({ owner: owner!, repo: name!, head, base, title, body, draft: true });
    },
    async readDraft(repo, number) {
      if (!positive(number)) fail('draft_number'); return draft(repo, await request(repo, '/pulls/' + number));
    },
    async assertSuccessorFiles(repo, baseTree, entries) {
      // GraphQL additions cannot express executable mode. Reject those before
      // advancing a ref; REST initial publication supports both regular modes.
      if (entries.some(e => e.sha !== null && e.mode !== '100644')) fail('successor_file_mode');
      const tree = await request(repo, '/git/trees/' + git(baseTree) + '?recursive=1');
      if (tree.sha !== baseTree || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100_000) fail('successor_tree');
      for (const e of entries) {
        const prior = tree.tree.find((p: any) => p.path === e.path);
        if (prior && (prior.type !== 'blob' || e.sha !== null && prior.mode !== '100644')) fail('successor_file_mode');
      }
    },
    async advanceDraft(repo, branch, expectedHead, capture, message) {
      if (!/^gary\/engineering\/[a-f0-9]{32}$/.test(branch)) fail('branch_not_owned');
      if (capture.files.some(f => f.kind === 'file' && f.mode !== 0o644)) fail('successor_file_mode');
      const [headline, ...body] = message.split('\n');
      const response = await request(repo, '@graphql', 'POST', {
        query: 'mutation GaryVerifiedSuccessor($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } parents(first: 2) { nodes { oid } } } } }',
        variables: { input: { branch: { repositoryNameWithOwner: repo, branchName: branch }, expectedHeadOid: git(expectedHead),
          message: { headline, body: body.join('\n') }, fileChanges: {
            additions: capture.files.filter(f => f.kind === 'file').map(f => ({ path: f.path, contents: f.base64 })),
            deletions: capture.files.filter(f => f.kind === 'deleted').map(f => ({ path: f.path })) } } },
      });
      if (response.errors?.length) fail('successor_response');
      const commit = response.data?.createCommitOnBranch?.commit;
      if (!Array.isArray(commit?.parents?.nodes)) fail('successor_response');
      return { sha: git(commit.oid), tree: git(commit.tree?.oid), parents: commit.parents.nodes.map((p: any) => git(p.oid)) };
    },
    async updateDraft(repo, number, title, body) {
      if (!positive(number)) fail('draft_number');
      return draft(repo, await request(repo, '/pulls/' + number, 'PATCH', { title, body }));
    },
  };
}
