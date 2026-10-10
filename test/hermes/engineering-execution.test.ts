/** Real execution/session/journal/model/protocol/ledger, with only external
 * Docker, native worker and provider boundaries replaced by local fixtures. */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpendLedger } from '../../src/spend.ts';
import { createEngineeringExecution, type EngineeringExecutionOptions } from '../../src/hermes/engineering-execution.ts';
import { createEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';
import type { EngineeringTaskView } from '../../src/hermes/engineering-task-store.ts';
import type { EngineeringRuntimeConfig } from '../../src/hermes/engineering-config.ts';
import type { EngineeringNativeInput } from '../../src/hermes/engineering-native-launcher.ts';
import type { EngineeringCommandRunner } from '../../src/executors/engineering-session.ts';
import { createSqliteEngineeringSessionJournal } from '../../src/executors/engineering-session-journal.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';
import { gitSnapshotCommand } from '../../src/hermes/production-evidence.ts';

type Json = Record<string, unknown>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BASE = 'a'.repeat(40), FILE = 'src/value.ts', REQUIRED = 'bun test test/value.test.ts';
const FINAL = 'export const value = 3;\n';
const PATCH = 'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 0;\n+export const value = 3;\n';
const TOOL = { type: 'function', function: { name: 'terminal', description: 'Fixture terminal.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
function provider(content: unknown[], stop_reason = 'end_turn') {
  return { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content, stop_reason,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
interface Flags {
  nativeLaunch?: 'unknown' | 'proven_absent';
  testFails?: boolean;
  verifierMutatesOnRemoval?: boolean;
  executorRemovalUnknown?: boolean;
  reviewRejects?: boolean;
  providerUnknown?: boolean;
}
function fixture(flags: Flags = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-execution-fixture-')));
  const stateRoot = join(root, 'state'), workspacesRoot = join(root, 'workspaces');
  for (const p of [stateRoot, workspacesRoot]) mkdirSync(p, { mode: 0o700 });
  const author = join(workspacesRoot, 'author'), verifierRoot = join(workspacesRoot, 'verifier');
  const artifacts = join(stateRoot, 'artifacts'), snapshots = join(workspacesRoot, 'snapshots');
  for (const p of [artifacts, snapshots]) mkdirSync(p, { mode: 0o700 });
  function clone(path: string) {
    mkdirSync(path, { mode: 0o700 }); mkdirSync(join(path, '.git'), { mode: 0o700 }); mkdirSync(join(path, 'src'), { mode: 0o700 });
    writeFileSync(join(path, '.git', 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = https://github.com/707-Labs/fixture.git\nfetch = +refs/heads/*:refs/remotes/origin/*\n', { mode: 0o600 });
    writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n', { mode: 0o600 });
    writeFileSync(join(path, FILE), 'export const value = 0;\n', { mode: 0o644 });
  }
  clone(author);
  const ledger = new SpendLedger(join(root, 'spend.sqlite'));
  ledger.createCampaign('campaign', 5.65); ledger.enrollTicket('campaign', 'allocation', 5.65);
  const spendDb = new Database(join(root, 'spend.sqlite'), { readonly: true });
  const journalDb = new Database(join(root, 'engineering.sqlite'));
  journalDb.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  const journal = createSqliteEngineeringSessionJournal(journalDb);
  const authority = { authenticated: true as const, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
    surface: 'private_dm' as const, channelId: 'D123456789', threadTs: '1234567890.000001' };
  const repository = resolveEngineeringRepository('fixture', authority, [{ repositoryId: 1, installationId: 2,
    fullName: '707-Labs/fixture', appAccessible: true, contents: 'write', pullRequests: 'write',
    archived: false, disabled: false, sharedChannelIds: [] }]);
  const policy = createEngineeringTaskPolicy({ taskId: 'task', repository, baseCommit: BASE,
    allowedFiles: [FILE], requiredCommands: [REQUIRED], publication: 'patch_only' });
  const deadlineMs = Date.now() + 120_000;
  const task: EngineeringTaskView = { taskId: 'task', spec: { taskId: 'task', requestId: 'request', grantId: 'grant',
    scope: { teamId: authority.teamId, surface: authority.surface, audienceId: authority.requesterId, projectId: '707-labs:fixture' },
    repositoryId: '1', repository: repository.repo, baseCommit: BASE, policyHash: policy.fingerprint, allocationId: 'allocation', deadlineMs },
    scopeKey: 'fixture', state: 'running', ownerEpoch: 'owner', sessionId: 'session', cleanupConfirmed: false,
    updatedAtMs: Date.now(), workerState: 'not_observed' };
  const config: EngineeringRuntimeConfig = { version: 1, grantId: 'grant', allocationId: 'allocation', campaignId: 'campaign', root: stateRoot, workspacesRoot,
    repository: repository.repo, baseBranch: 'main', baseCommit: BASE, allowedFiles: [FILE], requiredCommands: [REQUIRED], deadlineMs: 1800000,
    workerImage: 'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab',
    executorImage: 'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c', bunCacheVolume: 'fixture-cache',
    dockerExecutable: '/usr/local/bin/docker', dockerSocketPath: '/Users/tanner/.colima/default/docker.sock', runtimeFiles: [],
    sourceRevision: 'b'.repeat(40), publication: 'patch_only', capMicros: 5650000,
    budget: { aggregatePath: join(root, 'aggregate.json'), auditDir: join(root, 'budget-admission'), runId: 'grant' } };
  const events: string[] = [], fences: string[] = [], requests: Json[] = [];
  const containers = new Map<string, { root: string; live: boolean; labels: Record<string, string> }>();
  let nativeLive = false, leaseHeld = false, releases = 0, acquired = 0, nativeInput: EngineeringNativeInput | undefined;
  const live = (root: string) => [...containers.values()].some(c => c.root === root && c.live);
  const phase = (root: string) => root === author ? 'author' : 'verifier';
  const runner: EngineeringCommandRunner = { synthetic: true,
    async run(invocation) {
      const args = invocation.argv, op = args[1]; let output = '', exitCode = 0;
      expect(invocation.env.HOME).toBe('/nonexistent'); expect(invocation.env).not.toHaveProperty('DEEPSEEK_API_KEY');
      if (op === 'create') {
        expect(leaseHeld).toBe(true);
        expect(args).toContain('--network=none'); expect(args).toContain('--cpus=2'); expect(args).toContain('--memory=4096m');
        const mount = args.find(a => a.startsWith('type=bind,src='))!;
        const root = mount.slice('type=bind,src='.length).split(',dst=')[0]!;
        const labels: Record<string, string> = {};
        args.forEach((arg, i) => { if (arg === '--label') { const [key, ...value] = args[i + 1]!.split('='); labels[key!] = value.join('='); } });
        const id = String(containers.size + 1).repeat(64);
        containers.set(id, { root, labels, live: false }); output = id; events.push(phase(root) + ':created');
      } else if (op === 'start') {
        const c = containers.get(args[2]!)!; c.live = true; events.push(phase(c.root) + ':started');
      } else if (op === 'ps') {
        const id = args.find(a => a.startsWith('id='))!.slice(3); output = containers.get(id)?.live ? id : '';
      } else if (op === 'inspect') {
        const id = args.at(-1)!, c = containers.get(id)!;
        output = JSON.stringify({ Id: id, Config: { Labels: c.labels } });
      } else if (op === 'rm') {
        const c = containers.get(args.at(-1)!)!;
        if (flags.executorRemovalUnknown && c.root === author) exitCode = 1;
        else {
          c.live = false; events.push(phase(c.root) + ':absent');
          if (c.root === author && existsSync(join(author, FILE))) writeFileSync(join(author, FILE), FINAL);
          if (c.root === verifierRoot && flags.verifierMutatesOnRemoval) writeFileSync(join(verifierRoot, FILE), 'late descendant mutation\n');
        }
      } else throw new Error('unexpected fake Docker control: ' + op);
      return { output, outputTruncated: false, exitCode, timedOut: false };
    },
    async start(invocation) {
      const id = invocation.argv[5]!, c = containers.get(id)!;
      expect(c?.live).toBe(true); expect(leaseHeld).toBe(true);
      const command = invocation.argv.at(-1)!; let output = '', exitCode = 0;
      if (command === 'bun install --frozen-lockfile --offline --ignore-scripts') events.push(phase(c.root) + ':offline-install');
      else if (command === 'fixture-edit') {
        expect(c.root).toBe(author); writeFileSync(join(author, FILE), 'export const value = 1;\n');
        writeFileSync(join(author, 'outside-scope.txt'), 'must never enter artifact\n'); events.push('native:edit');
      } else if (command === 'fixture-inspect') output = readFileSync(join(c.root, FILE), 'utf8');
      else if (command === gitSnapshotCommand(BASE, [FILE])) {
        expect(c.root).toBe(verifierRoot); events.push('verifier:snapshot');
        output = JSON.stringify({ baseCommit: BASE, head: BASE, changedFiles: [FILE], workspaceDigest: 'c'.repeat(64), taskDiffDigest: 'd'.repeat(64), statusDigest: 'e'.repeat(64) });
      } else if (command.startsWith('set -e\n') && command.includes('diff --no-ext-diff')) {
        expect(c.root).toBe(verifierRoot); output = PATCH; events.push('verifier:patch');
      } else if (command === REQUIRED) {
        expect(c.root).toBe(verifierRoot); expect(readFileSync(join(c.root, FILE), 'utf8')).toBe(FINAL);
        events.push('verifier:test'); exitCode = flags.testFails ? 1 : 0; output = exitCode ? 'fixture test failed' : 'fixture test passed';
      } else throw new Error('unexpected fixture command: ' + command);
      let read = false;
      return { async poll() { return { running: false, exitCode, timedOut: false }; },
        async read() { const result = { output: read ? '' : output, outputTruncated: false }; read = true; return result; },
        async stop() { events.push(phase(c.root) + ':cli-drained'); } };
    } };
  const options: EngineeringExecutionOptions = { task, config, policy, workspaceRoot: author, artifactsRoot: artifacts, snapshotDirectory: snapshots,
    journalDb, spendDb, ledger, tools: [TOOL], providerApiKey: 'fixture-host-only-key',
    session: { image: config.executorImage, runner, journal, resourceProfile: { cpus: 2, memoryMiB: 4096 } },
    assertOwner() {}, fence(reason) { fences.push(reason); },
    async acquireLease() {
      acquired++; expect(leaseHeld).toBe(false); leaseHeld = true; events.push('lease:held');
      return { signal: new AbortController().signal, assertHeld() { if (!leaseHeld) throw Error('fixture lease not held'); },
        async release(proof) {
          expect(proof).toEqual({ cleanupConfirmed: true }); expect(nativeLive).toBe(false);
          expect([...containers.values()].some(c => c.live)).toBe(false);
          releases++; leaseHeld = false; events.push('lease:released');
        } };
    },
    async prepareVerifier() {
      expect(nativeLive).toBe(false); expect(live(author)).toBe(false); expect(leaseHeld).toBe(true);
      const captured = JSON.parse(readFileSync(join(artifacts, 'source-files.json'), 'utf8'));
      expect(captured.files.map((f: Json) => f.path)).toEqual([FILE]);
      expect(Buffer.from(captured.files[0].base64, 'base64').toString()).toBe(FINAL);
      events.push('host:prepare-verifier'); clone(verifierRoot); return { workspaceRoot: verifierRoot };
    },
    async fetch(request) {
      const body = await request.json() as Json; requests.push(body);
      const intent = journalDb.query('SELECT state,ledger_attempt FROM engineering_model_requests ORDER BY rowid DESC LIMIT 1').get() as { state: string; ledger_attempt: number };
      expect(intent.state).toBe('in_flight'); expect(intent.ledger_attempt).toBeGreaterThan(0);
      const reservation = spendDb.query('SELECT state,reserved_micros FROM spend_attempts WHERE id=?').get(intent.ledger_attempt) as { state: string; reserved_micros: number };
      expect(reservation.state).toBe('reserved');
      expect(reservation.reserved_micros).toBe(body.max_tokens === 4090 ? 1_400_317 : 1_416_561);
      if (flags.providerUnknown) return Response.json({ ...provider([{ type: 'text', text: 'unknown' }]), usage: { input_tokens: 1 } });
      if (body.max_tokens === 4090) {
        expect(nativeLive).toBe(false); expect(live(author)).toBe(false); expect(live(verifierRoot)).toBe(false);
        expect(body.tools).toBeUndefined(); events.push('provider:review');
        const messages = body.messages as { role: string; content: { type: string; text: string }[] }[];
        const reviewInput = JSON.parse(messages[0]!.content[0]!.text);
        expect(reviewInput.patch).toBe(PATCH); expect(reviewInput.allowedFiles).toEqual([FILE]);
        expect(reviewInput.tests).toHaveLength(1); expect(reviewInput.tests[0].command).toBe(REQUIRED);
        return Response.json(provider([{ type: 'text', text: JSON.stringify({ verdict: flags.reviewRejects ? 'changes_needed' : 'approved', blockingFindings: flags.reviewRejects ? [{ description: 'fixture finding' }] : [] }) }]));
      }
      events.push('provider:work'); const n = requests.length;
      return Response.json(n <= 2 ? provider([{ type: 'tool_use', id: 'call-' + n, name: 'terminal',
        input: { command: n === 1 ? 'fixture-edit' : 'fixture-inspect' } }], 'tool_use') : provider([{ type: 'text', text: 'Fixture edit complete.' }]));
    },
    dependencies: { createLauncher: () => async (input, signal) => {
      nativeInput = input; nativeLive = true; events.push('native:launched');
      if (flags.nativeLaunch) {
        if (flags.nativeLaunch === 'proven_absent') { nativeLive = false; input.append({ kind: 'native_cleanup_confirmed' }); events.push('native:absent'); }
        throw Error('fixture native launch failed');
      }
      return { async turn({ turnId, prompt }) {
        input.model.beginTurn({ turnId, prompt }); let sequence = 0;
        const rpc = (kind: string, payload: Json) => input.protocol.accept({ protocol: 'gary.engineering.v1',
          taskId: input.binding.taskId, sessionId: input.binding.sessionId, ownerEpoch: input.binding.ownerEpoch,
          turnId, sequence: ++sequence, kind, payload }, input.transportCapability);
        let history = [...input.model.history()];
        for (let n = 0; n < 3; n++) {
          const response = await input.model.handle({ model: 'deepseek-v4-pro', messages: [{ role: 'system', content: input.systemPrompt }, ...history],
            tools: input.tools, max_tokens: 8192, stream: false, temperature: 0.3 }, signal);
          expect(response.status).toBe(200); history = [...input.model.history()];
          const calls = (response.body.choices as { message: { tool_calls?: { id: string; function: { arguments: string } }[] } }[])[0]!.message.tool_calls;
          if (!calls?.length) break;
          const call = calls[0]!, args = JSON.parse(call.function.arguments) as Json;
          const begin = await rpc('tool.begin', { toolCallId: call.id, toolName: 'terminal', originalArgs: args, effectiveArgs: args });
          expect(begin.ok).toBe(true);
          const common = { toolCallId: call.id, admissionId: begin.admissionId };
          const start = await rpc('environment.operation', { ...common, operation: 'execute', arguments: { operationId: `native-${n}-execute`, command: args.command, timeoutMs: 1000 } });
          expect(start.ok).toBe(true);
          const polled = await rpc('environment.operation', { ...common, operation: 'poll', arguments: { operationId: `native-${n}-poll`, processId: start.processId } });
          expect(polled.ok).toBe(true); expect(polled.status).toBe('exited');
          const result = JSON.stringify({ output: polled.output, exitCode: polled.exitCode }), resultHash = fingerprintJson(result).sha256;
          expect((await rpc('tool.end', { ...common, status: 'completed', resultHash, operationReceipts: [start.receiptId, polled.receiptId] })).ok).toBe(true);
          input.model.observeToolResult(call.id, resultHash);
          history.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        const messages = input.model.finishTurn(history);
        return { turnId, messages, finalResponse: 'Fixture edit complete.', nativeCompleted: true };
      }, async close() {
        nativeLive = false; events.push('native:absent');
        writeFileSync(join(author, FILE), 'export const value = 2;\n');
        input.append({ kind: 'native_cleanup_confirmed' }); return { cleanupConfirmed: true as const };
      } };
    } },
  };
  const execution = createEngineeringExecution(options);
  cleanups.push(async () => {
    await execution.cleanup().catch(() => {});
    journalDb.close(); spendDb.close(); ledger.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, author, verifierRoot, artifacts, execution, events, fences, requests, ledger, journalDb, spendDb,
    native: () => nativeInput!, state: () => ({ nativeLive, leaseHeld, releases, acquired, authorLive: live(author), verifierLive: live(verifierRoot) }) };
}
const signal = () => new AbortController().signal;

test('real pipeline binds native tool receipts, cleans writers before capture, verifies a fresh clone and records exact paid reservations', async () => {
  const f = fixture(), result = await f.execution.run('Implement the approved scoped edit.', signal());
  expect(result.completed).toBe(true);
  expect(f.events.indexOf('native:absent')).toBeLessThan(f.events.indexOf('author:absent'));
  expect(f.events.indexOf('author:absent')).toBeLessThan(f.events.indexOf('host:prepare-verifier'));
  expect(f.events.indexOf('verifier:test')).toBeLessThan(f.events.indexOf('verifier:absent'));
  expect(f.events.indexOf('verifier:absent')).toBeLessThan(f.events.indexOf('provider:review'));
  expect(f.state()).toMatchObject({ nativeLive: false, authorLive: false, verifierLive: false, leaseHeld: true, releases: 0 });
  expect(readFileSync(join(f.verifierRoot, FILE), 'utf8')).toBe(FINAL);
  expect(existsSync(join(f.verifierRoot, 'outside-scope.txt'))).toBe(false);
  const artifact = JSON.parse(readFileSync(join(f.artifacts, 'artifact.json'), 'utf8'));
  expect(artifact.changedFiles).toEqual([FILE]); expect(artifact.publication).toBe('disabled');
  expect(artifact.patchSha256).toBe(sha(PATCH)); expect(readFileSync(join(f.artifacts, 'patch.diff'), 'utf8')).toBe(PATCH);
  expect(artifact.tests).toHaveLength(1); expect(artifact.tests[0].artifactDigest).toBe(artifact.capturedFilesHash);
  expect(artifact.review).toEqual({ verdict: 'approved', blockingFindings: [] });
  expect(f.requests.map(r => r.max_tokens)).toEqual([8192, 8192, 8192, 4090]);
  expect(f.spendDb.query('SELECT max_tokens,reserved_micros,state FROM spend_attempts ORDER BY id').all()).toEqual([
    { max_tokens: 8192, reserved_micros: 1416561, state: 'settled' }, { max_tokens: 8192, reserved_micros: 1416561, state: 'settled' },
    { max_tokens: 8192, reserved_micros: 1416561, state: 'settled' }, { max_tokens: 4090, reserved_micros: 1400317, state: 'settled' },
  ]);
  expect(f.ledger.status('allocation')).toMatchObject({ capMicros: 5650000, campaignCapMicros: 5650000, attemptCount: 4, unknownAttempts: 0 });
  expect(f.spendDb.query('SELECT sum(reserved_micros) total FROM spend_attempts').get()).toEqual({ total: 5650000 });
  expect(f.journalDb.query("SELECT count(*) n FROM engineering_execution_receipts WHERE kind='operation_result'").get()).toEqual({ n: 4 });
  await expect(f.native().model.review({ prompt: 'duplicate', systemPrompt: 'Review.', signal: signal() })).rejects.toThrow();
  expect(f.requests).toHaveLength(4);
  const cleanup = await f.execution.cleanup(); expect(cleanup).toMatchObject({ taskId: 'task', sessionId: 'session', ownerEpoch: 'owner', absent: true });
  expect(await f.execution.cleanup()).toEqual(cleanup); expect(f.state().releases).toBe(1);
  const reopened = new Database(join(f.root, 'engineering.sqlite'));
  try {
    const row = reopened.query('SELECT state_json FROM engineering_session_journal_v1 WHERE task_id=?').get('task') as { state_json: string };
    const state = JSON.parse(row.state_json);
    expect(state.activeSessionId).toBeNull(); expect(state.cleanupUncertain).toBe(false);
    expect(Object.values(state.sessions).map((s: any) => s.phase)).toEqual(['closed', 'closed']);
  } finally { reopened.close(); }
  expect(f.fences).toEqual([]);
});

test('concurrent or later run requests cannot reacquire a lease or dispatch another physical model call', async () => {
  const f = fixture();
  const first = f.execution.run('Implement the approved scoped edit.', signal());
  await expect(f.execution.run('Duplicate concurrent request.', signal())).rejects.toThrow('execution_already_consumed');
  await first;
  await expect(f.execution.run('Duplicate completed request.', signal())).rejects.toThrow('execution_already_consumed');
  expect(f.state().acquired).toBe(1); expect(f.requests).toHaveLength(4);
  await f.execution.cleanup();
  await expect(f.execution.run('Duplicate after cleanup.', signal())).rejects.toThrow('execution_already_consumed');
  expect(f.state()).toMatchObject({ acquired: 1, releases: 1 }); expect(f.requests).toHaveLength(4);
});

test('cleanup before first run permanently prevents launch without acquiring resources or spending', async () => {
  const f = fixture();
  expect(await f.execution.cleanup()).toMatchObject({ absent: true });
  await expect(f.execution.run('Late launch.', signal())).rejects.toThrow('execution_already_consumed');
  expect(f.state()).toMatchObject({ acquired: 0, releases: 0, nativeLive: false, authorLive: false });
  expect(f.requests).toHaveLength(0); expect(f.ledger.status('allocation')?.attemptCount).toBe(0);
});

test('a failed required check cannot invoke review or publish an artifact and cleanup still drains both sessions', async () => {
  const f = fixture({ testFails: true });
  await expect(f.execution.run('Implement the approved scoped edit.', signal())).rejects.toThrow('verification_failed');
  expect(f.requests).toHaveLength(3); expect(f.events).not.toContain('provider:review');
  expect(existsSync(join(f.artifacts, 'artifact.json'))).toBe(false); expect(existsSync(join(f.artifacts, 'patch.diff'))).toBe(false);
  expect(f.state().leaseHeld).toBe(true);
  await f.execution.cleanup(); expect(f.state()).toMatchObject({ authorLive: false, verifierLive: false, nativeLive: false, releases: 1 });
});

test('a test descendant changing bytes during verifier removal is rejected before review', async () => {
  const f = fixture({ verifierMutatesOnRemoval: true });
  await expect(f.execution.run('Implement the approved scoped edit.', signal())).rejects.toThrow('verification_failed');
  expect(f.events).toContain('verifier:absent'); expect(f.requests).toHaveLength(3);
  expect(f.events).not.toContain('provider:review'); expect(existsSync(join(f.artifacts, 'artifact.json'))).toBe(false);
  await f.execution.cleanup(); expect(f.state().releases).toBe(1);
});

test('unknown native launch retains the lease and cannot record total absence even after exact executor removal', async () => {
  const f = fixture({ nativeLaunch: 'unknown' });
  await expect(f.execution.run('Implement the approved scoped edit.', signal())).rejects.toThrow('native launch failed');
  await expect(f.execution.cleanup()).rejects.toThrow('cleanup_unknown');
  expect(f.state()).toMatchObject({ nativeLive: true, authorLive: false, leaseHeld: true, releases: 0 });
  expect(f.fences).toContain('physical_cleanup_unconfirmed'); expect(f.requests).toHaveLength(0);
  expect(f.journalDb.query("SELECT count(*) n FROM engineering_execution_receipts WHERE kind='all_sandboxes_absent'").get()).toEqual({ n: 0 });
  await expect(f.execution.cleanup()).rejects.toThrow(); expect(f.state().releases).toBe(0);
});

test('a failed native launch with durable exact-absence evidence permits cleanup without spending', async () => {
  const f = fixture({ nativeLaunch: 'proven_absent' });
  await expect(f.execution.run('Implement the approved scoped edit.', signal())).rejects.toThrow('native launch failed');
  await f.execution.cleanup(); expect(f.state()).toMatchObject({ nativeLive: false, authorLive: false, releases: 1 });
  expect(f.requests).toHaveLength(0); expect(f.ledger.status('allocation')?.attemptCount).toBe(0);
});

test('uncertain executor removal prevents host capture, verifier preparation and resource release', async () => {
  const f = fixture({ executorRemovalUnknown: true });
  await expect(f.execution.run('Implement the approved scoped edit.', signal())).rejects.toThrow('cleanup_uncertain');
  await expect(f.execution.cleanup()).rejects.toThrow('cleanup_uncertain');
  expect(f.events).not.toContain('host:prepare-verifier'); expect(existsSync(join(f.artifacts, 'source-files.json'))).toBe(false);
  expect(f.state()).toMatchObject({ authorLive: true, nativeLive: false, leaseHeld: true, releases: 0 });
  const stored = f.journalDb.query('SELECT state_json FROM engineering_session_journal_v1 WHERE task_id=?').get('task') as { state_json: string };
  expect(JSON.parse(stored.state_json).cleanupUncertain).toBe(true); expect(f.requests).toHaveLength(3);
});

test('an ambiguous provider receipt cannot be replayed or reach review, but physical cleanup can release the lease', async () => {
  const f = fixture({ providerUnknown: true });
  await expect(f.execution.run('Implement the approved scoped edit.', signal())).rejects.toThrow('request_failed');
  expect(f.requests).toHaveLength(1); expect(f.ledger.status('allocation')?.unknownAttempts).toBe(1);
  await expect(f.native().model.handle({}, signal())).rejects.toThrow('inactive'); expect(f.requests).toHaveLength(1);
  expect(existsSync(join(f.artifacts, 'artifact.json'))).toBe(false);
  await f.execution.cleanup(); expect(f.state().releases).toBe(1);
});

test('an independent review rejection preserves scoped source evidence without a completed artifact', async () => {
  const f = fixture({ reviewRejects: true });
  await expect(f.execution.run('Implement the approved scoped edit.', signal())).rejects.toThrow('review_rejected');
  expect(f.requests).toHaveLength(4); expect(existsSync(join(f.artifacts, 'source-files.json'))).toBe(true);
  expect(existsSync(join(f.artifacts, 'artifact.json'))).toBe(false);
  await f.execution.cleanup(); expect(f.state().releases).toBe(1);
});
