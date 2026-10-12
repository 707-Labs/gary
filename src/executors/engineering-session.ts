/** Dormant, host-owned engineering sessions. Importing this module performs no I/O.
 * Every command shares one container's resource limit. No production wiring or
 * admission/spend authority is supplied by this module. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { EngineeringSessionGuardian, EngineeringSessionGuardianFactory } from './engineering-session-guardian.ts';

export interface EngineeringSessionBinding {
  readonly taskId: string;
  readonly sessionId: string;
  readonly ownerEpoch: string;
  readonly admissionId: string;
}
export interface EngineeringSessionResourceProfile {
  readonly cpus: number;
  readonly memoryMiB: number;
}
export type EngineeringSessionOperation =
  | { operation: 'execute'; arguments: { binding: EngineeringSessionBinding; operationId: string; command: string; timeoutMs: number; stdin?: string } }
  | { operation: 'poll'; arguments: { binding: EngineeringSessionBinding; operationId: string; processId: string; maxOutputBytes?: number } }
  | { operation: 'cancel'; arguments: { binding: EngineeringSessionBinding; operationId: string; processId: string } }
  | { operation: 'close'; arguments: { binding: EngineeringSessionBinding; operationId: string } };
export interface EngineeringSessionResult {
  readonly receiptId: string;
  readonly status: 'running' | 'exited' | 'cancelled' | 'closed';
  readonly processId?: string;
  readonly output?: string;
  readonly outputTruncated?: boolean;
  readonly exitCode?: number | null;
  readonly cleanupConfirmed?: boolean;
}
export interface EngineeringInvocation {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly stdin?: string;
}
export interface EngineeringCommandResult {
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
}
export interface EngineeringRunningCommand {
  poll(): Promise<{ running: boolean; exitCode: number | null; timedOut: boolean }>;
  /** An exited OS process can still have unread, bounded output. */
  read(maxOutputBytes: number): Promise<{ output: string; outputTruncated: boolean; outputPending?: boolean }>;
  /** Stops and drains the host CLI only; container removal proves task cleanup. */
  stop(): Promise<void>;
}
export interface EngineeringCommandRunner {
  /** Only fixtures may opt out of the independent parent-loss guardian. */
  readonly synthetic?: true;
  run(invocation: EngineeringInvocation): Promise<EngineeringCommandResult>;
  start(invocation: EngineeringInvocation): Promise<EngineeringRunningCommand>;
}
export interface EngineeringReceipt {
  readonly receiptId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly ownerEpoch: string;
  readonly admissionId: string;
  readonly at: number;
  readonly event: string;
  readonly operationId?: string;
  readonly processId?: string;
  readonly commandHash?: string;
  readonly exitCode?: number | null;
}
export interface EngineeringTaskJournal {
  taskId: string;
  /** Irreversible here; operator reconciliation belongs outside this API. */
  cleanupUncertain: boolean;
  activeSessionId: string | null;
  sessions: Record<string, EngineeringSessionRecord>;
  operations: Record<string, true>;
  receipts: EngineeringReceipt[];
}
export interface EngineeringSessionRecord {
  binding: EngineeringSessionBinding;
  phase: 'starting' | 'active' | 'closed' | 'uncertain';
  containerId: string | null;
  containerName: string;
  deadlineMs: number;
  workspaceRoot: string;
  image: string;
  resourceProfile: EngineeringSessionResourceProfile;
  dockerBinary: string;
  dockerHost: string;
  daemonId: string | null;
  guardian: null | { directory: string; databasePath: string; journalId: string; invocationId: string; pid: number };
}
export interface EngineeringSessionJournal {
  /** Must commit atomically and durably before returning; throw rolls back.
   * The task key (not owner/session) preserves cleanup fences across replacement.
   * A restarted host must reconcile an active session; it may never replay it. */
  transaction<T>(taskId: string, change: (state: EngineeringTaskJournal) => T): T;
}
export interface EngineeringSessionOptions {
  binding: EngineeringSessionBinding;
  workspaceRoot: string;
  image: string;
  /** Trusted, fixed action deadline; model requests may only shorten it. */
  deadlineMs: number;
  runner: EngineeringCommandRunner;
  journal: EngineeringSessionJournal;
  assertOwner(binding: EngineeringSessionBinding): void | Promise<void>;
  guardian?: EngineeringSessionGuardianFactory;
  dockerBinary?: string;
  /** Host-selected local daemon only; never exposed in a model operation. */
  dockerSocketPath?: string;
  /** Existing reviewed dependency cache, mounted read-only. */
  bunCacheVolume?: string;
  /** Host-created integrity-checked package bytes, never a model-selected path. */
  dependencyBundle?: { readonly root: string; assertCurrent(): void };
  /** Host-admitted aggregate cap for this entire container, never a model argument. */
  resourceProfile?: EngineeringSessionResourceProfile;
  now?: () => number;
  /** A test seam; production callers use the filesystem validator below. */
  validateWorkspace?: (root: string) => void;
  maxProcesses?: number;
  maxCommands?: number;
  maxOutputBytes?: number;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const CONTAINER = /^[a-f0-9]{64}$/;
const CONTROL_TIMEOUT = 5_000;
const OUTPUT_CAP = 64 * 1024;
const localFences = new WeakMap<EngineeringSessionJournal, Set<string>>();
function fail(code: string): never { throw new Error(code); }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function integer(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('engineering_invalid_limit');
}
function validBinding(binding: EngineeringSessionBinding): void {
  for (const value of [binding.taskId, binding.sessionId, binding.ownerEpoch, binding.admissionId]) {
    if (typeof value !== 'string' || !ID.test(value)) fail('engineering_invalid_binding');
  }
}
function sameBinding(a: EngineeringSessionBinding, b: EngineeringSessionBinding): boolean {
  return a.taskId === b.taskId && a.sessionId === b.sessionId && a.ownerEpoch === b.ownerEpoch && a.admissionId === b.admissionId;
}

/** Standalone clone only. No linked .git, common-dir, object alternates or symlink
 * metadata that would borrow another checkout's mutable Git identity. The host
 * still admits/reviews workspace contents; this is not secret scanning. */
export function validateEngineeringWorkspace(root: string): void {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) fail('engineering_invalid_workspace');
  const git = join(root, '.git');
  if (!lstatSync(git).isDirectory() || lstatSync(git).isSymbolicLink() || realpathSync(git) !== git) fail('engineering_independent_git_required');
  for (const path of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates', 'worktrees']) {
    if (existsSync(join(git, path))) fail('engineering_independent_git_required');
  }
  for (const path of ['objects', 'objects/info', 'refs', 'config', 'HEAD']) {
    const full = join(git, path);
    if (existsSync(full) && (lstatSync(full).isSymbolicLink() || realpathSync(full) !== full)) fail('engineering_independent_git_required');
  }
}

