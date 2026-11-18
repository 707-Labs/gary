import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStandingPublicationGitHub, publishStandingEngineeringDraft, readStandingPublicationTarget,
  type StandingPublicationAuthority, type StandingPublicationGitHub, type StandingPublicationOptions,
  type VerifiedStandingPublicationArtifact } from '../../src/hermes/standing-engineering-publication.ts';
import type { GitHubClient, GitHubEngineeringInstallationCredential, PullRequestRef } from '../../src/adapters/github.ts';
import { createStandingEngineeringPublicationAdapter } from '../../src/hermes/standing-engineering-publication-adapter.ts';

const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const blob = (v: Uint8Array) => createHash('sha1').update(`blob ${v.length}\0`).update(v).digest('hex');
const BASE = 'a'.repeat(40), TREE = 'b'.repeat(40), COMMIT = 'c'.repeat(40), BASETREE = 'd'.repeat(40);
const paths: string[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); });
function db(path = ':memory:') { const d = new Database(path); databases.push(d); return d; }
function fixture(database = db()) {
  const bytes = Buffer.from('export const answer = 42;\n');
  const files = [{ path: 'src/answer.ts', kind: 'file' as const, mode: 0o644 as const,
    base64: bytes.toString('base64'), sha256: hash(bytes) }];
  const capture = { files, hash: hash(JSON.stringify({ version: 1, files })) };
  const artifact: VerifiedStandingPublicationArtifact = {
    taskId: 'engineering-12345678-1234-1234-1234-123456789012', artifactReceiptId: 'artifact-123', policyFingerprint: 'sha256:' + '1'.repeat(64), publication: 'draft_pr',
    repository: { repo: '707-Labs/example', repositoryId: 123, installationId: 456 }, baseRef: 'main', baseCommit: BASE,
    capture, patchSha256: '2'.repeat(64), requiredCommands: ['bun test'],
    tests: [{ command: 'bun test', exitCode: 0, receiptId: 'check-123', artifactDigest: capture.hash }],
    review: { verdict: 'approved', independent: true, requestId: 'review-123', artifactDigest: capture.hash, blockingFindings: 0 },
    cleanup: { authorClosed: true, verifierClosed: true, receiptSha256: '3'.repeat(64) },
  };
  const authority: StandingPublicationAuthority = { publication: 'draft_pr', grantId: 'grant-123', authoritySha256: '4'.repeat(64),
    taskId: artifact.taskId, repositoryId: 123, expiresAtMs: Date.now() + 60_000,
    ci: { poolId: 'ci-123', reservationId:'ci-reservation',receiptSha256: '5'.repeat(64), authoritySha256: '6'.repeat(64), maxCostMicros: 10_000,
      repositoryId:123,artifactSha256:'',branch:'',workflowSha256:'7'.repeat(64),runnerIdentity:'github-hosted:ubuntu-24.04',
      expiresAtMs:Date.now()+60_000,maxRuns:2,runnerAvailable: true, nonDeploy: true, events: ['push', 'pull_request','pull_request.synchronize'] }, linkedLinearIssueId: '12345678-1234-1234-1234-123456789012' };
  const writes: { name: string; args: unknown }[] = [], refs = new Map<string, string>([['main', BASE]]);
  const proof = Object.freeze({ opaque: true });
  const github: StandingPublicationGitHub = {
    async assertRepository(binding) { expect(binding.repositoryId).toBe(123); },
    async readRef(_repo, branch) { return refs.get(branch) ?? null; },
    async readCommit(_repo, sha) { return { sha, tree: sha === BASE ? BASETREE : TREE, parents: sha === BASE ? [] : [BASE] }; },
    async createBlob(_repo, base64) { writes.push({ name: 'blob', args: base64 }); return blob(Buffer.from(base64, 'base64')); },
    async createTree(_repo, baseTree, entries) { writes.push({ name: 'tree', args: { baseTree, entries } }); return TREE; },
    async createCommit(_repo, tree, parent, message) { writes.push({ name: 'commit', args: { tree, parent, message } }); return COMMIT; },
    async createBranch(_repo, branch, sha) { writes.push({ name: 'branch', args: { branch, sha } }); refs.set(branch, sha); return { ref: 'refs/heads/' + branch, sha }; },
    async openDraft(repo, head, base, title, body) {
      writes.push({ name: 'pr', args: { repo, head, base, title, body } });
      return { owner: '707-Labs', repo: 'example', number: 42, url: `https://github.com/${repo}/pull/42`, headSha: COMMIT,
        baseRef: 'main', baseSha: BASE, state: 'open', merged: false, isDraft: true, createdAt: new Date().toISOString() };
    },
  };
  const options: StandingPublicationOptions = { db: database, proof,
    verifyArtifact: p => { if (p !== proof) throw new Error('unknown_execution_proof'); return artifact; },
    assertOwner() {}, authorizePublication: async b => ({...authority,ci:{...authority.ci,
      artifactSha256:authority.ci.artifactSha256||b.artifactSha256,branch:authority.ci.branch||b.branch}}), github,
    linear: { async postComment(issueId, body) { writes.push({ name: 'linear', args: { issueId, body } }); return 'comment-123'; } },
  };
  return { artifact, authority, options, writes, refs, github };
}
describe('standing publication host gates and exact artifact derivation', () => {
  test('publishes exact capture once, draft only; durable result and linked Linear comment are idempotent', async () => {
    const f = fixture();
    const first = await publishStandingEngineeringDraft(f.options);
    expect(f.writes.map(w => w.name)).toEqual(['blob', 'tree', 'commit', 'branch', 'pr', 'linear']);
    expect(first.commit).toBe(COMMIT);
    expect(first.captureSha256).toBe(f.artifact.capture.hash);
    expect(first.cleanupReceiptSha256).toBe(f.artifact.cleanup.receiptSha256);
    expect(first.binding.branch).toMatch(/^gary\/engineering\/[a-f0-9]{32}$/);
    expect(f.writes[1]!.args).toEqual({ baseTree: BASETREE,
      entries: [{ path: 'src/answer.ts', mode: '100644', type: 'blob', sha: blob(Buffer.from(f.artifact.capture.files[0]!.base64!, 'base64')) }] });
    const again = await publishStandingEngineeringDraft(f.options);
    expect(again).toEqual(first); expect(f.writes).toHaveLength(6);
    expect(f.options.db.query('SELECT state FROM standing_engineering_publications').get()).toEqual({ state: 'complete' });
  });
  test('rejects deserialized capability before any authority lookup or remote write', async () => {
    const f = fixture(); f.options.proof = JSON.parse(JSON.stringify(f.options.proof));
    f.options.authorizePublication = async () => { throw new Error('must_not_authorize'); };
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_execution_proof'); expect(f.writes).toEqual([]);
  });
  test('publication authority cannot upgrade a patch-only execution artifact', async () => {
    const f = fixture(); (f.artifact as any).publication = 'patch_only';
    f.options.authorizePublication = async () => { throw new Error('must_not_authorize'); };
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('standing_publication:artifact'); expect(f.writes).toEqual([]);
  });
  test.each(['test', 'review', 'cleanup', 'bytes'] as const)('rejects broken %s evidence without writing', async broken => {
    const f = fixture(), a = f.artifact as any;
    if (broken === 'test') a.tests[0].artifactDigest = '0'.repeat(64);
    if (broken === 'review') a.review.independent = false;
    if (broken === 'cleanup') a.cleanup.authorClosed = false;
    if (broken === 'bytes') a.capture.files[0].base64 = Buffer.from('unreviewed').toString('base64');
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('standing_publication:'); expect(f.writes).toEqual([]);
  });
  test.each(['mode', 'funds', 'runner', 'events', 'deploy', 'task', 'expired'] as const)('requires explicit %s authority', async missing => {
    const f = fixture(), a = f.authority as any;
    if (missing === 'mode') a.publication = 'patch_only';
    if (missing === 'funds') a.ci.receiptSha256 = '';
    if (missing === 'runner') a.ci.runnerAvailable = false;
    if (missing === 'events') a.ci.events = ['pull_request'];
    if (missing === 'deploy') a.ci.nonDeploy = false;
    if (missing === 'task') a.taskId = 'different-task';
    if (missing === 'expired') a.expiresAtMs = 0;
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('authority_or_ci'); expect(f.writes).toEqual([]);
  });
  test('requires linked Linear adapter up front', async () => {
    const f = fixture(); delete f.options.linear;
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('linear_adapter_missing'); expect(f.writes).toEqual([]);
  });
  test('rejects occupied deterministic branch and changed base before writes', async () => {
    for (const kind of ['occupied', 'base']) {
      const f = fixture();
      f.github.readRef = async (_repo, branch) => branch === 'main' ? (kind === 'base' ? COMMIT : BASE) : (kind === 'occupied' ? COMMIT : null);
      await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow(kind === 'base' ? 'base_changed' : 'branch_not_owned');
      expect(f.writes).toEqual([]);
    }
  });
  test('snapshots capture before asynchronous authority resolution', async () => {
    const f = fixture();
    const original = f.artifact.capture.files[0]!.base64;
    const authorize=f.options.authorizePublication;
    f.options.authorizePublication = async b => { (f.artifact.capture.files[0] as any).base64 = 'aGFja2Vk'; return authorize(b); };
    await publishStandingEngineeringDraft(f.options);
    expect(f.writes[0]!.args).toBe(original);
  });
  test('never adopts changed artifact for already published task', async () => {
    const f = fixture(); await publishStandingEngineeringDraft(f.options);
    (f.artifact as any).patchSha256 = '0'.repeat(64);
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('binding_changed'); expect(f.writes).toHaveLength(6);
  });
  test('standing route filenames and capture bounds exceed historical acceptance limits', async () => {
    const f = fixture(), bytes = Buffer.alloc(129 * 1024, 'x');
    const file = { path: 'app/routes/$team/[id]/read me.ts', kind: 'file' as const, mode: 0o644 as const, base64: bytes.toString('base64'), sha256: hash(bytes) };
    const capture = { files: [file], hash: hash(JSON.stringify({ version: 1, files: [file] })) };
    (f.artifact as any).capture = capture;
    (f.artifact.tests[0] as any).artifactDigest = capture.hash;
    (f.artifact.review as any).artifactDigest = capture.hash;
    const result = await publishStandingEngineeringDraft(f.options);
    expect(result.captureSha256).toBe(capture.hash);
    expect((f.writes[1]!.args as any).entries[0].path).toBe(file.path);
  });
  test.each(['.env.local', '.git/config', 'a/../b', 'git~1/config', 'a/ bad', 'a\\b', 'a:b'])('protected/unsafe path %s cannot publish', async path => {
    const f = fixture(), file = { ...f.artifact.capture.files[0]!, path };
    (f.artifact as any).capture = { files: [file], hash: hash(JSON.stringify({ version: 1, files: [file] })) };
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('artifact_path'); expect(f.writes).toEqual([]);
  });
});
describe('explicit verified successor publication', () => {
  async function successor() {
    const f = fixture(), first = await publishStandingEngineeringDraft(f.options);
    const artifact = structuredClone(f.artifact) as any;
    artifact.taskId = 'engineering-22345678-1234-1234-1234-123456789012';
    artifact.artifactReceiptId = 'artifact-456'; artifact.predecessorPublicationId = first.publicationId; artifact.baseCommit = COMMIT;
    const next = 'e'.repeat(40), tree = 'f'.repeat(40), proof = Object.freeze({ successor: true });
    const authority = structuredClone(f.authority); (authority as any).taskId = artifact.taskId;
    let body = `<!-- gary-standing-publication:${first.publicationId} -->`;
    const current = () => ({ owner:'707-Labs',repo:'example',number:42,url:'https://github.com/707-Labs/example/pull/42',
      headSha:f.refs.get(first.binding.branch)!,headRef:first.binding.branch,baseRef:'main',baseSha:BASE,
      state:'open' as const,merged:false,isDraft:true,createdAt:'2026-01-01T00:00:00Z',body });
    f.github.readCommit = async (_repo, sha) => ({sha,tree:sha===COMMIT?TREE:tree,parents:[sha===COMMIT?BASE:COMMIT]});
    f.github.createTree = async () => {f.writes.push({name:'tree',args:{}});return tree;};
    f.github.assertSuccessorFiles = async () => {};
    f.github.readDraft = async () => current();
    f.github.advanceDraft = async (_repo,branch,expectedHead) => {
      expect(expectedHead).toBe(COMMIT); expect(f.refs.get(branch)).toBe(expectedHead);
      f.writes.push({name:'advance',args:{branch,expectedHead}});f.refs.set(branch,next);return {sha:next,tree,parents:[COMMIT]};
    };
    f.github.updateDraft = async (_repo,number,_title,newBody) => {
      expect(number).toBe(42);body=newBody;f.writes.push({name:'update',args:{number,body}});return current();
    };
    const options: StandingPublicationOptions = {...f.options,proof,verifyArtifact:p=>{if(p!==proof)throw Error('opaque');return artifact;},
      authorizePublication:async b=>({...authority,ci:{...authority.ci,artifactSha256:b.artifactSha256,branch:b.branch}})};
    return {...f,first,artifact,authority,options,next,tree};
  }
  test('new opaque artifact continues exact completed branch/draft once and posts linked revision result',async()=>{
    const f=await successor();const target=readStandingPublicationTarget(f.options.db,f.first.publicationId);
    expect(target.commit).toBe(COMMIT);expect(target.linkedLinearIssueId).toBe(f.authority.linkedLinearIssueId);
    const result=await publishStandingEngineeringDraft(f.options);
    expect(result.predecessorPublicationId).toBe(f.first.publicationId);expect(result.binding.branch).toBe(f.first.binding.branch);
    expect(result.commit).toBe(f.next);expect(result.pullRequest).toEqual(f.first.pullRequest);
    expect(f.writes.slice(6).map(w=>w.name)).toEqual(['blob','tree','advance','update','linear']);
    expect(await publishStandingEngineeringDraft(f.options)).toEqual(result);expect(f.writes).toHaveLength(11);
    expect(()=>readStandingPublicationTarget(f.options.db,f.first.publicationId)).toThrow('successor_already_claimed');
    expect(readStandingPublicationTarget(f.options.db,result.publicationId).commit).toBe(f.next);
  });
  test.each(['head','draft','body','base','ticket'] as const)('changed %s fails before successor writes',async kind=>{
    const f=await successor(),read=f.github.readDraft!;
    if(kind==='ticket')delete (f.authority as any).linkedLinearIssueId;
    else f.github.readDraft=async(...args)=>({...await read(...args),...(kind==='head'?{headSha:BASE}:kind==='draft'?{isDraft:false}:kind==='body'?{body:'foreign'}:{baseRef:'other'})});
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow(kind==='ticket'?'linked_ticket_changed':'draft_changed');
    expect(f.writes).toHaveLength(6);
  });
  test('wrong predecessor base and forged predecessor capability fail before authority',async()=>{
    const f=await successor();f.artifact.baseCommit=BASE;
    f.options.authorizePublication=async()=>{throw Error('must_not_authorize');};
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('predecessor_binding');expect(f.writes).toHaveLength(6);
  });
  test('atomic advance unknown outcome latches chain and cannot retry or fork',async()=>{
    const f=await successor();let calls=0;
    f.github.advanceDraft=async()=>{calls++;throw Error('timeout after write');};
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome');
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome');expect(calls).toBe(1);
    f.artifact.taskId='engineering-third';(f.authority as any).taskId=f.artifact.taskId;
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('successor_already_claimed');
    expect(f.writes.some(w=>w.name==='update')).toBe(false);
  });
  test('unsupported successor mode is rejected before uploading or advancing',async()=>{
    const f=await successor();f.github.assertSuccessorFiles=async()=>{throw Error('standing_publication:successor_file_mode');};
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('successor_file_mode');expect(f.writes).toHaveLength(6);
  });
  test('atomic write returning a different tree latches without updating draft or ticket',async()=>{
    const f=await successor();f.github.advanceDraft=async()=>({sha:f.next,tree:'9'.repeat(40),parents:[COMMIT]});
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome');
    expect(f.writes.slice(6).map(w=>w.name)).toEqual(['blob','tree']);
    expect(f.options.db.query('SELECT state FROM standing_engineering_publications WHERE id!=?').get(f.first.publicationId)).toEqual({state:'unknown'});
  });
});
describe('durable remote outcome latches', () => {
  test.each(['blob', 'tree', 'commit', 'branch', 'pr', 'linear'] as const)('%s timeout cannot be retried, even after journal reopen', async target => {
    const root = mkdtempSync(join(tmpdir(), 'gary-publication-')); paths.push(root);
    const file = join(root, 'journal.db'); const firstDb = db(file); const f = fixture(firstDb);
    const methods = { blob: 'createBlob', tree: 'createTree', commit: 'createCommit', branch: 'createBranch', pr: 'openDraft' } as const;
    let calls = 0;
    if (target === 'linear') f.options.linear!.postComment = async () => { calls++; throw new Error('secret-token-timeout'); };
    else (f.github as any)[methods[target]] = async () => { calls++; throw new Error('secret-token-timeout'); };
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome_reconciliation_required');
    firstDb.close(); f.options.db = db(file);
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome_reconciliation_required');
    expect(calls).toBe(1);
    expect(JSON.stringify(f.options.db.query('SELECT * FROM standing_engineering_publications').all())).not.toContain('secret-token');
  });
  test('crashed in-flight durable intent blocks invocation before any read or write', async () => {
    const f = fixture(); await publishStandingEngineeringDraft(f.options);
    f.options.db.exec("UPDATE standing_engineering_publications SET state='active',receipt_json=NULL; UPDATE standing_engineering_publication_steps SET state='in_flight' WHERE name='pr'");
    f.github.assertRepository = async () => { throw new Error('must_not_reach_service'); };
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome_reconciliation_required'); expect(f.writes).toHaveLength(6);
  });
  test('bad remote commit derivation cannot advance a ref', async () => {
    const f = fixture();
    f.github.readCommit = async (_repo, sha) => ({ sha, tree: sha === BASE ? BASETREE : TREE, parents: sha === BASE ? [] : ['f'.repeat(40)] });
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('commit_mismatch');
    expect(f.writes.map(w => w.name)).toEqual(['blob', 'tree', 'commit']);
  });
  test('successful non-draft/foreign PR response is ambiguous and prevents Linear update', async () => {
    const f = fixture(), open = f.github.openDraft;
    f.github.openDraft = async (...args) => ({ ...await open(...args), isDraft: false });
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome_reconciliation_required');
    expect(f.writes.some(w => w.name === 'linear')).toBe(false);
  });
  test('owner loss while remote write finishes latches outcome without more calls', async () => {
    const f = fixture(); let owned = true;
    f.options.assertOwner = () => { if (!owned) throw new Error('owner_lost'); };
    const create = f.github.createBlob;
    f.github.createBlob = async (...args) => { const result = await create(...args); owned = false; return result; };
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome_reconciliation_required');
    expect(f.writes.map(w => w.name)).toEqual(['blob']);
  });
  test('repository identity is rechecked before each write, including before uploading more reviewed bytes', async () => {
    const f = fixture(); let checks = 0;
    f.github.assertRepository = async () => { if (++checks === 3) throw new Error('repository_renamed'); };
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('unknown_outcome_reconciliation_required');
    expect(f.writes.map(w => w.name)).toEqual(['blob']);
  });
  test('funding/workflow authority is reobserved before every write and drift stops later effects',async()=>{
    const f=fixture(),create=f.github.createBlob;
    f.github.createBlob=async(...args)=>{const result=await create(...args);(f.authority.ci as any).workflowSha256='9'.repeat(64);return result;};
    await expect(publishStandingEngineeringDraft(f.options)).rejects.toThrow('authority_changed');
    expect(f.writes.map(w=>w.name)).toEqual(['blob']);
  });
});
describe('App-only GitHub bridge (mock network only)', () => {
  function app() {
    const credential: GitHubEngineeringInstallationCredential = { kind: 'app', appId: 1, installationId: 456, accountLogin: '707-Labs',
      token: 'secret-token-123456789012345', issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, permissions: { contents: 'write', pullRequests: 'write' } };
    const opens: unknown[] = [];
    const client: Pick<GitHubClient, 'engineeringInstallationCredential' | 'openPullRequest'> = {
      async engineeringInstallationCredential() { return credential; },
      async openPullRequest(args) { opens.push(args); return {} as PullRequestRef; },
    };
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = (async (url: any, init?: RequestInit) => { requests.push({ url: String(url), init }); return Response.json({ sha: COMMIT }); }) as typeof fetch;
    return { credential, client, requests, opens, fetcher };
  }
  test('PAT-only existing client is rejected at construction', () => {
    const a = app(); delete a.client.engineeringInstallationCredential;
    expect(() => createStandingPublicationGitHub(a.client, { appId: 1, installationId: 456 }, a.fetcher)).toThrow('app_required'); expect(a.requests).toEqual([]);
  });
  test('fresh App identity mismatch cannot issue Git write', async () => {
    const a = app(); a.credential.installationId = 999;
    const adapter = createStandingPublicationGitHub(a.client, { appId: 1, installationId: 456 }, a.fetcher);
    await expect(adapter.createBlob('707-Labs/example', 'eA==')).rejects.toThrow('app_authority'); expect(a.requests).toEqual([]);
  });
  test('bounded no-redirect Git Data call and existing App draft adapter', async () => {
    const a = app(), adapter = createStandingPublicationGitHub(a.client, { appId: 1, installationId: 456 }, a.fetcher);
    expect(await adapter.createBlob('707-Labs/example', 'eA==')).toBe(COMMIT);
    expect(a.requests[0]!.url).toBe('https://api.github.com/repos/707-Labs/example/git/blobs');
    expect(a.requests[0]!.init?.redirect).toBe('error'); expect(a.requests[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    await adapter.openDraft('707-Labs/example', 'gary/engineering/' + 'a'.repeat(32), 'main', 'title', 'body');
    expect(a.opens).toEqual([{ owner: '707-Labs', repo: 'example', head: 'gary/engineering/' + 'a'.repeat(32), base: 'main', title: 'title', body: 'body', draft: true }]);
    await expect(adapter.createBranch('707-Labs/example', 'main', COMMIT)).rejects.toThrow('branch_not_owned');
  });
  test('successor uses expected-head atomic GraphQL and exact base64 bytes; never REST force update',async()=>{
    const a=app(),f=fixture(),requests:any[]=[];
    const fetcher=(async(url:any,init?:RequestInit)=>{requests.push({url:String(url),body:JSON.parse(String(init?.body))});
      return Response.json({data:{createCommitOnBranch:{commit:{oid:COMMIT,tree:{oid:TREE},parents:{nodes:[{oid:BASE}]}}}}});}) as typeof fetch;
    const adapter=createStandingPublicationGitHub(a.client,{appId:1,installationId:456},fetcher);
    expect(await adapter.advanceDraft!('707-Labs/example','gary/engineering/'+'a'.repeat(32),BASE,f.artifact.capture,'Headline\n\nDetails'))
      .toEqual({sha:COMMIT,tree:TREE,parents:[BASE]});
    expect(requests).toHaveLength(1);expect(requests[0].url).toBe('https://api.github.com/graphql');
    expect(requests[0].body.variables.input).toEqual({branch:{repositoryNameWithOwner:'707-Labs/example',branchName:'gary/engineering/'+'a'.repeat(32)},
      expectedHeadOid:BASE,message:{headline:'Headline',body:'\nDetails'},fileChanges:{additions:[{path:'src/answer.ts',contents:f.artifact.capture.files[0]!.base64}],deletions:[]}});
  });
  test.each(['new-executable','existing-executable','truncated'] as const)('mode/tree preflight rejects %s before mutation',async kind=>{
    const a=app(),methods:string[]=[];
    const fetcher=(async(_u:any,init?:RequestInit)=>{methods.push(init?.method??'GET');return Response.json({sha:BASETREE,truncated:kind==='truncated',
      tree:[{path:'src/a.ts',type:'blob',mode:kind==='existing-executable'?'100755':'100644'}]});}) as typeof fetch;
    const adapter=createStandingPublicationGitHub(a.client,{appId:1,installationId:456},fetcher);
    await expect(adapter.assertSuccessorFiles!('707-Labs/example',BASETREE,[{path:'src/a.ts',type:'blob',mode:kind==='new-executable'?'100755':'100644',sha:COMMIT}])).rejects.toThrow('standing_publication:');
    expect(methods.every(m=>m==='GET')).toBe(true);
  });
});

describe('wired host publication adapter with canonical App/Linear interfaces',()=>{
  function host() {
    const f=fixture(),requests:{method:string;path:string}[]=[],controller=new AbortController();let credentials=0;
    const hooks:{afterRequest?:(method:string,path:string)=>void}={};
    const credential:GitHubEngineeringInstallationCredential={kind:'app',appId:1,installationId:456,accountLogin:'707-Labs',
      token:'offline-app-token-1234567890',issuedAtMs:Date.now(),expiresAtMs:Date.now()+60_000,permissions:{contents:'write',pullRequests:'write'}};
    const github:Pick<GitHubClient,'engineeringInstallationCredential'|'openPullRequest'>={
      async engineeringInstallationCredential(){credentials++;return credential;},async openPullRequest(){throw Error('unbounded legacy PR client must not run');}};
    let branch='',body='';
    const pr=()=>({number:42,html_url:'https://github.com/707-Labs/example/pull/42',head:{sha:COMMIT,ref:branch,repo:{full_name:'707-Labs/example'}},
      base:{sha:BASE,ref:'main',repo:{full_name:'707-Labs/example'}},state:'open',merged:false,draft:true,created_at:'2026-01-01T00:00:00Z',body});
    const fetcher=(async(url:any,init?:RequestInit)=>{
      const path=new URL(String(url)).pathname.replace('/repos/707-Labs/example',''),method=init?.method??'GET';requests.push({method,path});
      hooks.afterRequest?.(method,path);
      const data=init?.body?JSON.parse(String(init.body)):undefined;
      expect(init?.redirect).toBe('error');expect(init?.signal).toBeInstanceOf(AbortSignal);
      if(path==='')return Response.json({id:123,full_name:'707-Labs/example',archived:false,disabled:false});
      if(path.startsWith('/git/ref/heads/')){const ref=decodeURIComponent(path.slice('/git/ref/heads/'.length)),sha=f.refs.get(ref);
        return sha?Response.json({ref:'refs/heads/'+ref,object:{type:'commit',sha}}):new Response('',{status:404});}
      if(path.startsWith('/git/commits/')&&method==='GET'){const sha=path.split('/').at(-1);return Response.json({sha,tree:{sha:sha===BASE?BASETREE:TREE},parents:sha===BASE?[]:[{sha:BASE}]});}
      if(path==='/git/blobs')return Response.json({sha:blob(Buffer.from(data.content,'base64'))});
      if(path==='/git/trees')return Response.json({sha:TREE});
      if(path==='/git/commits')return Response.json({sha:COMMIT});
      if(path==='/git/refs'){branch=data.ref.slice('refs/heads/'.length);f.refs.set(branch,data.sha);return Response.json({ref:data.ref,object:{sha:data.sha}});}
      if(path==='/pulls'){body=data.body;expect(data.draft).toBe(true);return Response.json(pr());}
      throw Error('unmocked '+method+' '+path);
    }) as typeof fetch;
    const adapter=createStandingEngineeringPublicationAdapter({db:f.options.db,github,app:{appId:1,installationId:456},
      linear:f.options.linear!,verifyArtifact:f.options.verifyArtifact,authorizePublication:(binding)=>f.options.authorizePublication(binding),fetch:fetcher});
    const input={proof:f.options.proof,assertOwner(){},signal:controller.signal,deadlineMs:Date.now()+60_000};
    return {...f,adapter,input,requests,controller,credential,hooks,credentials:()=>credentials};
  }
  test('inert construction then exact host proof publishes through fresh App credentials and canonical ticket comment once',async()=>{
    const f=host();expect(f.requests).toEqual([]);expect(f.credentials()).toBe(0);
    const receipt=await f.adapter.publish(f.input);expect(receipt.pullRequest.number).toBe(42);
    expect(f.requests.some(r=>r.method==='POST'&&r.path==='/pulls')).toBe(true);
    expect(f.writes.map(w=>w.name)).toEqual(['linear']);expect(f.credentials()).toBe(f.requests.length);
    const n=f.requests.length;expect(await f.adapter.publish(f.input)).toEqual(receipt);expect(f.requests).toHaveLength(n);expect(f.writes).toHaveLength(1);
    expect(f.adapter.lookup(receipt.publicationId).commit).toBe(COMMIT);
  });
  test.each(['repo','artifact','branch','workflow','runner','reservation','events','expiry'] as const)('CI %s binding rejects before App calls',async kind=>{
    const f=host(),ci=f.authority.ci as any;
    if(kind==='repo')ci.repositoryId=999;if(kind==='artifact')ci.artifactSha256='0'.repeat(64);if(kind==='branch')ci.branch='gary/foreign';
    if(kind==='workflow')ci.workflowSha256='';if(kind==='runner')ci.runnerIdentity='';if(kind==='reservation')ci.reservationId='';
    if(kind==='events')ci.events=['push','pull_request'];if(kind==='expiry')ci.expiresAtMs=0;
    await expect(f.adapter.publish(f.input)).rejects.toThrow('authority_or_ci');expect(f.requests).toEqual([]);expect(f.writes).toEqual([]);
  });
  test('aborted or expired invocation cannot verify, authorize or touch adapters',async()=>{
    const f=host();f.controller.abort();await expect(f.adapter.publish(f.input)).rejects.toThrow();expect(f.requests).toEqual([]);
    const g=host();g.input.deadlineMs=0;await expect(g.adapter.publish(g.input)).rejects.toThrow('deadline');expect(g.requests).toEqual([]);
  });
  test('abort after remote write dispatch remains unknown even if its response later succeeds',async()=>{
    const f=host();f.hooks.afterRequest=(method,path)=>{if(method==='POST'&&path==='/git/blobs')f.controller.abort();};
    await expect(f.adapter.publish(f.input)).rejects.toThrow('unknown_outcome');
    const n=f.requests.length;expect(f.writes).toEqual([]);
    await expect(f.adapter.publish({...f.input,signal:new AbortController().signal})).rejects.toThrow('unknown_outcome');
    expect(f.requests).toHaveLength(n);
  });
});
