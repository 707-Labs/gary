/** Real host orchestration/model/ledger/artifact APIs. External boundaries are
 * fixtures; local processes run only fixed synthetic-repository Git/read checks. */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { standingBudgetFixture } from './fixtures/engineering-standing.ts';
import { createEngineeringExecution, verifyStandingEngineeringArtifact, type EngineeringExecutionOptions } from '../../src/hermes/engineering-execution.ts';
import { createStandingEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';
import { createEngineeringVerificationProfile } from '../../src/hermes/engineering-verification-profile.ts';
import { createSqliteEngineeringSessionJournal } from '../../src/executors/engineering-session-journal.ts';
import type { EngineeringCommandRunner } from '../../src/executors/engineering-session.ts';
import type { EngineeringTaskView } from '../../src/hermes/engineering-task-store.ts';
import { gitRepositoryEvidenceRequest } from '../../src/hermes/production-evidence.ts';
import { fingerprintJson } from '../../src/hermes/audit-trace.ts';
import { createEngineeringScopedPersistence } from '../../src/hermes/engineering-scoped-persistence.ts';

type Json = Record<string, any>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });
const ROUTE = 'src/routes/$user/[id]/hello world.ts';
const FINAL = 'export const value = 3;\n';
const MANIFEST = JSON.stringify({ name: 'standing-fixture', private: true, scripts: { test: 'node verify.cjs' } }) + '\n';
const TOOL = { type: 'function', function: { name: 'terminal', description: 'Fixture terminal.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
const DELEGATE = { type: 'function', function: { name: 'delegate_task', description: 'Fixture child.',
  parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } } };
const ENV = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
function git(root: string, args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=', '-c', 'protocol.allow=never', ...args], { cwd: root, env: ENV, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) throw Error('synthetic_git_fixture_failed');
  return result.stdout.trim();
}
function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), content, { mode: 0o644 });
}
function clone(root: string): string {
  mkdirSync(root, { mode: 0o700 }); git(root, ['init', '--quiet', '--template=', '--initial-branch=main', '.']);
  git(root, ['config', '--local', 'core.hooksPath', '/dev/null']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/707-Labs/fixture.git']);
  write(root, 'package.json', MANIFEST); write(root, '.gitignore', 'node_modules/\n'); write(root, 'src/unchanged.ts', 'export const unchanged = true;\n');
  write(root, 'verify.cjs', `const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.equal(fs.readFileSync(${JSON.stringify(ROUTE)},'utf8'),${JSON.stringify(FINAL)}); console.log('synthetic route verified');\n`);
  git(root, ['add', '--', 'package.json', '.gitignore', 'verify.cjs', 'src/unchanged.ts']);
  git(root, ['commit', '--quiet', '--no-gpg-sign', '-m', 'Synthetic fixture base']);
  return git(root, ['rev-parse', '--verify', 'HEAD']);
}
function provider(content: unknown[], stop_reason = 'end_turn') {
  return { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek/deepseek-v4.1-flash', content, stop_reason,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
interface Flags { replaceCheck?: boolean; unexpectedAfterTest?: boolean; mutateDuringReview?: boolean; releaseFails?: boolean; routine?: boolean;
  delegate?: boolean; parentCloseFails?: boolean; childCloseFails?: boolean; candidateDependencies?: boolean; changeDelegatedGoal?: boolean;
  draftSkill?: 'document' | 'executable' }
function fixture(flags: Flags = {}) {
  const f = standingBudgetFixture(4_000_000); f.allocator.enrollPool(); const budget = f.allocator.allocate(f.input());
  const author = join(f.root, 'author'), verifier = join(f.root, 'verifier'), artifacts = join(f.root, 'artifacts'), snapshots = join(f.root, 'snapshots');
  mkdirSync(artifacts, { mode: 0o700 }); mkdirSync(snapshots, { mode: 0o700 });
  const base = clone(author), profile = createEngineeringVerificationProfile({ workspaceRoot: author });
  expect(profile.kind).toBe('javascript_npm'); expect(profile.dependencyCommands).toEqual([]);
  const required = profile.requiredCommands[0]!;
  const authority = { authenticated: true as const, requesterId: 'U0A9M5W16F8', teamId: 'T0AA24R7VUZ',
    surface: 'private_dm' as const, channelId: 'D123456789', threadTs: '1234567890.000001' };
  const repository = resolveEngineeringRepository('fixture', authority, [{ repositoryId: 1, installationId: 2,
    fullName: '707-Labs/fixture', appAccessible: true, contents: 'write', pullRequests: 'write', archived: false, disabled: false, sharedChannelIds: [] }]);
  const policy = createStandingEngineeringTaskPolicy({ taskId: budget.taskId, repository, baseCommit: base,
    requiredCommands: profile.requiredCommands, verificationProfileSha256: profile.hash, publication: 'patch_only', capMicros: budget.taskCapMicros });
  const task: EngineeringTaskView = { taskId: budget.taskId, spec: { taskId: budget.taskId, requestId: budget.requestId, grantId: 'grant',
    scope: { teamId: authority.teamId, surface: authority.surface, audienceId: authority.requesterId, projectId: '707-labs:fixture' },
    repositoryId: '1', repository: repository.repo, baseCommit: base, policyHash: policy.fingerprint, allocationId: budget.allocationId,
    deadlineMs: Date.now() + 120_000 }, scopeKey: 'fixture', state: 'running', ownerEpoch: 'owner', sessionId: 'session',
    cleanupConfirmed: false, updatedAtMs: Date.now(), workerState: 'not_observed' };
  const journalDb = new Database(join(f.root, 'journal.sqlite')), spendDb = new Database(f.path, { readonly: true });
  let scopedDb: Database | undefined;
  let persistence: ReturnType<typeof createEngineeringScopedPersistence> | undefined;
  if (flags.routine) {
    const root = join(f.root, 'scoped'); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, 'journals'), { mode: 0o700 });
    scopedDb = new Database(join(root, 'journals', 'scoped.sqlite')); chmodSync(scopedDb.filename, 0o600);
    persistence = createEngineeringScopedPersistence({ root, db: scopedDb, ledger: f.ledger, integrityKey: Buffer.alloc(32, 9) });
  }
  journalDb.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  const events: string[] = [], requests: Json[] = [], fences: string[] = [], dependencyProfiles: Json[] = [], childResults: Json[] = [];
  const children = new Map<string, string>(), nativeInputs: Json[] = [];
  const nativeSessions = new Set<string>();
  const containers = new Map<string, { root: string; live: boolean; labels: Record<string, string> }>();
  let nativeLive = false, held = false, released = 0;
  const live = (root: string) => [...containers.values()].some(c => c.root === root && c.live);
  const phase = (root: string) => root === author ? 'author' : root === verifier ? 'verifier' : 'child';
  const artifactPaths = flags.candidateDependencies ? ['package-lock.json', 'package.json', ROUTE] : [ROUTE];
  const runner: EngineeringCommandRunner = { synthetic: true,
    async run(invocation) {
      const args = invocation.argv, op = args[1]; let output = '';
      expect(invocation.env).not.toHaveProperty('OPENROUTER_API_KEY');
      if (op === 'create') {
        expect(held).toBe(true); expect(args).toContain('--network=none');
        const mount = args.find(value => value.startsWith('type=bind,src='))!;
        const root = mount.slice('type=bind,src='.length).split(',dst=')[0]!;
        expect([author, verifier, ...children.values()]).toContain(root);
        if (flags.candidateDependencies && root === verifier) {
          expect(args.some(arg => arg.includes('dst=/task/dependency-bundle,readonly'))).toBe(true);
        }
        const labels: Record<string, string> = {};
        args.forEach((arg, i) => { if (arg === '--label') { const [key, ...value] = args[i + 1]!.split('='); labels[key!] = value.join('='); } });
        const id = String(containers.size + 1).repeat(64); containers.set(id, { root, live: false, labels }); output = id;
        events.push(`${phase(root)}:created`);
      } else if (op === 'start') { const c = containers.get(args[2]!)!; c.live = true; events.push(`${phase(c.root)}:started`); }
      else if (op === 'ps') { const id = args.find(value => value.startsWith('id='))!.slice(3); output = containers.get(id)?.live ? id : ''; }
      else if (op === 'inspect') { const id = args.at(-1)!; output = JSON.stringify({ Id: id, Config: { Labels: containers.get(id)!.labels } }); }
      else if (op === 'rm') {
        const c = containers.get(args.at(-1)!)!; c.live = false; events.push(`${phase(c.root)}:absent`);
        if (c.root === verifier && flags.unexpectedAfterTest) write(verifier, 'src/unexpected.ts', 'unexpected source from check');
      } else throw Error('unexpected synthetic control');
      return { output, exitCode: 0, outputTruncated: false, timedOut: false };
    },
    async start(invocation) {
      const id = invocation.argv.find(value => containers.has(value))!, c = containers.get(id)!;
      expect(c.live).toBe(true); expect(held).toBe(true);
      const command = invocation.argv.at(-1)!; let output = '', exitCode = 0;
      if (command === 'fixture-author-edit') {
        expect(c.root).toBe(author); expect(existsSync(join(author, ROUTE))).toBe(false);
        if (flags.delegate) {
          expect(childResults).toHaveLength(1);
          const summary = JSON.parse(childResults[0]!.summary);
          expect(summary.integration).toContain('Not applied to parent');
          expect(summary.capture.files[0].path).toBe(ROUTE);
          expect(Buffer.from(summary.capture.files[0].base64, 'base64').toString()).toBe(FINAL);
          expect([...children.values()].every(root => !live(root))).toBe(true);
        }
        write(author, ROUTE, FINAL); if (flags.replaceCheck) write(author, 'package.json', JSON.stringify({ name: 'standing-fixture', scripts: { test: 'node -e "process.exit(0)"' } }));
        if (flags.candidateDependencies) {
          write(author, 'package.json', JSON.stringify({ ...JSON.parse(MANIFEST), dependencies: { 'fixture-dependency': '1.0.0' } }) + '\n');
          write(author, 'package-lock.json', JSON.stringify({ name: 'standing-fixture', lockfileVersion: 3, packages: {
            '': { name: 'standing-fixture', dependencies: { 'fixture-dependency': '1.0.0' } },
            'node_modules/fixture-dependency': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz', integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') },
          } }) + '\n');
        }
        events.push('author:edit');
      } else if (command === 'fixture-child-edit') {
        expect([...children.values()]).toContain(c.root);
        expect(existsSync(join(author, ROUTE))).toBe(false);
        write(c.root, ROUTE, FINAL); events.push('child:edit');
      } else if (command === 'fixture-install-candidate') {
        expect(c.root).toBe(verifier); events.push('verifier:dependencies-installed');
      } else if (command === 'fixture-author-prerequisite') {
        expect(c.root).toBe(author); events.push('author:dependencies-installed');
      } else {
        expect(c.root).toBe(verifier);
        const snapshot = gitRepositoryEvidenceRequest(base, artifactPaths), patch = gitRepositoryEvidenceRequest(base, artifactPaths, { patch: true });
        expect(command === snapshot.command || command === patch.command || command === required).toBe(true);
        if (command !== required) expect(invocation.stdin).toBe(snapshot.stdin);
        // These commands originate exclusively from production fixed templates
        // and this fixture's constant package/test files, never user content.
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
          cwd: verifier, env: { ...ENV, npm_config_cache: join(f.root, 'npm-cache'), npm_config_offline: 'true',
            npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
          input: invocation.stdin ?? '', timeout: 10_000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
        if (result.error || result.signal) throw Error('synthetic_command_failed');
        output = result.stdout; exitCode = result.status ?? 1;
        events.push(command === required ? 'verifier:test' : command === snapshot.command ? 'verifier:snapshot' : 'verifier:patch');
      }
      let read = false;
      return { async poll() { return { running: false, exitCode, timedOut: false }; },
        async read() { const value = { output: read ? '' : output, outputTruncated: false }; read = true; return value; },
        async stop() { events.push(`${phase(c.root)}:drained`); } };
    },
  };
  const options: EngineeringExecutionOptions = { task, policy, config: { root: f.root, runtimeFiles: [], dockerExecutable: '/usr/local/bin/docker', sourceRevision: 'a'.repeat(40) },
    workspaceRoot: author, artifactsRoot: artifacts, snapshotDirectory: snapshots, journalDb, spendDb, ledger: f.ledger,
    standingBudget: budget, verificationProfile: profile, baseRef: 'main', tools: flags.delegate ? [TOOL, DELEGATE] : [TOOL], providerApiKey: 'synthetic-host-only',
    ...(persistence ? { routine: { startedAtMs: task.spec.deadlineMs - 120_000, persistence,
      async prepareDependencies(input) {
        if (phase(input.workspaceRoot) !== 'child') expect(nativeLive || live(author) || live(verifier)).toBe(false);
        input.assertCurrent();
        expect(input.binding).toMatchObject({ taskId: task.taskId, sessionId: task.sessionId });
        expect(input.profile.requiredCommands).toEqual(profile.requiredCommands);
        dependencyProfiles.push({ phase: phase(input.workspaceRoot), hash: input.profile.hash, provenance: input.provenanceSha256 });
        events.push('dependencies:' + phase(input.workspaceRoot));
        if (flags.candidateDependencies && input.workspaceRoot === verifier) {
          expect(input.profile.hash).not.toBe(profile.hash);
          expect(input.profile.dependencyCommands).toEqual(['npm ci --offline --ignore-scripts --no-audit --no-fund']);
          mkdirSync(input.destination, { mode: 0o700 });
          return { root: input.destination, manifestSha256: 'd'.repeat(64), command: 'fixture-install-candidate', assertCurrent: input.assertCurrent };
        }
        if (flags.childCloseFails && input.workspaceRoot === author) {
          mkdirSync(input.destination, { mode: 0o700 });
          return { root: input.destination, manifestSha256: 'd'.repeat(64), command: 'fixture-author-prerequisite', assertCurrent: input.assertCurrent };
        }
        expect(input.profile.hash).toBe(profile.hash);
        return undefined;
      }, async prepareChild(input) {
        if (!flags.delegate) throw Error('unexpected_child_fixture');
        input.assertCurrent(); expect(held).toBe(true); expect(nativeLive).toBe(true);
        const workspaceRoot = join(f.root, 'child-' + input.ordinal), snapshotDirectory = join(f.root, 'child-snapshot-' + input.ordinal);
        expect(clone(workspaceRoot)).toBe(base); mkdirSync(snapshotDirectory, { mode: 0o700 });
        children.set(input.childId, workspaceRoot); events.push('child:prepare');
        return { workspaceRoot, snapshotDirectory };
      } } } : {}),
    session: { image: 'sha256:' + 'f'.repeat(64), runner, journal: createSqliteEngineeringSessionJournal(journalDb),
      resourceProfile: flags.routine ? { cpus: 1, memoryMiB: 2048 } : { cpus: 2, memoryMiB: 4096 } },
    assertOwner() { budget.assertCurrent(); }, fence(reason) { fences.push(reason); },
    async acquireLease() { held = true; events.push('lease:held');
      return { signal: new AbortController().signal, assertHeld() { if (!held) throw Error('fixture_lease_released'); }, async release() {
        expect(nativeLive || [...containers.values()].some(c => c.live)).toBe(false);
        if (flags.releaseFails) throw Error('fixture_release_failed');
        held = false; released++; events.push('lease:released');
      } }; },
    async prepareVerifier() {
      if (!flags.delegate) expect(nativeLive || live(author)).toBe(false);
      expect(held).toBe(true);
      expect(existsSync(join(artifacts, 'source-files.json'))).toBe(false);
      events.push('verifier:prepare'); expect(clone(verifier)).toBe(base);
      expect(existsSync(join(verifier, ROUTE))).toBe(false);
      expect(readFileSync(join(verifier, 'package.json'), 'utf8')).toBe(MANIFEST);
      return { workspaceRoot: verifier };
    },
    async fetch(request) {
      const body = await request.json() as Json; requests.push(body);
      expect(f.ledger.unresolvedAttempts(budget.allocationId)).toHaveLength(1);
      const row = journalDb.query('SELECT state,ledger_attempt FROM engineering_model_requests ORDER BY rowid DESC LIMIT 1').get() as Json;
      expect(row.state).toBe('in_flight'); expect(row.ledger_attempt).toBeGreaterThan(0);
      if (flags.draftSkill && body.max_tokens !== 4090 && !body.tools) {
        expect(nativeLive || [...containers.values()].some(c => c.live)).toBe(false);
        const origin = journalDb.query('SELECT purpose FROM engineering_model_request_origins ORDER BY rowid DESC LIMIT 1').get() as {purpose:string};
        expect(['skill_evaluation', 'skill_review']).toContain(origin.purpose);
        events.push('provider:' + origin.purpose);
        return Response.json(provider([{ type: 'text', text: JSON.stringify({ passed: true, reason: 'Fixture static inspection approved.' }) }]));
      }
      if (body.max_tokens === 4090) {
        expect(nativeLive || live(author) || live(verifier)).toBe(false); expect(body.tools).toBeUndefined();
        events.push('provider:review');
        const reviewInput = JSON.parse(body.messages[0].content[0].text);
        expect(reviewInput.allowedFiles).toEqual(artifactPaths); expect(reviewInput.patch).toContain('export const value = 3');
        expect(reviewInput.tests).toHaveLength(1); expect(reviewInput.tests[0].command).toBe(required);
        if (flags.mutateDuringReview) write(verifier, 'src/unchanged.ts', 'changed during review');
        return Response.json(provider([{ type: 'text', text: JSON.stringify({ verdict: 'approved', blockingFindings: [] }) }]));
      }
      events.push('provider:work');
      if (flags.delegate) {
        const content = requests.length === 1 ? provider([{ type: 'tool_use', id: 'delegate-call', name: 'delegate_task', input: { goal: 'Implement the route in a child clone.' } }], 'tool_use')
          : requests.length === 2 ? provider([{ type: 'tool_use', id: 'child-edit-call', name: 'terminal', input: { command: 'fixture-child-edit' } }], 'tool_use')
          : requests.length === 4 ? provider([{ type: 'tool_use', id: 'parent-edit-call', name: 'terminal', input: { command: 'fixture-author-edit' } }], 'tool_use')
          : provider([{ type: 'text', text: 'Synthetic edit complete.' }]);
        return Response.json(content);
      }
      return Response.json(requests.length === 1 ? provider([{ type: 'tool_use', id: 'edit-call', name: 'terminal', input: { command: 'fixture-author-edit' } }], 'tool_use')
        : provider([{ type: 'text', text: 'Synthetic edit complete.' }]));
    },
    dependencies: { createLauncher: () => async (input, signal) => {
      const child = input.binding.sessionId !== task.sessionId, nativePhase = child ? 'child-native' : 'native';
      nativeInputs.push(input);
      if (flags.routine) {
        expect(input.nativeContext?.tools).toEqual(flags.delegate && !child ? ['terminal', 'delegate_task'] : ['terminal']);
        expect(input.standingSession?.deadlineMs).toBe(task.spec.deadlineMs);
        expect(input.nativeContext?.delegationDepth).toBe(child ? 1 : 0);
        input.nativeContext!.assertCurrent();
        expect(input.binding.taskId).toBe(task.taskId); expect(input.binding.ownerEpoch).toBe(task.ownerEpoch!);
        if (child) {
          expect(input.nativeContext!.scopeKey).toBe(nativeInputs[0]!.nativeContext.scopeKey);
          expect(input.nativeContext!.homeDirectory).not.toBe(nativeInputs[0]!.nativeContext.homeDirectory);
          expect(existsSync(join(input.nativeContext!.homeDirectory, 'hermes', 'memory', 'MEMORY.md'))).toBe(false);
          expect(input.model.createChild).toBeUndefined(); expect(input.model.auxiliary).toBeUndefined();
        }
        writeFileSync(join(input.nativeContext!.homeDirectory, 'hermes', 'memory', 'MEMORY.md'), child ? 'Private child-only memory.' : 'Private scoped fixture memory.', { mode: 0o600 });
        if (flags.draftSkill && !child) {
          const draft = join(input.nativeContext!.draftSkillsDirectory, 'route-helper'); mkdirSync(draft, { mode: 0o700 });
          writeFileSync(join(draft, 'SKILL.md'), '# Route helper\nUse the existing project tools to verify route fixtures.', { mode: 0o600 });
          if (flags.draftSkill === 'executable') writeFileSync(join(draft, 'helper.py'), 'print("fixture")\n', { mode: 0o600 });
        }
      }
      expect(readFileSync(join(author, 'package.json'), 'utf8')).toBe(MANIFEST);
      expect(input.systemPrompt).toContain('add relevant new files');
      nativeSessions.add(input.binding.sessionId); nativeLive = true; events.push(nativePhase + ':launched');
      return { async turn({ turnId, prompt }) {
        input.model.beginTurn({ turnId, prompt }); let sequence = 0, history = [...input.model.history()];
        const rpc = (kind: string, payload: Json) => input.protocol.accept({ protocol: 'gary.engineering.v1',
          taskId: input.binding.taskId, sessionId: input.binding.sessionId, ownerEpoch: input.binding.ownerEpoch,
          turnId, sequence: ++sequence, kind, payload }, input.transportCapability);
        for (let n = 0; n < (flags.delegate && !child ? 3 : 2); n++) {
          const response = await input.model.handle({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'system', content: input.systemPrompt }, ...history],
            tools: input.tools, max_tokens: 8192, stream: false, temperature: 0.3 }, signal);
          expect(response.status).toBe(200); history = [...input.model.history()];
          const call = (response.body.choices as Json[])[0]!.message.tool_calls?.[0]; if (!call) break;
          const args = JSON.parse(call.function.arguments), begin = await rpc('tool.begin', { toolCallId: call.id, toolName: call.function.name, originalArgs: args, effectiveArgs: args });
          expect(begin.ok).toBe(true); const common = { toolCallId: call.id, admissionId: begin.admissionId };
          if (call.function.name === 'delegate_task') {
            const delegated = await rpc('task.operation', { ...common, operation: 'delegate.run',
              arguments: { operationId: 'delegate-run', taskIndex: 0, goal: flags.changeDelegatedGoal ? 'A different unobserved goal.' : args.goal, context: null } });
            if (!delegated.ok) throw Error('fixture_native_operation_failed');
            childResults.push(delegated.result as Json);
            expect(existsSync(join(author, ROUTE))).toBe(false);
            const result = JSON.stringify(delegated.result), resultHash = fingerprintJson(result).sha256;
            expect((await rpc('tool.end', { ...common, status: 'completed', resultHash, operationReceipts: [delegated.receiptId] })).ok).toBe(true);
            expect((await rpc('tool.presentation', { ...common, rawResultHash: resultHash, resultHash })).ok).toBe(true);
            input.model.observeToolResult(call.id, resultHash); history.push({ role: 'tool', tool_call_id: call.id, content: result });
            continue;
          }
          const start = await rpc('environment.operation', { ...common, operation: 'execute', arguments: { operationId: 'edit-execute', command: args.command, timeoutMs: 1000 } });
          expect(start.ok).toBe(true);
          const polled = await rpc('environment.operation', { ...common, operation: 'poll', arguments: { operationId: 'edit-poll', processId: start.processId } });
          expect(polled.ok).toBe(true);
          const result = JSON.stringify({ output: polled.output, exitCode: polled.exitCode }), resultHash = fingerprintJson(result).sha256;
          expect((await rpc('tool.end', { ...common, status: 'completed', resultHash, operationReceipts: [start.receiptId, polled.receiptId] })).ok).toBe(true);
          expect((await rpc('tool.presentation', { ...common, rawResultHash: resultHash, resultHash })).ok).toBe(true);
          input.model.observeToolResult(call.id, resultHash); history.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        return { turnId, messages: input.model.finishTurn(history), finalResponse: 'Synthetic edit complete.', nativeCompleted: true };
      }, async close() {
        if (child ? flags.childCloseFails : flags.parentCloseFails) { events.push(nativePhase + ':cleanup-unknown'); throw Error('fixture_native_cleanup_unknown'); }
        nativeSessions.delete(input.binding.sessionId); nativeLive = nativeSessions.size > 0;
        events.push(nativePhase + ':absent'); input.append({ kind: 'native_cleanup_confirmed' }); return { cleanupConfirmed: true as const };
      } };
    } },
  };
  const execution = createEngineeringExecution(options);
  cleanups.push(async () => { await execution.cleanup().catch(() => {}); journalDb.close(); spendDb.close(); scopedDb?.close(); f.dispose(); });
  return { ...f, budget, policy, author, verifier, artifacts, execution, requests, events, fences, journalDb, required,
    scopedDb, dependencyProfiles, childResults, nativeInputs, children, options,
    state: () => ({ nativeLive, authorLive: live(author), verifierLive: live(verifier), held, released }) };
}
const signal = () => new AbortController().signal;

