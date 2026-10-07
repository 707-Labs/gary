/** Host evidence through the admitted Executor only. No global fetch or host filesystem reads. */
import type { Executor, ExecResult, RunOpts } from '../executors/index.ts';
import { createProgressGuard, type ProgressPolicy, type ProgressScope, type TrustedProgressSnapshot } from './progress-guard.ts';
import { buildTaskContext, contextualizeTaskManifest, type ContextMetadataReader, type ContextTaskDefinition,
  type InstructionSource, type TaskContextInput, type VerifiedTestReceipt } from './task-context.ts';
import { fingerprintBytes, fingerprintJson, unknownAuditModelState, type AuditTrace, type AuditPhase, type AuditFingerprint } from './audit-trace.ts';
import type { GaryRuntimeLauncher, GaryRuntimeManifest } from './gary-loop-adapter.ts';

/** Explicit opt-in example for a scoped coding task, not an automatically selected policy. */
export const SMALL_TASK_PROGRESS_POLICY: Readonly<ProgressPolicy> = Object.freeze({
  maxModelRequests: 24, maxModelRequestsWithoutProgress: 8, maxSuccessfulToolCalls: 80,
  toolRepeatWindow: 12, maxRepeatedToolCalls: 6,
});
export interface ProductionEvidenceOptions {
  executor: Executor;
  scope: ProgressScope;
  /** Canonical host task, never inferred from model text. */
  task: ContextTaskDefinition;
  /** Fixed full commit SHA admitted before the coding task. It never follows HEAD. */
  baseCommit: string;
  voicePrinciples: string;
  instructions: readonly InstructionSource[];
  policy: ProgressPolicy;
  deadlineMs: number;
  signal?: AbortSignal;
  assertAdmission(): void;
  allocationState(): TrustedProgressSnapshot['allocationState'];
  trace?: AuditTrace;
  phase?: () => AuditPhase;
  /** Explicit operator-approved redaction. Without this, retain hashes/lengths only. */
  redactOutput?: (text: string) => string | null;
}
export interface CommandEvidence {
  operationId: string;
  command: AuditFingerprint;
  exitCode: number;
  timedOut: boolean;
  stdout: AuditFingerprint;
  stderr: AuditFingerprint;
  preview?: { stdout: { head: string; tail: string }; stderr: { head: string; tail: string } };
}
interface GitEvidence {
  version: 1;
  baseCommit: string;
  head: string;
  changedFiles: string[];
  workspaceDigest: string;
  taskDiffDigest: string | null;
  statusDigest: string;
}
const fail = (code: string): never => { throw new Error('production_evidence_rejected:' + code); };
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digest = /^[a-f0-9]{64}$/;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const emptyWorkspaceDigest = fingerprintJson({ changedFiles: [], patches: [] }).sha256;

/** Runs INSIDE the existing admitted workspace executor. Git content stays there;
 * only hashes and exact changed paths are returned. No index or repository writes. */
const GIT_SNAPSHOT_SCRIPT = String.raw`
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const [base,allowedRaw]=process.argv.slice(1), allowed=JSON.parse(allowedRaw);
const hash=x=>createHash('sha256').update(x).digest('hex');
function git(args, ok=[0]) {
 const r=spawnSync('git',['--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.untrackedCache=false',...args],
  {encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_PAGER:'cat'}});
 if(r.error||r.signal||!ok.includes(r.status)) throw Error('git_snapshot_failed');
 return r.stdout;
}
const list=x=>x.split('\0').filter(Boolean);
const stable=x=>JSON.stringify(x);
try {
 if(git(['rev-parse','--verify',base+'^{commit}']).trim()!==base) throw Error('base_changed');
 const head=git(['rev-parse','--verify','HEAD']).trim();
 const status=git(['status','--porcelain=v1','-z','--untracked-files=all']);
 const tracked=list(git(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',base,'--']));
 const untracked=list(git(['ls-files','--others','--exclude-standard','-z']));
 const changedFiles=[...new Set([...tracked,...untracked])].sort();
 if(changedFiles.length>128||changedFiles.some(p=>p.length>512||/[\\\r\n*?\[\]:]/.test(p)||p.split('/').some(s=>!s||s==='.'||s==='..'))) throw Error('path_limit');
 const patches=changedFiles.filter(p=>allowed.includes(p)).map(path=>({path,sha256:hash(untracked.includes(path)
  ?git(['diff','--no-index','--no-ext-diff','--no-textconv','--binary','--','/dev/null',path],[0,1])
  :git(['diff','--no-ext-diff','--no-textconv','--no-renames','--binary',base,'--',path]))}));
 if(head!==git(['rev-parse','--verify','HEAD']).trim()||status!==git(['status','--porcelain=v1','-z','--untracked-files=all'])) throw Error('workspace_changed');
 const workspaceDigest=hash(stable({changedFiles,patches}));
 console.log(JSON.stringify({version:1,baseCommit:base,head,changedFiles,workspaceDigest,
  taskDiffDigest:changedFiles.length&&changedFiles.every(p=>allowed.includes(p))?workspaceDigest:null,statusDigest:hash(status)}));
} catch { console.error('git_snapshot_failed'); process.exit(1); }
`;

