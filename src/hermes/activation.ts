/** Explicit canary activation. Loading/composing performs no network, spawn, enrollment or service change. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { z } from 'zod';
import { isSafeGitBranch, type PinnedGitBase } from '../git.ts';
import { createActionVerification, type ActionVerification } from '../verification-policy.ts';
import type { CodeActionAdmission } from './canonical-admission.ts';
import type { ExecutorJobJournal } from '../executors/index.ts';
import type { DB } from '../state/db.ts';
import type { SpendLedger } from '../spend.ts';
import type { LoopDeps } from '../loop.ts';
import { createHermesCodeLoopFactory, type ProductionTaskPolicy, type ProductionRuntimeOptions } from './production-runtime.ts';
import { createDockerRuntimeLauncher } from './docker-launcher.ts';
import { createAuditTrace, type AuditTraceBinding, type AuditTerminalStatus } from './audit-trace.ts';
import type { GaryRuntimeLauncher } from './gary-loop-adapter.ts';
import { buildTaskContext } from './task-context.ts';
import { createCodingTrial, type CodingTrial } from './coding-trial.ts';
import { HERMES_CODING_RUNTIME_POLICY, fingerprintHermesCodingActivation } from './coding-runtime-policy.ts';

export const HERMES_CANARY_WORKER_IMAGE = 'sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab';
export const HERMES_CODING_WORKER_IMAGE = 'sha256:8f728373dd6121e8031e113988c76eb561eb4758b2e3e701932e3a36ff991fcb';
export const HERMES_CANARY_CHILD_IMAGE = 'sha256:e77edfc6e20402c7ed9f447dca81dc61e277c2a39199963f455a37a03dfcedf4';
const MAX_CONFIG_BYTES = 262_144;
const text = (max: number) => z.string().min(1).max(max).refine(s => s.trim().length > 0 && !s.includes('\0'));
const unique = <T extends z.ZodTypeAny>(item: T, max: number, min = 0) => z.array(item).min(min).max(max).refine(a => new Set(a).size === a.length);
const filePath = text(512).refine(p => !/[\\\r\n*?\[\]:]/.test(p) && p.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const checkCommand = text(1024);
const url = text(4096).refine(s => { try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.hash; } catch { return false; } });
const fetchPolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('urls'), urls: unique(url, 128) }).strict(),
  z.object({ kind: z.literal('origins'), origins: unique(url.refine(s => new URL(s).origin === s), 128) }).strict(),
  z.object({ kind: z.literal('public') }).strict(),
]);
const progressSchema = z.object({
  maxModelRequests: z.number().int().min(1).max(10_000), maxModelRequestsWithoutProgress: z.number().int().min(1).max(10_000),
  maxSuccessfulToolCalls: z.number().int().min(1).max(10_000), toolRepeatWindow: z.number().int().min(1).max(256),
  maxRepeatedToolCalls: z.number().int().min(1).max(256),
}).strict().refine(p => p.maxModelRequestsWithoutProgress <= p.maxModelRequests && p.toolRepeatWindow <= p.maxSuccessfulToolCalls && p.maxRepeatedToolCalls <= p.toolRepeatWindow);
const criterion = z.object({ id: name, description: text(2048), requiredCommands: unique(checkCommand, 8, 1) }).strict();
const policySchema = z.object({
  task: z.object({ allowedFiles: unique(filePath, 128, 1), criteria: z.array(criterion).min(1).max(16).refine(a => new Set(a.map(c => c.id)).size === a.length) }).strict(),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/), baseBranch: z.string().refine(isSafeGitBranch).optional(), progress: progressSchema,
  instructions: z.array(z.object({ source: text(512), text: z.string().max(98_304).refine(s => !s.includes('\0')) }).strict()).max(64),
  voicePrinciples: text(65_536), readTicketIdentifiers: unique(z.string().regex(/^[A-Z]+-\d+$/), 256, 1),
  publicFetch: z.object({ policy: fetchPolicy }).strict(),
  cloudflare: z.object({ allowedServices: unique(text(512).refine(s => !/[\x00-\x1f]/.test(s)), 256), allowedDatabases: unique(text(512).refine(s => !/[\x00-\x1f]/.test(s)), 256) }).strict(),
  preparationCommands: unique(checkCommand, 8),
}).strict();
const activationSchema = z.object({
  version: z.literal(1), issueId: z.string().uuid(), repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  provider: z.literal('deepseek'), model: z.literal('deepseek-v4-pro'),
  workerImage: z.literal(HERMES_CODING_WORKER_IMAGE), childImage: z.literal(HERMES_CANARY_CHILD_IMAGE),
  dockerExecutable: z.literal('/usr/local/bin/docker'), dockerHost: z.literal('unix:///Users/tanner/.colima/default/docker.sock'),
  traceDirectory: text(4096), policy: policySchema,
}).strict();
export type HermesActivationConfig = z.infer<typeof activationSchema>;
const reject = (code: string): never => { throw new Error('hermes_activation_rejected:' + code); };
function freeze<T>(v: T): T { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }

/** Reject duplicate JSON keys rather than silently authorizing the last value. */
function parseStrictJson(raw: string): unknown {
  let at = 0;
  const space = () => { while (/\s/.test(raw[at] ?? '') && at < raw.length) at++; };
  const string = (): string => {
    space(); if (raw[at] !== '"') return reject('invalid_json'); const start = at++;
    while (at < raw.length) { const c = raw[at++]; if (c === '\\') { at++; continue; } if (c === '"') return JSON.parse(raw.slice(start, at)); }
    return reject('invalid_json');
  };
  const value = (depth: number): void => {
    if (depth > 64) reject('invalid_json'); space(); const c = raw[at];
    if (c === '"') { string(); return; }
    if (c === '{') {
      at++; space(); if (raw[at] === '}') { at++; return; } const keys = new Set<string>();
      for (;;) {
        const key = string(); if (keys.has(key)) reject('duplicate_json_key'); keys.add(key);
        space(); if (raw[at++] !== ':') reject('invalid_json'); value(depth + 1); space();
        if (raw[at] === '}') { at++; return; } if (raw[at++] !== ',') reject('invalid_json');
      }
    }
    if (c === '[') {
      at++; space(); if (raw[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); space(); if (raw[at] === ']') { at++; return; } if (raw[at++] !== ',') reject('invalid_json'); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at));
    if (!match) reject('invalid_json'); at += match![0].length;
  };
  try { value(0); space(); if (at !== raw.length) reject('invalid_json'); return JSON.parse(raw); }
  catch { return reject('invalid_json'); }
}
function privateDirectory(path: string): void {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(path) !== path) reject('directory_path');
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) reject('private_directory_required');
}
function validate(value: unknown): HermesActivationConfig {
  const parsed = activationSchema.safeParse(value);
  if (!parsed.success) reject('invalid_config');
  const config = parsed.data!;
  // Validate the actual runtime representation before classification can consume the only attempt.
  // Gary's largest admitted CODE phases are investigate=15, implement=35 (handlers/code.ts).
  const commands = new Set(config.policy.task.criteria.flatMap(criterion => criterion.requiredCommands));
  if (!commands.has('bun run check') || !commands.has(HERMES_CODING_RUNTIME_POLICY.verification.publicationCommand) || commands.size > 32) reject('invalid_production_checks');
  if (config.policy.progress.maxModelRequests < 50 || config.policy.progress.maxModelRequestsWithoutProgress <= 15) reject('invalid_production_phase_budget');
  try {
    buildTaskContext({ task: { ...config.policy.task, taskId: 'gary-action-9223372036854775807' },
      instructions: config.policy.instructions, voicePrinciples: config.policy.voicePrinciples }, {
      readTaskEvidence: taskId => ({ taskId, patchRevision: null, changedFiles: [], receiptIds: [], openBlockers: [] }),
      readTestReceipt: () => null,
    });
  } catch { reject('invalid_task_context'); }
  if (config.policy.preparationCommands.some(command => Buffer.byteLength(command) > 1024)) reject('invalid_preparation_command');
  privateDirectory(config.traceDirectory);
  return freeze(config);
}