test('routine composition rejects a legacy executor resource profile before acquiring a lease or dependencies', () => {
  const f = fixture({ routine: true });
  expect(() => createEngineeringExecution({ ...f.options, session: { ...f.options.session,
    resourceProfile: { cpus: 2, memoryMiB: 4096 } } })).toThrow('routine_resources');
  const { resourceProfile: _resources, ...withoutResourceProfile } = f.options.session;
  expect(() => createEngineeringExecution({ ...f.options, session: withoutResourceProfile })).toThrow('routine_resources');
  expect(f.events).toEqual([]); expect(f.requests).toEqual([]); expect(f.dependencyProfiles).toEqual([]);
  expect(f.state().held).toBe(false);
});

test('routine composition prepares both dependency profiles and checkpoints scoped memory only after writer cleanup', async () => {
  const f = fixture({ routine: true });
  const result = await f.execution.run('Implement the scoped synthetic route.', signal());
  expect(result.completed).toBe(true);
  expect(f.events.filter(e => e.startsWith('dependencies:'))).toEqual(['dependencies:author', 'dependencies:verifier']);
  const checkpoint = f.scopedDb!.query("SELECT body FROM engineering_scoped_records WHERE kind='checkpoint'").get() as {body:string};
  const saved = JSON.parse(checkpoint.body);
  expect(saved.taskId).toBe(f.budget.taskId);
  const snapshot = JSON.parse(readFileSync(join(f.root, 'scoped', 'sessions', saved.scopeKey, saved.sessionId, saved.snapshotHash, 'snapshot.json'), 'utf8'));
  expect(snapshot.files).toHaveLength(1);
  expect(Buffer.from(snapshot.files[0].contentBase64, 'base64').toString()).toBe('Private scoped fixture memory.');
  expect(f.requests).toHaveLength(3); // Empty drafts do not generate promotion calls.
  expect(JSON.stringify(f.journalDb.query('SELECT * FROM engineering_execution_receipts').all())).not.toContain('Private scoped');
  expect(f.state().held).toBe(false);
});