/** One persistent task container; limits cover the sum of every child command.
 * Cancel intentionally closes the entire session: process-group killing alone
 * cannot prove that a shell did not leave detached descendants in the cgroup. */
export class EngineeringSession {
  readonly binding: EngineeringSessionBinding;
  private readonly options: EngineeringSessionOptions;
  private readonly now: () => number;
  private readonly containerName: string;
  private readonly maxOutput: number;
  private readonly maxProcesses: number;
  private readonly maxCommands: number;
  private readonly resourceProfile: Readonly<EngineeringSessionResourceProfile>;
  private containerId: string | null = null;
  private guardian: EngineeringSessionGuardian | null = null;
  private daemonId: string | null = null;
  private opened = false;
  private closed = false;
  private commands = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly processes = new Map<string, { command: EngineeringRunningCommand; deadlineMs: number; terminal: 'cancelled' | null }>();

  constructor(options: EngineeringSessionOptions) {
    validBinding(options.binding);
    if (options.runner.synthetic !== true && !options.guardian) fail('engineering_guardian_required');
    if (!IMAGE.test(options.image)) fail('engineering_pinned_image_required');
    if (!isAbsolute(options.workspaceRoot) || /[,\r\n\0]/.test(options.workspaceRoot)) fail('engineering_invalid_workspace');
    if (options.dockerBinary !== undefined && (!isAbsolute(options.dockerBinary) || /[\r\n\0]/.test(options.dockerBinary))) fail('engineering_invalid_docker_binary');
    if (options.dockerSocketPath !== undefined && (!isAbsolute(options.dockerSocketPath) || resolve(options.dockerSocketPath) !== options.dockerSocketPath
      || /[\r\n\0]/.test(options.dockerSocketPath) || !options.dockerSocketPath.endsWith('.sock'))) fail('engineering_invalid_docker_socket');
    if (options.bunCacheVolume !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.bunCacheVolume)) fail('engineering_invalid_cache_volume');
    if (options.dependencyBundle) {
      const root = options.dependencyBundle.root;
      if (!isAbsolute(root) || resolve(root) !== root || /[,\r\n\0]/.test(root)
          || realpathSync(root) !== root || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()
          || lstatSync(root).uid !== process.getuid?.() || (lstatSync(root).mode & 0o022) !== 0
          || root === options.workspaceRoot || root.startsWith(options.workspaceRoot + '/') || options.workspaceRoot.startsWith(root + '/')) fail('engineering_invalid_dependency_bundle');
      options.dependencyBundle.assertCurrent();
    }
    integer(options.deadlineMs, 1, Number.MAX_SAFE_INTEGER);
    this.maxOutput = options.maxOutputBytes ?? OUTPUT_CAP;
    this.maxProcesses = options.maxProcesses ?? 4;
    this.maxCommands = options.maxCommands ?? 100;
    integer(this.maxOutput, 1, OUTPUT_CAP); integer(this.maxProcesses, 1, 4); integer(this.maxCommands, 1, 100);
    const resources = options.resourceProfile ?? { cpus: 4, memoryMiB: 12 * 1024 };
    if (!resources || Object.keys(resources).sort().join(',') !== 'cpus,memoryMiB') fail('engineering_invalid_resources');
    integer(resources.cpus, 1, 4); integer(resources.memoryMiB, 256, 12 * 1024);
    this.resourceProfile = Object.freeze({ ...resources });
    this.binding = Object.freeze({ ...options.binding });
    this.options = { ...options, binding: this.binding,
      ...(options.dependencyBundle ? { dependencyBundle: Object.freeze({ ...options.dependencyBundle }) } : {}) };
    this.now = options.now ?? Date.now;
    this.containerName = `gary-longjob-${randomUUID()}`;
  }

  operation(input: EngineeringSessionOperation): Promise<EngineeringSessionResult> {
    const snapshot = structuredClone(input);
    const next = this.tail.then(() => this.perform(snapshot));
    this.tail = next.catch(() => {});
    return next;
  }

  private armTimeout(timeoutMs: number, processId?: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const cleanup = this.tail.then(async () => {
        if (this.closed) return;
        try {
          if (processId) {
            const status = await this.processes.get(processId)?.command.poll();
            if (status && !status.running && !status.timedOut) return;
          }
        }
        catch { await this.cleanup(); return; }
        try { this.receipt('session_deadline_reached'); } catch { this.markUncertain(); }
        await this.cleanup();
      });
      this.tail = cleanup.catch(() => {}); // sticky task fence retains cleanup failure
    }, timeoutMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private receipt(event: string, detail: Omit<Partial<EngineeringReceipt>, keyof EngineeringSessionBinding | 'event' | 'at' | 'receiptId'> = {}): string {
    const receiptId = randomUUID();
    this.options.journal.transaction(this.binding.taskId, state => {
      state.receipts.push({ ...this.binding, ...detail, event, at: this.now(), receiptId });
    });
    return receiptId;
  }

  private async guard(cleanupOnly = false): Promise<void> {
    try {
      if (localFences.get(this.options.journal)?.has(this.binding.taskId)) fail('engineering_cleanup_uncertain');
      this.options.journal.transaction(this.binding.taskId, state => {
        if (state.cleanupUncertain) fail('engineering_cleanup_uncertain');
        if (!cleanupOnly && this.opened && !this.closed && state.activeSessionId !== this.binding.sessionId) fail('engineering_session_replaced');
        const recorded = state.sessions[this.binding.sessionId];
        if (recorded && !sameBinding(recorded.binding, this.binding)) fail('engineering_binding_mismatch');
      });
      // Revocation and expiry revoke execution, never the original host's
      // authority to remove its captured container and observe physical absence.
      if (!cleanupOnly) {
        await this.options.assertOwner(this.binding);
        if (this.guardian?.signal.aborted && !this.closed) fail('engineering_guardian_stopped');
        if (this.closed || this.now() >= this.options.deadlineMs) fail(this.closed ? 'engineering_session_closed' : 'engineering_deadline');
      }
      // An owner check can yield while another session reports late uncertainty.
      this.options.journal.transaction(this.binding.taskId, state => { if (state.cleanupUncertain) fail('engineering_cleanup_uncertain'); });
    } catch (error) {
      if ((this.containerId || this.guardian) && !this.closed) await this.cleanup();
      throw error;
    }
  }

  private markUncertain(): void {
    let fence = localFences.get(this.options.journal);
    if (!fence) { fence = new Set(); localFences.set(this.options.journal, fence); }
    fence.add(this.binding.taskId);
    try {
      this.options.journal.transaction(this.binding.taskId, state => {
        state.cleanupUncertain = true;
        const session = state.sessions[this.binding.sessionId];
        if (session) session.phase = 'uncertain';
      });
    } catch { /* Same-process task fence survives a failed durable write. */ }
  }

  private uncertain(): never {
    this.markUncertain();
    fail('engineering_cleanup_uncertain');
  }

  private invocation(args: string[], timeoutMs = CONTROL_TIMEOUT, stdin?: string): EngineeringInvocation {
    return { argv: [this.options.dockerBinary ?? '/usr/local/bin/docker', ...args],
      env: Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', DOCKER_HOST: `unix://${this.options.dockerSocketPath ?? '/var/run/docker.sock'}` }), timeoutMs,
      maxOutputBytes: this.maxOutput, ...(stdin !== undefined ? { stdin } : {}) };
  }

  private async control(args: string[]): Promise<EngineeringCommandResult> {
    return this.options.runner.run(this.invocation(args));
  }

  private async verifyDaemon(): Promise<void> {
    if (this.daemonId === null) return;
    const result = await this.control(['info', '--format', '{{.ID}}']);
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.output.trim() !== this.daemonId) fail('engineering_daemon_changed');
  }

  private async open(): Promise<void> {
    if (this.opened) return;
    await this.guard();
    (this.options.validateWorkspace ?? validateEngineeringWorkspace)(this.options.workspaceRoot);
    this.options.dependencyBundle?.assertCurrent();
    this.options.journal.transaction(this.binding.taskId, state => {
      if (state.cleanupUncertain) fail('engineering_cleanup_uncertain');
      if (state.activeSessionId !== null || state.sessions[this.binding.sessionId]) fail('engineering_reconciliation_required');
      state.activeSessionId = this.binding.sessionId;
      state.sessions[this.binding.sessionId] = { binding: this.binding, phase: 'starting', containerId: null,
        containerName: this.containerName, deadlineMs: this.options.deadlineMs, workspaceRoot: this.options.workspaceRoot,
        image: this.options.image, resourceProfile: this.resourceProfile, dockerBinary: this.options.dockerBinary ?? '/usr/local/bin/docker',
        dockerHost: `unix://${this.options.dockerSocketPath ?? '/var/run/docker.sock'}`, daemonId: null, guardian: null };
    });
    this.opened = true;
    this.receipt('session_create_intent');
    const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
    try {
      if (this.options.guardian) {
        this.guardian = await this.options.guardian.arm({ binding: this.binding, containerName: this.containerName,
          deadlineMs: this.options.deadlineMs, workspaceRoot: this.options.workspaceRoot, image: this.options.image,
          dockerBinary: this.options.dockerBinary ?? '/usr/local/bin/docker', dockerHost: `unix://${this.options.dockerSocketPath ?? '/var/run/docker.sock'}`,
          runner: this.options.runner });
        this.daemonId = this.guardian.daemonId;
        this.options.journal.transaction(this.binding.taskId, state => {
          state.sessions[this.binding.sessionId]!.daemonId = this.daemonId;
          state.sessions[this.binding.sessionId]!.guardian = this.guardian!.reference;
        });
        await this.guard();
      }
      const created = await this.control(['create', '--name', this.containerName, '--init', '--pull=never', '--network=none',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--cpus=${this.resourceProfile.cpus}`,
        `--memory=${this.resourceProfile.memoryMiB}m`, `--memory-swap=${this.resourceProfile.memoryMiB}m`, '--pids-limit=512', '--ulimit', 'core=0:0',
        '--user', `${uid}:${gid}`, '--label', `gary.task=${this.binding.taskId}`, '--label', `gary.session=${this.binding.sessionId}`,
        '--label', `gary.owner=${this.binding.ownerEpoch}`, '--label', `gary.admission=${this.binding.admissionId}`,
        ...(this.guardian ? ['--label', `dev.gary.executor-job=${this.guardian.reference.invocationId}`,
          '--label', `dev.gary.executor-journal=${this.guardian.reference.journalId}`] : []),
        '--env', 'HOME=/tmp', '--env', 'CI=1', '--env', 'LANG=C.UTF-8',
        '--tmpfs', `/tmp:rw,nosuid,nodev,size=1g,uid=${uid},gid=${gid}`,
        '--mount', `type=bind,src=${this.options.workspaceRoot},dst=/workspace`, '--workdir', '/workspace',
        ...(this.options.bunCacheVolume ? ['--mount', `type=volume,src=${this.options.bunCacheVolume},dst=/bun-cache,readonly`] : []),
        ...(this.options.dependencyBundle ? ['--mount', `type=bind,src=${this.options.dependencyBundle.root},dst=/task/dependency-bundle,readonly`] : []),
        '--entrypoint', '/usr/bin/env', this.options.image, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'CI=1', 'LANG=C.UTF-8',
        'sleep', 'infinity']);
      const id = created.output.trim();
      if (created.exitCode !== 0 || created.timedOut || created.outputTruncated || !CONTAINER.test(id)) return this.uncertain();
      this.containerId = id;
      this.options.journal.transaction(this.binding.taskId, state => { state.sessions[this.binding.sessionId]!.containerId = id; });
      this.receipt('session_created');
      await this.guardian?.bind(id);
      await this.guard();
      this.options.dependencyBundle?.assertCurrent();
      const started = await this.control(['start', id]);
      if (started.exitCode !== 0 || started.timedOut) fail('engineering_session_start_failed');
      await this.guard();
      if (this.options.bunCacheVolume) {
        const cache = await this.control(['exec', id, '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'bash', '--noprofile', '--norc', '-c',
          "set -e; mkdir /tmp/bun-cache; find /bun-cache -mindepth 1 -maxdepth 1 -exec ln -s '{}' /tmp/bun-cache/ ';'"]);
        if (cache.exitCode !== 0 || cache.timedOut) fail('engineering_cache_prepare_failed');
        await this.guard();
      }
      this.options.journal.transaction(this.binding.taskId, state => { state.sessions[this.binding.sessionId]!.phase = 'active'; });
      this.receipt('session_started');
      this.armTimeout(Math.max(1, this.options.deadlineMs - this.now()));
    } catch (error) {
      if (this.containerId || this.guardian) await this.cleanup();
      else return this.uncertain();
      throw error;
    }
  }

  private async perform(input: EngineeringSessionOperation): Promise<EngineeringSessionResult> {
    if (!input || !input.arguments || !sameBinding(this.binding, input.arguments.binding)) fail('engineering_binding_mismatch');
    const args = input.arguments;
    if (!ID.test(args.operationId)) fail('engineering_invalid_operation_id');
    // Snapshot authority and consume before any effect; never automatically replay.
    await this.guard(input.operation === 'close');
    // A repeated call is a normal rejection. A persistence failure, however,
    // tears down existing work instead of letting it run without receipts.
    const duplicate = new Error('engineering_operation_already_consumed');
    try {
      this.options.journal.transaction(this.binding.taskId, state => {
        const key = `${this.binding.sessionId}/${args.operationId}`;
        if (state.operations[key]) throw duplicate;
        state.operations[key] = true;
      });
    } catch (error) {
      if (error !== duplicate && (this.containerId || this.guardian) && !this.closed) await this.cleanup();
      throw error;
    }
    if (input.operation === 'execute') {
      const args = input.arguments;
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0') || Buffer.byteLength(args.command) > 32_768) fail('engineering_invalid_command');
      if (args.stdin !== undefined && (typeof args.stdin !== 'string' || Buffer.byteLength(args.stdin) > 256 * 1024)) fail('engineering_invalid_stdin');
      integer(args.timeoutMs, 1, 30 * 60_000);
      if (this.commands >= this.maxCommands) fail('engineering_command_limit');
      let active = 0;
      for (const process of this.processes.values()) if ((await process.command.poll()).running) active++;
      await this.guard();
      if (active >= this.maxProcesses) fail('engineering_process_limit');
      await this.open();
      const processId = randomUUID();
      const timeoutMs = Math.min(args.timeoutMs, this.options.deadlineMs - this.now());
      const commandDeadline = this.now() + timeoutMs;
      this.commands++;
      try {
        this.receipt('command_start_intent', { operationId: args.operationId, processId,
          commandHash: digest(JSON.stringify({ command: args.command, stdin: args.stdin ?? null, timeoutMs, deadlineMs: commandDeadline })) });
        await this.guard();
        await this.verifyDaemon();
        await this.guard();
        const command = await this.options.runner.start(this.invocation(['exec', '--interactive', '--workdir', '/workspace', this.containerId!,
          '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'CI=1', 'LANG=C.UTF-8',
          ...(this.options.bunCacheVolume ? ['BUN_INSTALL_CACHE_DIR=/tmp/bun-cache'] : []),
          // Node's automatic ~2 GiB heap aborts the baseline project check.
          // This reviewed setting fits the existing 4 GiB cgroup; smaller
          // and other profiles retain their native defaults.
          ...(this.resourceProfile.memoryMiB === 4096 ? ['NODE_OPTIONS=--max-old-space-size=3072'] : []),
          'bash', '--noprofile', '--norc', '-c', args.command], timeoutMs, args.stdin));
        this.processes.set(processId, { command, deadlineMs: commandDeadline, terminal: null });
        this.armTimeout(Math.max(1, commandDeadline - this.now()), processId);
        await this.guard();
        return { processId, status: 'running', receiptId: this.receipt('command_started', { operationId: args.operationId, processId }) };
      } catch (error) {
        await this.cleanup();
        throw error;
      }
    }
    if (input.operation === 'close') {
      await this.cleanup();
      await this.guard(true);
      return { status: 'closed', cleanupConfirmed: true, receiptId: this.receipt('session_close_observed', { operationId: args.operationId }) };
    }
    if (input.operation !== 'poll' && input.operation !== 'cancel') fail('engineering_unknown_operation');
    const processId = input.arguments.processId;
    const process = this.processes.get(processId);
    if (!process) fail('engineering_unknown_process');
    if (input.operation === 'cancel') {
      await this.cleanup();
      await this.guard(true);
      return { processId, status: 'cancelled', cleanupConfirmed: true, receiptId: this.receipt('command_cancelled', { operationId: args.operationId, processId }) };
    }
    const maxOutput = input.arguments.maxOutputBytes ?? this.maxOutput;
    integer(maxOutput, 1, this.maxOutput);
    const status = await process.command.poll();
    await this.guard();
    if (status.timedOut || (status.running && this.now() >= process.deadlineMs)) {
      await this.cleanup();
      return { processId, status: 'cancelled', cleanupConfirmed: true, receiptId: this.receipt('command_timeout', { operationId: args.operationId, processId }) };
    }
    const output = await process.command.read(maxOutput);
    await this.guard();
    if (Buffer.byteLength(output.output) > maxOutput) { await this.cleanup(); fail('engineering_runner_output_limit'); }
    // Native consumers stop polling on exited. Keep the stream open until the
    // runner has delivered every retained byte, even if the OS process is done.
    const running = status.running || output.outputPending === true;
    const exitCode = running ? null : status.exitCode;
    return { processId, status: running ? 'running' : 'exited', output: output.output,
      outputTruncated: output.outputTruncated, exitCode,
      receiptId: this.receipt('command_observed', { operationId: args.operationId, processId, exitCode }) };
  }

  /** Cleanup is deliberately independent of expired/replaced owner authority.
   * It removes only the immutable ID with exact host labels; failure fences task. */
  private async cleanup(): Promise<void> {
    if (this.closed) {
      // An idempotent observation is fresh physical evidence, not replay of a
      // past success. Never remove a new container discovered under an old name.
      try {
        await this.verifyDaemon();
        if (this.containerId) {
          const absent = await this.control(['ps', '--all', '--no-trunc', '--filter', `id=${this.containerId}`, '--format', '{{.ID}}']);
          if (absent.exitCode !== 0 || absent.timedOut || absent.outputTruncated || absent.output.trim() !== '') return this.uncertain();
        }
      } catch { return this.uncertain(); }
      return;
    }
    let journalFailed = false;
    try { this.receipt('session_cleanup_intent'); }
    catch { journalFailed = true; this.markUncertain(); }
    try {
      if (this.guardian) {
        try {
          // Complete always drains the independent remover before host fallback.
          const proof = await this.guardian.complete();
          if (proof.absenceVerified !== true || (this.containerId !== null && proof.containerId !== this.containerId)) fail('engineering_guardian_receipt_mismatch');
          this.containerId = proof.containerId;
        } catch { /* Exact-ID host cleanup below may independently prove absence. */ }
      }
      await this.verifyDaemon();
      if (this.containerId) {
        const before = await this.control(['ps', '--all', '--no-trunc', '--filter', `id=${this.containerId}`, '--format', '{{.ID}}']);
        if (before.exitCode !== 0 || before.timedOut || before.outputTruncated || !['', this.containerId].includes(before.output.trim())) return this.uncertain();
        if (before.output.trim() !== '') {
        const inspected = await this.control(['inspect', '--format', '{{json .}}', this.containerId]);
        if (inspected.exitCode !== 0 || inspected.timedOut || inspected.outputTruncated) return this.uncertain();
        const metadata = JSON.parse(inspected.output) as { Id?: string; Config?: { Labels?: Record<string, string> } };
        const labels = metadata.Config?.Labels;
        if (metadata.Id !== this.containerId || labels?.['gary.task'] !== this.binding.taskId || labels?.['gary.session'] !== this.binding.sessionId
          || labels?.['gary.owner'] !== this.binding.ownerEpoch || labels?.['gary.admission'] !== this.binding.admissionId) return this.uncertain();
        const removed = await this.control(['rm', '--force', this.containerId]);
        if (removed.exitCode !== 0 || removed.timedOut) return this.uncertain();
        }
        const absent = await this.control(['ps', '--all', '--no-trunc', '--filter', `id=${this.containerId}`, '--format', '{{.ID}}']);
        if (absent.exitCode !== 0 || absent.timedOut || absent.outputTruncated || absent.output.trim() !== '') return this.uncertain();
      } else if (this.opened) return this.uncertain();
      for (const process of this.processes.values()) { await process.command.stop(); process.terminal = 'cancelled'; }
      this.options.journal.transaction(this.binding.taskId, state => {
        const session = state.sessions[this.binding.sessionId];
        if (session) { session.phase = 'closed'; session.containerId = this.containerId; }
        if (state.activeSessionId === this.binding.sessionId) state.activeSessionId = null;
        state.receipts.push({ ...this.binding, event: 'session_cleanup_confirmed', at: this.now(), receiptId: randomUUID() });
      });
      this.closed = true;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
      if (journalFailed || localFences.get(this.options.journal)?.has(this.binding.taskId)) return this.uncertain();
    } catch { return this.uncertain(); }
  }
}

/** Fixture journal only. Production must inject a durable transaction store. */
export function createMemoryEngineeringSessionJournal(): EngineeringSessionJournal {
  const tasks = new Map<string, EngineeringTaskJournal>();
  return { transaction<T>(taskId: string, change: (state: EngineeringTaskJournal) => T): T {
    const state = structuredClone(tasks.get(taskId) ?? { taskId, cleanupUncertain: false, activeSessionId: null, sessions: {}, operations: {}, receipts: [] });
    const result = change(state); tasks.set(taskId, structuredClone(state)); return result;
  } };
}

/** Explicit opt-in host runner. It never inherits process.env and retains only a
 * bounded merged output buffer. Constructing it does not spawn a process. */
export function createBunEngineeringCommandRunner(): EngineeringCommandRunner {
  async function start(invocation: EngineeringInvocation, mergeStderr = true): Promise<EngineeringRunningCommand> {
    integer(invocation.timeoutMs, 1, 30 * 60_000);
    integer(invocation.maxOutputBytes, 1, OUTPUT_CAP);
    if (invocation.argv.length === 0) fail('engineering_empty_argv');
    const child = Bun.spawn([...invocation.argv], { env: { ...invocation.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    let buffer = Buffer.alloc(0), truncated = false, timedOut = false, exitCode: number | null = null;
    const capture = async (stream: ReadableStream<Uint8Array>, retain = true) => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          if (!retain) continue;
          const room = invocation.maxOutputBytes - buffer.length;
          if (result.value.length > room) truncated = true;
          if (room > 0) buffer = Buffer.concat([buffer, Buffer.from(result.value.subarray(0, room))]);
        }
      } finally { reader.releaseLock(); }
    };
    const drains = Promise.all([capture(child.stdout), capture(child.stderr, mergeStderr)]);
    const completion = child.exited.then(async code => { await drains; exitCode = code; });
    // Observe failures immediately; callers still receive them through poll/stop.
    void completion.catch(() => {});
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, invocation.timeoutMs);
    timeout.unref?.();
    void completion.finally(() => clearTimeout(timeout)).catch(() => {});
    child.stdin.write(invocation.stdin ?? ''); child.stdin.end();
    return {
      async poll() { return { running: exitCode === null, exitCode, timedOut }; },
      async read(maxOutputBytes) {
        integer(maxOutputBytes, 1, invocation.maxOutputBytes);
        // Choose a UTF-8 boundary; replacement bytes must not exceed caller cap.
        let length = Math.min(maxOutputBytes, buffer.length);
        while (length > 0 && Buffer.byteLength(buffer.subarray(0, length).toString('utf8')) > maxOutputBytes) length--;
        const output = buffer.subarray(0, length).toString('utf8');
        if (length === 0 && buffer.length > 0) { buffer = buffer.subarray(Math.min(maxOutputBytes, buffer.length)); truncated = true; }
        else buffer = buffer.subarray(length);
        const outputTruncated = truncated; truncated = false;
        return { output, outputTruncated, outputPending: buffer.length > 0 };
      },
      async stop() {
        clearTimeout(timeout);
        if (exitCode === null) child.kill('SIGKILL');
        let limit: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([completion, new Promise<never>((_, reject) => {
            limit = setTimeout(() => reject(new Error('engineering_cli_drain_uncertain')), CONTROL_TIMEOUT); limit.unref?.();
          })]);
        } finally { if (limit) clearTimeout(limit); }
      },
    };
  }
  return { start, async run(invocation) {
    // Docker control commands have machine-readable stdout. Drain stderr without
    // mixing diagnostics into container IDs, daemon IDs or inspect JSON.
    const command = await start(invocation, false);
    for (;;) {
      const state = await command.poll();
      if (!state.running || state.timedOut) {
        await command.stop();
        const output = await command.read(invocation.maxOutputBytes);
        return { ...output, exitCode: state.exitCode ?? 124, timedOut: state.timedOut };
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } };
}
