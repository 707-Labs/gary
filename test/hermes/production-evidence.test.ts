import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionEvidence, SMALL_TASK_PROGRESS_POLICY, type ProductionEvidenceOptions } from '../../src/hermes/production-evidence.ts';
import { runProcess } from '../../src/executors/process.ts';
import type { Executor, RunOpts } from '../../src/executors/index.ts';
import type { AuditTrace, AuditTraceEvent } from '../../src/hermes/audit-trace.ts';
import type { GaryRuntimeManifest } from '../../src/hermes/gary-loop-adapter.ts';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const CHECK = 'test -s task.ts';
async function fixture(overrides: Partial<ProductionEvidenceOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gary-production-evidence-')); roots.push(root);
  const calls: string[] = [];
  let active = true;
  const env = { PATH: '/opt/homebrew/bin:/Users/tanner/.bun/bin:/usr/bin:/bin', HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C' };
  const run = async (command: string, opts: RunOpts = {}) => runProcess('/bin/bash', ['-c', command], {
    ...opts, cwd: root, env: { ...env, ...opts.env }, timeoutMs: opts.timeoutMs ?? 10_000,
  });
  for (const command of ['git init -q', 'git config user.email fixture@example.invalid', 'git config user.name Fixture', 'git config core.hooksPath /dev/null']) {
    expect((await run(command)).exitCode).toBe(0);
  }
  writeFileSync(join(root, 'task.ts'), 'baseline\n'); writeFileSync(join(root, '.gitignore'), 'cache/\n');
  expect((await run('git add task.ts .gitignore')).exitCode).toBe(0);
  expect((await run('git commit -qm baseline')).exitCode).toBe(0);
  const baseCommit = (await run('git rev-parse HEAD')).stdout.trim();
  const executor: Executor = {
    workspaceRoot: root,
    readFile: async path => readFileSync(join(root, path), 'utf8'),
    writeFile: async (path, text) => { writeFileSync(join(root, path), text); },
    listFiles: async () => [], grep: async () => [],
    run: async (command, opts) => { calls.push(command); return run(command, opts); },
  };
  const options: ProductionEvidenceOptions = {
    executor, scope: { taskId: 'task-1', workspaceId: 'workspace-1', ownerEpoch: 'owner-1', allocationId: 'allocation-1' },
    task: { taskId: 'task-1', allowedFiles: ['task.ts', 'task.test.ts'],
      criteria: [{ id: 'shape', description: 'Implement the admitted task and verify it.', requiredCommands: [CHECK] }] },
    baseCommit, voicePrinciples: 'Keep Gary’s admitted voice exactly.',
    instructions: [{ source: 'AGENTS.md', text: 'Preserve task scope.' }, { source: 'CLAUDE.md', text: 'Preserve task scope.' }],
    policy: { ...SMALL_TASK_PROGRESS_POLICY }, deadlineMs: Date.now() + 60_000,
    assertAdmission() { if (!active) throw new Error('private revoked identity'); }, allocationState: () => 'active', ...overrides,
  };
  const evidence = await createProductionEvidence(options);
  return { root, calls, run, executor, options, evidence, revoke() { active = false; } };
}

describe('production evidence through actual offline Git/bash executor fixtures', () => {
  test('fresh net diff credits real edits, including new files; noop writes and baseline tests do not', async () => {
    const h = await fixture();
    const baseline = await h.evidence.capture();
    expect(baseline.workspace.currentDigest).toBe(baseline.workspace.baselineDigest);
    await h.evidence.executor.run(CHECK);
    expect((await h.evidence.contextSnapshot()).acceptance.criteria[0]!.testEvidence).toBe('pending');
    await h.evidence.executor.writeFile('task.ts', 'baseline\n'); await h.evidence.progress.beforeModelRequest();
    expect(h.evidence.progress.state.counters.progressAdvances).toBe(0);
    await h.evidence.executor.writeFile('task.ts', 'implementation\n'); await h.evidence.progress.beforeModelRequest();
    expect(h.evidence.progress.state.counters.diffAdvances).toBe(1);
    await h.evidence.executor.run(CHECK); await h.evidence.progress.beforeModelRequest();
    expect(h.evidence.progress.state.counters.testAdvances).toBe(1);
    const passed = await h.evidence.contextSnapshot();
    expect(passed.acceptance.criteria[0]!.testEvidence).toBe('satisfied');
    expect(passed.acceptance.finishApproved).toBe(false); expect(passed.acceptance.publicationApproved).toBe(false);
    await h.evidence.executor.writeFile('task.test.ts', 'new acceptance test\n');
    const first = await h.evidence.capture();
    await h.evidence.executor.writeFile('task.test.ts', 'changed acceptance test\n');
    const second = await h.evidence.capture();
    expect(first.workspace.taskDiff?.digest).not.toBe(second.workspace.taskDiff?.digest);
    expect((await h.evidence.contextSnapshot()).acceptance.criteria[0]!.testEvidence).toBe('pending');
  });

  test('host invalidation requires fresh check receipts without resetting progress or patch baseline', async () => {
    const h = await fixture();
    await h.evidence.executor.writeFile('task.ts', 'implementation\n');
    await h.evidence.executor.run(CHECK);
    await h.evidence.progress.beforeModelRequest();
    const passed = await h.evidence.contextSnapshot(), snapshot = await h.evidence.capture();
    const state = h.evidence.progress.state, calls = h.calls.length;
    expect(passed.acceptance.criteria[0]!.testEvidence).toBe('satisfied');
    const receipt = passed.acceptance.verifiedTestReceipts[0]!;
    await h.evidence.invalidateVerification();
    expect(h.calls.length).toBe(calls);
    expect(h.evidence.progress.state).toEqual(state);
    expect(h.evidence.metadata.readTestReceipt(receipt.receiptId)).toBeNull();
    const pending = await h.evidence.contextSnapshot();
    expect(pending.acceptance.criteria[0]!.testEvidence).toBe('pending');
    expect(pending.acceptance.criteria[0]!.receiptIds).toEqual([]);
    expect(pending.acceptance.verifiedTestReceipts).toEqual([]);
    expect(pending.acceptance.patchRevision).toBe(passed.acceptance.patchRevision);
    expect(pending.acceptance.allowedFiles).toEqual(passed.acceptance.allowedFiles);
    expect(pending.acceptance.criteria.map(({ id, description, requiredCommands }) => ({ id, description, requiredCommands })))
      .toEqual(passed.acceptance.criteria.map(({ id, description, requiredCommands }) => ({ id, description, requiredCommands })));
    expect((await h.evidence.capture()).workspace).toEqual(snapshot.workspace);
    await h.evidence.executor.run(CHECK);
    const rechecked = await h.evidence.contextSnapshot();
    expect(rechecked.acceptance.criteria[0]!.testEvidence).toBe('satisfied');
    expect(rechecked.acceptance.verifiedTestReceipts[0]!.receiptId).not.toBe(receipt.receiptId);
    expect(rechecked.acceptance.verifiedTestReceipts[0]!.sequence).toBeGreaterThan(receipt.sequence);
    await h.evidence.progress.beforeModelRequest();
    expect(h.evidence.progress.state.counters.progressAdvances).toBe(state.counters.progressAdvances);
    expect(rechecked.acceptance.finishApproved).toBe(false);
    expect(rechecked.acceptance.publicationApproved).toBe(false);
  });

  test('committing a patch does not erase its net difference against admitted base', async () => {
    const h = await fixture(); await h.evidence.executor.writeFile('task.ts', 'implementation\n');
    await h.evidence.executor.writeFile('task.test.ts', 'new test\n');
    const before = await h.evidence.capture();
    expect((await h.run('git add task.ts task.test.ts')).exitCode).toBe(0); expect((await h.run('git commit -qm implementation')).exitCode).toBe(0);
    expect((await h.run('git status --porcelain')).stdout).toBe('');
    const after = await h.evidence.capture();
    expect(after.workspace.taskDiff).toEqual(before.workspace.taskDiff);
    expect(after.workspace.currentDigest).not.toBe(after.workspace.baselineDigest);
  });

  test('outside-scope change blocks acceptance and receives no task progress', async () => {
    const h = await fixture(); await h.evidence.executor.writeFile('unexpected.ts', 'unrelated\n');
    const snapshot = await h.evidence.capture();
    expect(snapshot.workspace.taskDiff).toBeNull();
    const context = await h.evidence.contextSnapshot();
    expect(context.acceptance.scopeWithinAllowedFiles).toBe(false);
    expect(context.acceptance.openBlockers[0]?.id).toBe('scope-mismatch');
    await h.evidence.progress.beforeModelRequest(); expect(h.evidence.progress.state.counters.progressAdvances).toBe(0);
  });

  test('known checks and preparation use pipefail and never credit a masked installer failure', async () => {
    const h = await fixture({ task: { taskId: 'task-1', allowedFiles: ['task.ts'],
      criteria: [{ id: 'pipeline', description: 'Verify the actual exit status.', requiredCommands: ['false | true'] }] } });
    await h.evidence.executor.writeFile('task.ts', 'implementation\n');
    const result = await h.evidence.executor.run('false | true'); expect(result.exitCode).not.toBe(0);
    expect((await h.evidence.contextSnapshot()).acceptance.criteria[0]!.testEvidence).toBe('pending');
    await expect(h.evidence.runPreparation(['false | true'])).rejects.toThrow('production_evidence_rejected:preparation_failed');
    expect(h.calls.some(command => command === 'set -euo pipefail\nfalse | true')).toBe(true);
  });

  test('check that changes the patch is incomplete, and similar commands do not become receipts', async () => {
    const check = 'printf changed > task.ts';
    const h = await fixture({ task: { taskId: 'task-1', allowedFiles: ['task.ts'],
      criteria: [{ id: 'check', description: 'Check must not replace its own patch.', requiredCommands: [check] }] } });
    await h.evidence.executor.writeFile('task.ts', 'implementation\n'); await h.evidence.executor.run(check);
    const context = await h.evidence.contextSnapshot();
    expect(context.acceptance.verifiedTestReceipts[0]!.completed).toBe(false);
    expect(context.acceptance.criteria[0]!.testEvidence).toBe('pending');
    await h.evidence.executor.run(check + ' ');
    expect((await h.evidence.contextSnapshot()).acceptance.verifiedTestReceipts).toHaveLength(1);
  });

  test('phase launcher preserves criteria and exact instruction dedup after fresh evidence', async () => {
    const h = await fixture();
    const prompts: string[] = [];
    const launch = h.evidence.withContext(async manifest => { prompts.push(manifest.prompt); return {
      taskId: manifest.taskId, requestId: manifest.requestId, status: 'no_finish', publicationApproved: false,
    }; });
    const manifest: GaryRuntimeManifest = { taskId: 'task-1', requestId: 'phase-1', ownerEpoch: 'owner-1', capability: 'x'.repeat(40),
      modelBaseUrl: 'http://127.0.0.1/v1', executorUrl: 'http://127.0.0.1/tools/execute', stateUrl: 'http://127.0.0.1/tools/state',
      model: 'glm-5.3', prompt: 'Investigate this task.', systemPrompt: 'Gary', tools: [], maxIterations: 3, maxTokens: 100,
      temperature: .3, deadlineMs: Date.now() + 5000 };
    const original = structuredClone(manifest);
    const before = h.calls.length;
    const prepared = await h.evidence.prepareManifest(manifest, new AbortController().signal);
    expect(h.calls.length).toBe(before + 1);
    expect(Object.keys(prepared)).toEqual(['prompt']);
    expect(manifest).toEqual(original);
    await launch(manifest, async () => Response.json({}), new AbortController().signal);
    expect(prompts[0]).toBe(prepared.prompt);
    await h.evidence.executor.writeFile('task.ts', 'implementation\n'); await h.evidence.executor.run(CHECK);
    const next = { ...manifest, requestId: 'phase-2', prompt: 'Validate this task.' };
    const advanced = await h.evidence.prepareManifest(next);
    await launch(next, async () => Response.json({}), new AbortController().signal);
    expect(prompts[1]).toBe(advanced.prompt);
    expect(advanced.prompt).not.toBe(prepared.prompt);
    const cancelled = new AbortController(); cancelled.abort(); const after = h.calls.length;
    await expect(h.evidence.prepareManifest(next, cancelled.signal)).rejects.toThrow('production_evidence_rejected:cancelled');
    expect(h.calls.length).toBe(after);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt.split('Preserve task scope.')).toHaveLength(2);
      expect(prompt).toContain('"sources":["AGENTS.md","CLAUDE.md"]');
      expect(prompt).toContain('"id":"shape"');
    }
    expect(prompts[0]).toContain('"testEvidence":"pending"'); expect(prompts[1]).toContain('"testEvidence":"satisfied"');
  });

  test('trace and default diagnostics store hashes only; preview requires explicit redaction', async () => {
    const events: AuditTraceEvent[] = [];
    const trace: AuditTrace = { failed: false, binding: { taskId: 'task-1', requestId: 'request-1', actionId: 'action-1', ownerEpoch: 'owner-1' },
      append(event) { events.push(structuredClone(event)); }, close() {} };
    const h = await fixture({ trace }); await h.evidence.executor.run("printf 'SYNTHETIC-PRIVATE-OUTPUT'");
    expect(JSON.stringify(h.evidence.diagnostics)).not.toContain('SYNTHETIC-PRIVATE-OUTPUT');
    expect(JSON.stringify(events)).not.toContain('SYNTHETIC-PRIVATE-OUTPUT');
    expect(h.evidence.diagnostics.every(item => item.preview === undefined)).toBe(true);
    const previewed = await createProductionEvidence({ ...h.options, redactOutput: text => text.replaceAll('SYNTHETIC-PRIVATE-OUTPUT', '[redacted]') });
    await previewed.executor.run("printf 'SYNTHETIC-PRIVATE-OUTPUT'");
    expect(previewed.diagnostics.at(-1)?.preview?.stdout.head).toBe('[redacted]');
    expect(JSON.stringify(previewed.diagnostics)).not.toContain('SYNTHETIC-PRIVATE-OUTPUT');
  });

  test('revoked canonical admission prevents all subsequent executor capture and commands', async () => {
    const h = await fixture(); h.revoke(); const before = h.calls.length;
    await expect(h.evidence.capture()).rejects.toThrow('production_evidence_rejected:admission_revoked');
    await expect(h.evidence.executor.run('true')).rejects.toThrow('production_evidence_rejected:admission_revoked');
    expect(h.calls).toHaveLength(before);
  });

  test('shared cancellation prevents initialization I/O and reaches admitted executor commands', async () => {
    const h = await fixture(), controller = new AbortController();
    controller.abort(); const before = h.calls.length;
    await expect(createProductionEvidence({ ...h.options, signal: controller.signal })).rejects.toThrow('production_evidence_rejected:cancelled');
    expect(h.calls).toHaveLength(before);
    const active = new AbortController();
    const bounded = await createProductionEvidence({ ...h.options, signal: active.signal });
    let forwarded = false;
    h.options.executor.readFile = async (_path, opts) => { active.abort(); forwarded = !!opts?.signal?.aborted; return 'late private result'; };
    await expect(bounded.executor.readFile('task.ts')).rejects.toThrow('production_evidence_rejected:cancelled');
    expect(forwarded).toBe(true);
  });
});