test('routine delegation meters one family, isolates the child clone/home, and requires parent integration before verification', async () => {
  const f = fixture({ routine: true, delegate: true });
  const result = await f.execution.run('Delegate the synthetic route then integrate it.', signal());
  expect(result.completed).toBe(true);
  expect(f.childResults).toHaveLength(1); expect(f.childResults[0]!.api_calls).toBe(2);
  expect(f.requests.map(request => request.max_tokens)).toEqual([8192, 8192, 8192, 8192, 8192, 4090]);
  expect(f.ledger.status(f.budget.allocationId)).toMatchObject({ attemptCount: 6, unknownAttempts: 0 });
  const origins = f.journalDb.query('SELECT * FROM engineering_model_request_origins ORDER BY rowid').all() as Json[];
  expect(origins.map(row => row.purpose)).toEqual(['parent_work', 'child_work', 'child_work', 'parent_work', 'parent_work', 'final_review']);
  expect(new Set(origins.map(row => row.allocation_id))).toEqual(new Set([f.budget.allocationId]));
  expect(new Set(origins.map(row => row.task_id))).toEqual(new Set([f.budget.taskId]));
  expect(origins[1]!.session_id).not.toBe(origins[0]!.session_id);
  expect(origins[1]!.session_id).toBe(origins[2]!.session_id);
  expect(f.journalDb.query('SELECT COUNT(*) AS count FROM engineering_model_owners').get()).toEqual({ count: 1 });
  expect(f.events.indexOf('child-native:absent')).toBeLessThan(f.events.indexOf('author:edit'));
  expect(f.events.indexOf('child:absent')).toBeLessThan(f.events.indexOf('author:edit'));
  expect(f.events.indexOf('author:edit')).toBeLessThan(f.events.indexOf('verifier:test'));
  expect(f.events.filter(e => e.startsWith('dependencies:'))).toEqual(['dependencies:author', 'dependencies:child', 'dependencies:verifier']);
  const checkpoint = JSON.parse((f.scopedDb!.query("SELECT body FROM engineering_scoped_records WHERE kind='checkpoint'").get() as {body:string}).body);
  const saved = readFileSync(join(f.root, 'scoped', 'sessions', checkpoint.scopeKey, checkpoint.sessionId, checkpoint.snapshotHash, 'snapshot.json'), 'utf8');
  expect(saved).not.toContain(Buffer.from('Private child-only memory.').toString('base64'));
  const artifact = verifyStandingEngineeringArtifact(f.execution.verifiedArtifactProof()!);
  expect(artifact.capture.files.map(file => file.path)).toEqual([ROUTE]);
  expect(readFileSync(join(f.artifacts, 'artifact.json'), 'utf8')).not.toContain('Private scoped');
  expect(f.execution.verifiedArtifactProof()).toBeDefined(); expect(f.state().released).toBe(1);
});

