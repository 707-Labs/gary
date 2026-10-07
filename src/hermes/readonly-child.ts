/** Read-only child command execution. This module grants no model/ledger authority. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createDeadline, throwIfExpired, type DeadlineOptions } from '../deadline.ts';
import type { ExecResult, Executor, GrepMatch, RunOpts } from '../executors/index.ts';
import { runProcess } from '../executors/process.ts';
import type { AdmittedSession } from './session-host.ts';

export type ReadonlyChildCommandRunner = (
  executable: string, args: string[], options: DeadlineOptions & {
    timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv;
  },
) => Promise<ExecResult>;

export interface ReadonlyChildOptions {
  workspaceRoot: string;
  /** Inspected immutable local ID. No pull, tag lookup or package installation occurs. */
  imageDigest: string;
  /** The parent admission, not a new allocation or a replacement deadline. */
  admission: Readonly<AdmittedSession>;
  parentDepth: 0;
  assertActive(admission: Readonly<AdmittedSession>): void;
  signal?: AbortSignal;
  dockerExecutable?: string;
  /** Explicit local socket only. Never a remote Docker context. */
  dockerHost?: string;
  /** Trusted host/test injection; must honor its signal and await process/I/O cleanup. */
  runCommand?: ReadonlyChildCommandRunner;
}

export interface ReadonlyChildHandle {
  readonly executor: Executor;
  readonly depth: 1;
  readonly admission: Readonly<AdmittedSession>;
  /** Abort in-flight commands and await every exact-container cleanup. Idempotent. */
  close(): Promise<void>;
}

const DOCKER_EXECUTABLES = new Set(['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker']);
const CHILD_ENV = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'CI=1', 'LANG=C.UTF-8'];
const CLEANUP_MS = 5_000;
const IMAGE_FORMAT = '{"Id":{{json .Id}},"Volumes":{{json (index .Config "Volumes")}}}';

/**
 * Fresh container per command, no inherited environment, no network and no
 * writable host mounts. Git's shared metadata/cache is deliberately not mounted.
 * /tmp is ephemeral scratch; tests that write the checkout must use a copy there.
 * A host crash can leave an inert/executing container until operator cleanup;
 * this helper does not install a persistent watchdog or change Docker settings.
 */