/** Reads only this explicit, existing protected file; never searches or creates a config. */
export function loadHermesActivationConfig(path: string): HermesActivationConfig {
  let fd: number | undefined;
  try {
    privateDirectory(dirname(path));
    if (!isAbsolute(path) || path !== resolve(path) || realpathSync(path) !== path) reject('config_path');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size < 2 || before.size > MAX_CONFIG_BYTES) reject('private_config_required');
    const raw = readFileSync(fd);
    const after = fstatSync(fd), current = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || current.dev !== before.dev || current.ino !== before.ino || (after.mode & 0o777) !== 0o600 || after.nlink !== 1 || raw.length !== before.size) reject('config_changed');
    return validate(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  } catch { return reject('config_unavailable_or_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface RuntimeHealthEvidence {
  readonly actionId: string; readonly taskId: string; readonly requestId: string; readonly ownerEpoch: string;
  readonly ticketId: string; readonly tracePath: string; readonly terminalStatus: 'finished';
  readonly runtime: 'hermes'; readonly traceClosed: true; readonly completedAt: string;
  /** Outer deterministic checks/review/publication and allocation close are separate readiness gates. */
  readonly publicationApproved: false;
}
export interface HermesActivationDependencies {
  db: DB; ledger: SpendLedger;
  /** RAW host transport: model-transport applies this same ledger's guardedFetch exactly once. */
  route: ProductionRuntimeOptions['route'];
  /** Trusted test seam only; production omits this and uses the pinned Docker launcher. */
  launch?: GaryRuntimeLauncher;
  executorJobJournal: ExecutorJobJournal;
}
export interface HermesActivationBinding {
  readonly codeBase: Readonly<PinnedGitBase>;
  readonly allowedIssueIds: ReadonlySet<string>;
  readonly allowedActionTypes: NonNullable<LoopDeps['allowedActionTypes']>;
  readonly createAdmittedCodeLoop: NonNullable<LoopDeps['createAdmittedCodeLoop']>;
  readonly codingTrial: CodingTrial;
  readonly createCodeVerification: (action: CodeActionAdmission) => ActionVerification;
  readonly verificationPolicy: typeof HERMES_CODING_RUNTIME_POLICY.verification;
  getHealthEvidence(): readonly RuntimeHealthEvidence[];
}

/** Pure composition except validating the pre-existing trace directory. No model/container starts here. */
export function createHermesActivation(input: HermesActivationConfig, deps: HermesActivationDependencies): HermesActivationBinding {
  const config = validate(input);
  if (deps.route.provider !== config.provider || deps.route.model !== config.model || typeof deps.route.fetch !== 'function'
      || typeof deps.route.providerApiKey !== 'string' || !deps.route.providerApiKey) reject('host_route_mismatch');
  if (!deps.executorJobJournal) reject('executor_journal_required');
  const codingTrial = createCodingTrial({db:deps.db,ledger:deps.ledger,issueId:config.issueId,repo:config.repo,policyFingerprint:fingerprintHermesCodingActivation(config)});
  const verifications = new WeakMap<CodeActionAdmission, ActionVerification>();
  const createCodeVerification = (action: CodeActionAdmission): ActionVerification => {
    action.assertActive();
    codingTrial.assertCodingAction(action);
    if (action.ticketId !== config.issueId || action.repo !== config.repo || action.ledger !== deps.ledger) reject('verification_binding');
    let value = verifications.get(action);
    if (!value) {
      value = createActionVerification({policy:HERMES_CODING_RUNTIME_POLICY.verification,
        assertActive:()=>{action.assertActive();codingTrial.assertCodingAction(action);},
        ...(deps.executorJobJournal ? {testJobContext:{taskId:`gary-action-${action.actionId}`,actionId:action.actionId,
          ownerEpoch:action.ownerEpoch,journal:deps.executorJobJournal}} : {})});
      verifications.set(action,value);
    }
    return value;
  };
  const health: RuntimeHealthEvidence[] = [];
  const records: Array<{ binding: AuditTraceBinding; path: string; status?: AuditTerminalStatus; closed: boolean }> = [];
  const create = createHermesCodeLoopFactory({ route: deps.route, thinking: HERMES_CODING_RUNTIME_POLICY.thinking,
    verificationForAction:createCodeVerification,
    ...(deps.executorJobJournal ? {executorJobJournal:deps.executorJobJournal} : {}),
    launch: deps.launch ?? createDockerRuntimeLauncher({ imageDigest: config.workerImage, dockerExecutable: config.dockerExecutable, dockerHost: config.dockerHost }),
    readonlyChildren: { imageDigest: config.childImage, dockerExecutable: config.dockerExecutable, dockerHost: config.dockerHost },
    taskPolicy: async (action, args): Promise<ProductionTaskPolicy> => {
      if (action.ticketId !== config.issueId || action.repo !== config.repo || !config.policy.readTicketIdentifiers.includes(action.issue.identifier)) reject('task_binding');
      const location = relative(args.executor.workspaceRoot, config.traceDirectory);
      if (location === '' || (location !== '..' && !location.startsWith('../') && !isAbsolute(location))) reject('trace_inside_workspace');
      action.assertActive();
      const baseline = await args.executor.run('git rev-parse --verify HEAD && git status --porcelain=v1 --untracked-files=all', {
        timeoutMs: Math.min(10_000, args.timeoutMs), ...(args.deadlineMs === undefined ? {} : { deadlineMs: args.deadlineMs }),
        ...(args.signal ? { signal: args.signal } : {}),
      });
      action.assertActive();
      if (baseline.timedOut || baseline.exitCode !== 0 || baseline.stdout !== config.policy.baseCommit + '\n') reject('baseline_mismatch_or_dirty_workspace');
      return structuredClone(config.policy);
    },
    createTrace: binding => {
      privateDirectory(config.traceDirectory);
      if (!/^[a-f0-9-]{36}$/.test(binding.requestId) || binding.ticketId !== config.issueId) reject('trace_binding');
      const path = join(config.traceDirectory, binding.requestId + '.jsonl');
      const trace = createAuditTrace({ path, binding });
      const record: typeof records[number] = { binding: { ...binding }, path, closed: false }; records.push(record);
      return { get failed() { return trace.failed; }, binding: trace.binding,
        append(event) { trace.append(event); if (event.kind === 'terminal') record.status = event.status; },
        close() { trace.close(); if (!trace.failed) record.closed = true; },
      };
    },
  });
  const createAdmittedCodeLoop: NonNullable<LoopDeps['createAdmittedCodeLoop']> = action => {
    action.assertActive();
    if (action.ticketId !== config.issueId || action.issue.id !== config.issueId || action.repo !== config.repo || action.ledger !== deps.ledger
        || action.provider !== config.provider || action.model !== config.model || !config.policy.readTicketIdentifiers.includes(action.issue.identifier)) reject('action_binding');
    if (!/^[1-9]\d*$/.test(action.actionId)) reject('action_identity');
    const current = deps.db.query<{id:number;ticket_linear_id:string;action_type:string;completed_at:string|null;state_fingerprint:string;provider:string;model:string;owner_epoch:string},[string]>(
      'SELECT a.*,o.owner_epoch FROM actions a JOIN hermes_action_owners o ON o.action_id=a.id WHERE a.id=?').get(action.actionId);
    if (!current || current.ticket_linear_id !== config.issueId || current.action_type !== 'start_coding' || current.completed_at !== null
        || current.state_fingerprint !== action.fingerprint || current.provider !== config.provider || current.model !== config.model || current.owner_epoch !== action.ownerEpoch) reject('canonical_action_mismatch');
    const prior = deps.db.query<{n:number},[string,string]>("SELECT count(*) AS n FROM actions WHERE ticket_linear_id=? AND action_type='start_coding' AND id<>?").get(config.issueId, action.actionId)!;
    if (prior.n !== 0) { deps.ledger.markTerminal(config.issueId, 'canary_already_attempted'); return reject('canary_already_attempted'); }
    const allocation = deps.ledger.status(config.issueId);
    if (!allocation || allocation.state !== 'active' || !allocation.draftPr) reject('active_draft_allocation_required');
    codingTrial.assertCodingAction(action);
    const run = create(action);
    return async args => {
      health.splice(0); // A subsequent repair must establish new completion evidence.
      const first = records.length;
      const result = await run(args);
      // Factory creates the parent trace before any child. A child's prose/terminal cannot prove parent success.
      const main = records[first];
      if (result.status === 'finished' && main?.closed && main.status === 'finished' && main.binding.actionId === action.actionId) {
        health.push(freeze({ runtime: 'hermes', actionId: action.actionId, taskId: main.binding.taskId, requestId: main.binding.requestId,
          ownerEpoch: action.ownerEpoch, ticketId: config.issueId, tracePath: main.path, terminalStatus: 'finished', traceClosed: true,
          completedAt: new Date().toISOString(), publicationApproved: false }));
      }
      return result;
    };
  };
  return Object.freeze({ codeBase: Object.freeze({ branch: config.policy.baseBranch ?? 'main', commit: config.policy.baseCommit }),
    allowedIssueIds: new Set([config.issueId]), allowedActionTypes: new Set(['classify','start_coding'] as const),
    codingTrial, createAdmittedCodeLoop, createCodeVerification, verificationPolicy:HERMES_CODING_RUNTIME_POLICY.verification, getHealthEvidence: () => Object.freeze([...health]) });
}