test('a changed delegated goal is rejected before creating a clone or charging child work', async () => {
  const f = fixture({ routine: true, delegate: true, changeDelegatedGoal: true });
  await expect(f.execution.run('Delegate the synthetic route.', signal())).rejects.toThrow('fixture_native_operation_failed');
  expect(f.children.size).toBe(0); expect(f.events).not.toContain('child:prepare');
  expect(f.requests).toHaveLength(1);
  expect(f.ledger.status(f.budget.allocationId)).toMatchObject({ attemptCount: 1, unknownAttempts: 0 });
  await f.execution.cleanup(); expect(f.state().released).toBe(1);
  expect(f.execution.verifiedArtifactProof()).toBeUndefined();
});

test('a child cleanup receipt cannot prove parent absence when parent close throws', async () => {
  const f = fixture({ routine: true, delegate: true, parentCloseFails: true });
  await expect(f.execution.run('Delegate and integrate the synthetic route.', signal())).rejects.toThrow('cleanup_unknown');
  expect(f.events).toContain('child-native:absent'); expect(f.events).toContain('native:cleanup-unknown');
  expect(f.events).not.toContain('verifier:test'); expect(f.events).not.toContain('provider:review');
  expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  await expect(f.execution.cleanup()).rejects.toThrow('cleanup_unknown');
  expect(f.state()).toMatchObject({ nativeLive: true, held: true, released: 0 });
  expect(f.fences).toContain('physical_cleanup_unconfirmed');
});