export async function createReadonlyChildExecutor(options: ReadonlyChildOptions): Promise<ReadonlyChildHandle> {
  if (options.parentDepth !== 0) throw new Error('nested child execution denied');
  if (!/^sha256:[a-f0-9]{64}$/.test(options.imageDigest)) throw new Error('immutable child image ID required');
  const docker = options.dockerExecutable ?? '/usr/local/bin/docker';
  if (!DOCKER_EXECUTABLES.has(docker)) throw new Error('unsupported Docker executable');
  const dockerHost = options.dockerHost ?? 'unix:///var/run/docker.sock';
  if (!/^unix:\/\/[\/][A-Za-z0-9_./ -]+$/.test(dockerHost)
      || dockerHost.slice(7).split('/').includes('..')) throw new Error('local Docker socket required');
  if (!isAbsolute(options.workspaceRoot)) throw new Error('absolute child workspace required');
  const workspaceRoot = realpathSync(options.workspaceRoot);
  if (workspaceRoot === '/' || /[,\r\n\x00]/.test(workspaceRoot)) throw new Error('invalid child workspace');
  const admission = Object.freeze({ ...options.admission });
  if (!Number.isFinite(admission.deadlineMs) || !admission.taskId || !admission.requestId
      || !admission.ticketId || !admission.actionId || !admission.fingerprint || !admission.ownerEpoch) {
    throw new Error('complete parent admission required');
  }
  const cancellation = new AbortController();
  const budget = createDeadline({ deadlineMs: admission.deadlineMs,
    signal: options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal });
  const env = Object.freeze({ PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    DOCKER_HOST: dockerHost, DOCKER_CONFIG: '/var/empty/gary-hermes-no-docker-config' });
  const runCommand = options.runCommand ?? runProcess;
  const pending = new Set<Promise<ExecResult>>();
  let closed = false;
  let cleanupFailure: Error | undefined;
  let closePromise: Promise<void> | undefined;

  function live(): void {
    if (closed) throw new Error('child executor closed');
    if (cleanupFailure) throw cleanupFailure;
    budget.throwIfExpired();
    options.assertActive(admission);
  }
  function location(path: string): string {
    if (typeof path !== 'string' || /[\x00\r\n]/.test(path)) throw new Error('child workspace path denied');
    const candidate = resolve(workspaceRoot, path);
    const childPath = relative(workspaceRoot, candidate);
    if (childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
      throw new Error('child workspace path denied');
    }
    return childPath ? `/workspace/${childPath.split(sep).join('/')}` : '/workspace';
  }
  function invocationOptions(opts: DeadlineOptions, timeoutMs: number) {
    live();
    throwIfExpired(opts);
    return { cwd: workspaceRoot, env: { ...env }, timeoutMs,
      deadlineMs: Math.min(admission.deadlineMs, opts.deadlineMs ?? Infinity),
      signal: opts.signal ? AbortSignal.any([budget.signal, opts.signal]) : budget.signal };
  }
  try {
    const inspected = await runCommand(docker, ['image', 'inspect', '--format', IMAGE_FORMAT, options.imageDigest],
      invocationOptions({}, 10_000));
    live();
    if (inspected.timedOut || inspected.exitCode !== 0) throw new Error('child image inspection failed');
    const metadata = JSON.parse(inspected.stdout) as { Id?: unknown; Volumes?: unknown };
    if (metadata?.Id !== options.imageDigest || (metadata.Volumes !== null && metadata.Volumes !== undefined
        && (typeof metadata.Volumes !== 'object' || Array.isArray(metadata.Volumes) || Object.keys(metadata.Volumes).length !== 0))) {
      throw new Error('child image identity/anonymous volume policy failed');
    }
  } catch (error) {
    cancellation.abort();
    budget.dispose();
    throw error;
  }

  async function invokeInner(command: string[], opts: RunOpts = {}): Promise<ExecResult> {
    live();
    if (opts.env && Object.keys(opts.env).length) throw new Error('child environment override denied');
    if (opts.timeoutMs !== undefined && (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1)) {
      throw new Error('invalid child command timeout');
    }
    const cwd = opts.cwd === undefined ? '/workspace' : location(opts.cwd);
    const commandOptions = invocationOptions(opts, Math.min(opts.timeoutMs ?? 120_000, 120_000));
    const name = `gary-hermes-child-${randomUUID()}`;
    const args = ['container', 'run', '--name', name, '--init', '--pull', 'never', '--restart', 'no',
      '--network', 'none', '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges=true', '--pids-limit', '128', '--memory', '2g',
      '--memory-swap', '2g', '--cpus', '2', '--ulimit', 'nofile=256:256', '--stop-timeout', '5',
      '--no-healthcheck', '--log-driver', 'none',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',
      '--mount', `type=bind,src=${workspaceRoot},dst=/workspace,readonly,bind-recursive=disabled`,
      '--workdir', cwd, '--entrypoint', '/usr/bin/env', options.imageDigest, '-i', ...CHILD_ENV, ...command];
    let result: ExecResult;
    try {
      result = await runCommand(docker, args, commandOptions);
    } finally {
      // Deliberately independent from the expired/revoked task deadline.
      // Omitting --rm makes cleanup success unambiguous for a started container.
      try {
        const cleanup = await runCommand(docker, ['container', 'rm', '--force', name],
          { cwd: workspaceRoot, env: { ...env }, timeoutMs: CLEANUP_MS });
        const alreadyAbsent = cleanup.exitCode === 1 && !cleanup.timedOut && cleanup.stdout.trim() === ''
          && cleanup.stderr.trim() === `Error response from daemon: No such container: ${name}`;
        if (cleanup.timedOut || (cleanup.exitCode !== 0 && !alreadyAbsent)) throw new Error('child container cleanup failed');
      } catch {
        cleanupFailure = new Error(`child container cleanup failed: ${name}`);
        cancellation.abort();
        throw cleanupFailure;
      }
    }
    live();
    throwIfExpired(opts);
    return result;
  }
  function invoke(command: string[], opts: RunOpts = {}): Promise<ExecResult> {
    const operation = invokeInner(command, opts);
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }
  function successful(operation: string, result: ExecResult): string {
    if (result.timedOut || result.exitCode !== 0) throw new Error(`${operation} failed (exit ${result.exitCode})`);
    return result.stdout;
  }
  const executor: Executor = Object.freeze({
    workspaceRoot,
    readFile: async (path: string, opts: DeadlineOptions = {}) => successful('readFile', await invoke(['cat', '--', location(path)], opts)),
    writeFile: async (_path: string, _content: string, _opts: DeadlineOptions = {}) => { throw new Error('child executor is read-only'); },
    listFiles: async (pattern: string, opts: DeadlineOptions = {}) => {
      const result = await invoke(['rg', '--files', '--glob', pattern, '--glob', '!.git/**'], opts);
      if (result.exitCode === 1 && !result.timedOut && !result.stdout) return [];
      return successful('listFiles', result).split('\n').filter(Boolean).sort();
    },
    grep: async (pattern: string, pathGlob = '**/*', opts: DeadlineOptions = {}): Promise<GrepMatch[]> => {
      const result = await invoke(['rg', '--line-number', '--no-heading', '--color=never', '--glob', pathGlob,
        '--glob', '!.git/**', '--glob', '!node_modules/**', '--regexp', pattern, '.'], opts);
      if (result.exitCode === 1 && !result.timedOut && !result.stdout) return [];
      return successful('grep', result).split('\n').flatMap(line => {
        const match = line.match(/^(?:\.\/)?(.*?):(\d+):(.*)$/);
        return match?.[1] && match[2] ? [{ path: match[1], line: Number(match[2]), text: match[3] ?? '' }] : [];
      });
    },
    run: (command: string, opts: RunOpts = {}) => invoke(['bash', '--noprofile', '--norc', '-c', command], opts),
  });
  return Object.freeze({ executor, depth: 1 as const, admission,
    close() {
      return closePromise ??= (async () => {
        closed = true;
        cancellation.abort();
        await Promise.allSettled([...pending]);
        budget.dispose();
        if (cleanupFailure) throw cleanupFailure;
      })();
    },
  });
}