export function gitSnapshotCommand(baseCommit: string, allowedFiles: readonly string[]): string {
  if (!sha.test(baseCommit)) fail('invalid_base_commit');
  return 'set -euo pipefail\n# gary-hermes-git-evidence-v1\nnode -e ' + quote(GIT_SNAPSHOT_SCRIPT)
    + ' -- ' + quote(baseCommit) + ' ' + quote(JSON.stringify(allowedFiles));
}
function validateResult(result: ExecResult): void {
  if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || !Number.isSafeInteger(result.exitCode) || typeof result.timedOut !== 'boolean') fail('invalid_executor_result');
}
function preview(text: string): { head: string; tail: string } {
  const chars = [...text];
  return { head: chars.slice(0, 512).join(''), tail: chars.slice(-512).join('') };
}

/** One object per admitted task, shared across every phase and fixup. */
export async function createProductionEvidence(options: ProductionEvidenceOptions) {
  const task = structuredClone(options.task), scope = { ...options.scope }, baseCommit = options.baseCommit;
  if (task.taskId !== scope.taskId || !sha.test(options.baseCommit) || !Number.isFinite(options.deadlineMs)
      || typeof options.assertAdmission !== 'function' || typeof options.allocationState !== 'function') fail('invalid_configuration');
  const input: TaskContextInput = { task, voicePrinciples: options.voicePrinciples, instructions: structuredClone(options.instructions) };
  const commands = new Set(task.criteria.flatMap(criterion => [...criterion.requiredCommands]));
  if (commands.size > 32) fail('too_many_required_commands');
  let latest: GitEvidence = { version: 1, baseCommit, head: baseCommit,
    changedFiles: [], workspaceDigest: emptyWorkspaceDigest, taskDiffDigest: null, statusDigest: fingerprintBytes('').sha256 };
  const receipts = new Map<string, VerifiedTestReceipt>(), latestReceipts = new Map<string, string>();
  const diagnostics: CommandEvidence[] = [];
  let sequence = 0, operation = 0, receiptSequence = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const metadata: ContextMetadataReader = {
    readTaskEvidence(taskId) {
      if (taskId !== scope.taskId) fail('task_binding');
      return { taskId, patchRevision: latest.taskDiffDigest, changedFiles: [...latest.changedFiles],
        receiptIds: [...latestReceipts.values()], openBlockers: latest.changedFiles.some(path => !task.allowedFiles.includes(path))
          ? [{ id: 'scope-mismatch', reason: 'The current net diff includes files outside the admitted task scope.' }]
          : latest.taskDiffDigest === null ? [{ id: 'patch-missing', reason: 'No admitted task patch has been observed.' }] : [] };
    },
    readTestReceipt(receiptId) { return structuredClone(receipts.get(receiptId) ?? null); },
  };
  // Validate criteria, exact files and source deduplication before executor I/O.
  buildTaskContext(input, metadata);
  const guard = (signal?: AbortSignal) => {
    if (signal?.aborted || options.signal?.aborted || Date.now() >= options.deadlineMs) fail('cancelled');
    try { options.assertAdmission(); } catch { fail('admission_revoked'); }
    if (options.trace?.failed) fail('trace_failed');
  };
  const boundedOpts = (opts: RunOpts = {}): RunOpts => {
    const signals = [opts.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    return { ...opts, deadlineMs: Math.min(options.deadlineMs, opts.deadlineMs ?? Infinity),
      ...(signals.length ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) } : {}) };
  };
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = serial.then(work); serial = pending.then(() => {}, () => {}); return pending;
  };
  async function execute(command: string, opts: RunOpts = {}, retainPreview = false): Promise<ExecResult> {
    guard(opts.signal);
    const operationId = 'evidence-' + (++operation);
    options.trace?.append({ kind: 'tool', stage: 'start', operationId, toolName: 'run_bash', command: fingerprintBytes(command),
      iteration: 'unknown', phase: options.phase?.() ?? 'unknown', modelState: unknownAuditModelState() });
    let result!: ExecResult;
    try { result = await options.executor.run(command, boundedOpts(opts)); validateResult(result); }
    catch {
      if (options.trace && !options.trace.failed) options.trace.append({ kind: 'tool', stage: 'error', operationId, errorCode: 'tool_failed' });
      fail('executor_failed');
    }
    const evidence: CommandEvidence = { operationId, command: fingerprintBytes(command), exitCode: result.exitCode, timedOut: result.timedOut,
      stdout: fingerprintBytes(result.stdout), stderr: fingerprintBytes(result.stderr) };
    options.trace?.append({ kind: 'tool', stage: 'result', operationId, exitCode: result.exitCode, timedOut: result.timedOut,
      stdout: evidence.stdout, stderr: evidence.stderr });
    if (retainPreview && options.redactOutput) {
      let stdout!: string | null, stderr!: string | null;
      try { stdout = options.redactOutput(result.stdout); stderr = options.redactOutput(result.stderr); } catch { fail('redactor_failed'); }
      if (typeof stdout === 'string' && typeof stderr === 'string') evidence.preview = { stdout: preview(stdout), stderr: preview(stderr) };
    }
    diagnostics.push(evidence); if (diagnostics.length > 128) diagnostics.shift();
    guard(opts.signal);
    return result;
  }
  async function captureRaw(signal?: AbortSignal): Promise<GitEvidence> {
    guard(signal);
    const result = await execute(gitSnapshotCommand(baseCommit, task.allowedFiles), signal ? { signal } : {});
    if (result.exitCode !== 0 || result.timedOut || Buffer.byteLength(result.stdout) > 128 * 1024) fail('git_snapshot_failed');
    let value!: GitEvidence;
    try { value = JSON.parse(result.stdout); } catch { fail('git_snapshot_invalid'); }
    if (!value! || value.version !== 1 || value.baseCommit !== baseCommit || !sha.test(value.head)
        || !digest.test(value.workspaceDigest) || !digest.test(value.statusDigest)
        || (value.taskDiffDigest !== null && !digest.test(value.taskDiffDigest)) || !Array.isArray(value.changedFiles)
        || value.changedFiles.length > 128 || value.changedFiles.some(path => typeof path !== 'string')
        || new Set(value.changedFiles).size !== value.changedFiles.length
        || (value.taskDiffDigest !== null && (value.taskDiffDigest !== value.workspaceDigest || value.changedFiles.length === 0
          || value.changedFiles.some(path => !task.allowedFiles.includes(path))))) fail('git_snapshot_invalid');
    // Context validation applies exact relative-path constraints to executor output.
    latest = structuredClone(value);
    buildTaskContext(input, metadata);
    return value;
  }
  async function snapshotRaw(signal?: AbortSignal): Promise<TrustedProgressSnapshot> {
    const git = await captureRaw(signal);
    guard(signal);
    const state = options.allocationState();
    if (!['active', 'exhausted', 'closed'].includes(state)) fail('allocation_state_invalid');
    return { scope: { ...scope }, sequence: sequence++, allocationState: state,
      workspace: { baselineDigest: emptyWorkspaceDigest, currentDigest: git.workspaceDigest,
        taskDiff: git.taskDiffDigest && git.changedFiles.length > 0 && git.changedFiles.every(path => task.allowedFiles.includes(path))
          ? { digest: git.taskDiffDigest, changedFileCount: git.changedFiles.length, acceptanceIds: task.criteria.map(criterion => criterion.id) } : null },
      testRuns: [...latestReceipts.values()].map(id => receipts.get(id)!).map(receipt => ({ runId: receipt.receiptId,
        origin: receipt.origin, status: !receipt.completed || receipt.cancelled ? 'incomplete' as const : receipt.exitCode === 0 ? 'passed' as const : 'failed' as const,
        workspaceDigest: receipt.patchRevision ?? emptyWorkspaceDigest, taskDiffDigest: receipt.patchRevision,
        acceptanceIds: task.criteria.filter(criterion => criterion.requiredCommands.includes(receipt.command)).map(criterion => criterion.id) })) };
  }
  const baseline = await queue(() => snapshotRaw());
  const progress = createProgressGuard({ scope, acceptanceIds: task.criteria.map(criterion => criterion.id),
    policy: options.policy, baseline, readTrustedSnapshot: signal => queue(() => snapshotRaw(signal)) });
  async function checkedRead<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    guard(signal);
    let value!: T;
    try { value = await run(); } catch { guard(signal); fail('executor_failed'); }
    guard(signal); return value;
  }
  const executor: Executor = {
    workspaceRoot: options.executor.workspaceRoot,
    readFile: (path, opts) => checkedRead(() => options.executor.readFile(path, boundedOpts(opts)), opts?.signal),
    listFiles: (path, opts) => checkedRead(() => options.executor.listFiles(path, boundedOpts(opts)), opts?.signal),
    grep: (pattern, path, opts) => checkedRead(() => options.executor.grep(pattern, path, boundedOpts(opts)), opts?.signal),
    writeFile: (path, content, opts) => queue(async () => {
      guard(opts?.signal); await options.executor.writeFile(path, content, boundedOpts(opts)); guard(opts?.signal);
    }),
    run: (command, opts = {}) => queue(async () => {
      guard(opts.signal);
      const recognized = commands.has(command);
      const before = recognized ? await captureRaw(opts.signal) : null;
      const result = await execute('set -euo pipefail\n' + command, opts, true);
      if (recognized) {
        const after = await captureRaw(opts.signal), origin = before?.taskDiffDigest ? 'task' : 'baseline';
        const receiptId = 'executor-check-' + (++receiptSequence);
        const receipt: VerifiedTestReceipt = { receiptId, taskId: task.taskId, sequence: receiptSequence,
          origin, patchRevision: before?.taskDiffDigest ?? null, command, completed: !result.timedOut && before?.workspaceDigest === after.workspaceDigest,
          cancelled: result.timedOut || !!opts.signal?.aborted, exitCode: result.exitCode, evidenceRef: 'executor:' + receiptId };
        receipts.set(receiptId, receipt);
        const key = origin + ':' + command, old = latestReceipts.get(key);
        if (old) receipts.delete(old);
        latestReceipts.set(key, receiptId);
      }
      return result;
    }),
  };
  const capture = (signal?: AbortSignal) => queue(() => snapshotRaw(signal));
  const contextSnapshot = async (signal?: AbortSignal) => { await capture(signal); return buildTaskContext(input, metadata); };
  const prepareManifest = async (
    manifest: Readonly<GaryRuntimeManifest>, signal?: AbortSignal,
  ): Promise<{ prompt: string }> => {
    await capture(signal);
    guard(signal);
    const contextual = contextualizeTaskManifest(manifest, { readContextInput: () => input, metadata });
    guard(signal);
    return { prompt: contextual.prompt };
  };
  return {
    executor, progress, capture, contextSnapshot, metadata, prepareManifest,
    /** Host loop-boundary invalidation after external verification/review. Await
     * before launching a fixup; no task definition, baseline or progress reset. */
    invalidateVerification(): Promise<void> {
      return queue(async () => {
        guard();
        receipts.clear();
        latestReceipts.clear();
      });
    },
    withContext(launch: GaryRuntimeLauncher): GaryRuntimeLauncher {
      return async (manifest, handle, signal) => {
        const prepared = await prepareManifest(manifest, signal);
        guard(signal);
        return launch(Object.freeze({ ...manifest, ...prepared }), handle, signal);
      };
    },
    async runPreparation(preparation: readonly string[], signal?: AbortSignal): Promise<readonly CommandEvidence[]> {
      if (preparation.length > 8 || preparation.some(command => !command.trim() || command.includes('\0'))) fail('invalid_preparation');
      const before = operation;
      for (const command of preparation) {
        const result = await executor.run(command, signal ? { signal } : {});
        if (result.exitCode !== 0 || result.timedOut) fail('preparation_failed');
      }
      return structuredClone(diagnostics.filter(item => Number(item.operationId.slice(9)) > before));
    },
    get diagnostics(): readonly CommandEvidence[] { return structuredClone(diagnostics); },
  };
}