test('uncertain child cleanup fences delegation and keeps the shared lease without a publication proof', async () => {
  const f = fixture({ routine: true, delegate: true, childCloseFails: true });
  await expect(f.execution.run('Delegate the synthetic route.', signal())).rejects.toThrow('fixture_native_operation_failed');
  expect(f.events).toContain('child-native:cleanup-unknown');
  expect(f.events).not.toContain('author:edit'); expect(f.events).not.toContain('provider:review');
  await expect(f.execution.cleanup()).rejects.toThrow('cleanup_unknown');
  expect(f.events).toContain('native:absent'); expect(f.events).toContain('author:absent');
  expect(f.state()).toMatchObject({ nativeLive: true, held: true, released: 0 });
  expect(f.fences).toContain('child_cleanup_unknown'); expect(f.fences).toContain('native_task_operation_uncertain');
  expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  expect(f.scopedDb!.query("SELECT COUNT(*) AS count FROM engineering_scoped_records WHERE kind='checkpoint'").get()).toEqual({ count: 0 });
});

test('routine verification brokers candidate dependency bytes while retaining baseline check authority', async () => {
  const f = fixture({ routine: true, candidateDependencies: true });
  const result = await f.execution.run('Add the synthetic route and pinned dependency.', signal());
  expect(result.completed).toBe(true);
  expect(f.dependencyProfiles).toHaveLength(2);
  expect(f.dependencyProfiles[0]!.hash).not.toBe(f.dependencyProfiles[1]!.hash);
  expect(f.dependencyProfiles[0]!.provenance).toBe(f.policy.fingerprint.replace(/^sha256:/, ''));
  const proof = verifyStandingEngineeringArtifact(f.execution.verifiedArtifactProof()!);
  expect(f.dependencyProfiles[1]!.provenance).toBe(proof.capture.hash);
  expect(proof.requiredCommands).toEqual([f.required]);
  expect(f.events.indexOf('verifier:dependencies-installed')).toBeLessThan(f.events.indexOf('verifier:test'));
  expect(f.events.filter(e => e === 'verifier:dependencies-installed')).toHaveLength(1);
  expect(f.state().released).toBe(1);
});

test('routine dependency changes cannot replace baseline package scripts', async () => {
  const f = fixture({ routine: true, replaceCheck: true });
  await expect(f.execution.run('Synthetic route.', signal())).rejects.toThrow('verification_authority_changed');
  expect(f.events).not.toContain('dependencies:verifier'); expect(f.events).not.toContain('verifier:created');
  expect(f.events).not.toContain('provider:review'); expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  await f.execution.cleanup(); expect(f.state().released).toBe(1);
});

test('routine document skill promotion is privately scoped and uses newly settled work requests before final review', async () => {
  const f = fixture({ routine: true, draftSkill: 'document' });
  const result = await f.execution.run('Implement the synthetic route and draft its reusable guide.', signal());
  expect(result.completed).toBe(true); expect(f.requests).toHaveLength(5);
  expect(f.ledger.status(f.budget.allocationId)).toMatchObject({ attemptCount: 5, unknownAttempts: 0 });
  const origins = f.journalDb.query('SELECT * FROM engineering_model_request_origins ORDER BY rowid').all() as Json[];
  expect(origins.map(row => row.purpose)).toEqual(['parent_work', 'parent_work', 'skill_evaluation', 'skill_review', 'final_review']);
  expect(origins[2]!.context_id).not.toBe(origins[3]!.context_id);
  expect(new Set(origins.map(row => row.allocation_id))).toEqual(new Set([f.budget.allocationId]));
  const record = JSON.parse((f.scopedDb!.query("SELECT body FROM engineering_scoped_records WHERE kind='promotion_complete'").get() as {body:string}).body);
  expect(record.taskId).toBe(f.budget.taskId); expect(record.allocationId).toBe(f.budget.allocationId);
  expect(record.evaluationAttempts).toHaveLength(1); expect(record.reviewAttempts).toHaveLength(1);
  expect(record.evaluationAttempts[0]).not.toBe(record.reviewAttempts[0]);
  expect(f.events.indexOf('verifier:absent')).toBeLessThan(f.events.indexOf('provider:skill_evaluation'));
  expect(f.events.indexOf('provider:skill_review')).toBeLessThan(f.events.indexOf('provider:review'));
  const artifact = verifyStandingEngineeringArtifact(f.execution.verifiedArtifactProof()!);
  expect(artifact.capture.files.map(file => file.path)).toEqual([ROUTE]);
  expect(f.state().released).toBe(1);
});

test('an executable skill draft without sandbox evaluation stays unpromoted while verified coding work completes', async () => {
  const f = fixture({ routine: true, draftSkill: 'executable' });
  const result = await f.execution.run('Implement the synthetic route and draft an executable helper.', signal());
  expect(result.completed).toBe(true); expect(f.requests).toHaveLength(3);
  expect(f.scopedDb!.query("SELECT COUNT(*) AS count FROM engineering_scoped_records WHERE kind='promotion_complete'").get()).toEqual({ count: 0 });
  expect(f.events).not.toContain('provider:skill_evaluation'); expect(f.events).not.toContain('provider:skill_review');
  expect(f.execution.verifiedArtifactProof()).toBeDefined(); expect(f.state().released).toBe(1);
});

test('standing orchestration captures a new route, independently checks/reviews it, and mints proof only after cleanup', async () => {
  const f = fixture(); expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  const result = await f.execution.run('Implement the fixed synthetic route.', signal()); expect(result.completed).toBe(true);
  const proof = f.execution.verifiedArtifactProof()!, artifact = verifyStandingEngineeringArtifact(proof);
  expect(artifact.capture.files.map(file => file.path)).toEqual([ROUTE]);
  expect(artifact.artifactReceiptId).toBe(result.artifactReceiptId); expect(artifact.policyFingerprint).toBe(f.policy.fingerprint);
  expect(artifact.publication).toBe('patch_only'); expect(artifact.tests[0]!.artifactDigest).toBe(artifact.capture.hash);
  expect(artifact.review.artifactDigest).toBe(artifact.capture.hash); expect(artifact.cleanup).toMatchObject({ authorClosed: true, verifierClosed: true });
  expect(f.events.indexOf('author:edit')).toBeLessThan(f.events.indexOf('native:absent'));
  expect(f.events.indexOf('author:absent')).toBeLessThan(f.events.indexOf('verifier:prepare'));
  expect(f.events.indexOf('verifier:test')).toBeLessThan(f.events.indexOf('verifier:absent'));
  expect(f.events.indexOf('verifier:absent')).toBeLessThan(f.events.indexOf('provider:review'));
  expect(f.events.indexOf('provider:review')).toBeLessThan(f.events.indexOf('lease:released'));
  expect(f.state()).toEqual({ nativeLive: false, authorLive: false, verifierLive: false, held: false, released: 1 });
  expect(f.requests.map(request => request.max_tokens)).toEqual([8192, 8192, 4090]);
  expect(f.ledger.status(f.budget.allocationId)).toMatchObject({ attemptCount: 3, unknownAttempts: 0 });
  expect(readFileSync(join(f.verifier, ROUTE), 'utf8')).toBe(FINAL);
  expect(await f.execution.cleanup()).toMatchObject({ absent: true }); expect(f.state().released).toBe(1);
});

test('forged and deserialized opaque proofs are denied; valid proof rechecks unchanged source', async () => {
  expect(() => verifyStandingEngineeringArtifact({ artifactReceiptId: 'forged' })).toThrow('artifact_proof_untrusted');
  const f = fixture(); await f.execution.run('Synthetic route.', signal()); const proof = f.execution.verifiedArtifactProof()!;
  expect(() => verifyStandingEngineeringArtifact({ ...proof })).toThrow('artifact_proof_untrusted');
  expect(() => verifyStandingEngineeringArtifact(JSON.parse(JSON.stringify(proof)))).toThrow('artifact_proof_untrusted');
  write(f.verifier, 'src/unchanged.ts', 'post-review mutation');
  expect(() => verifyStandingEngineeringArtifact(proof)).toThrow('artifact_changed');
});

test('candidate package.json cannot replace the selected check and fails before verifier execution or review', async () => {
  const f = fixture({ replaceCheck: true });
  await expect(f.execution.run('Synthetic route.', signal())).rejects.toThrow('profile_changed');
  expect(f.events).toContain('verifier:prepare'); expect(f.events).not.toContain('verifier:created');
  expect(f.events).not.toContain('provider:review'); expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  await f.execution.cleanup(); expect(f.state().held).toBe(false);
});

test('unexpected source written after a passing test blocks review and opaque proof', async () => {
  const f = fixture({ unexpectedAfterTest: true });
  await expect(f.execution.run('Synthetic route.', signal())).rejects.toThrow('artifact_changed');
  expect(f.events).toContain('verifier:test'); expect(f.events).toContain('verifier:absent');
  expect(f.events).not.toContain('provider:review'); expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  await f.execution.cleanup(); expect(f.state().released).toBe(1);
});

test('source mutation during independent review is caught before saving an approved artifact', async () => {
  const f = fixture({ mutateDuringReview: true });
  await expect(f.execution.run('Synthetic route.', signal())).rejects.toThrow('artifact_changed');
  expect(f.events).toContain('provider:review'); expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  expect(existsSync(join(f.artifacts, 'artifact.json'))).toBe(false);
});

test('failed resource release never exposes a publication proof even after successful checks/review', async () => {
  const f = fixture({ releaseFails: true });
  await expect(f.execution.run('Synthetic route.', signal())).rejects.toThrow('fixture_release_failed');
  expect(f.events).toContain('provider:review'); expect(f.execution.verifiedArtifactProof()).toBeUndefined();
  expect(f.state()).toMatchObject({ nativeLive: false, authorLive: false, verifierLive: false, held: true, released: 0 });
});
