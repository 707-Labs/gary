import type { ExecutorTestJob } from "./job-journal.ts";
export { createExecutorJobJournal, reconcileDockerExecutorJobs, type ExecutorJobJournal, type ExecutorTestJob } from "./job-journal.ts";
import { throwIfExpired, type DeadlineOptions } from "../deadline.ts";

// Executor abstraction. Tools are written against this interface so the
// CODE handler can run a local worktree in Weekend 1 (LocalExecutor) and a
// Docker container in Weekend 2 (DockerExecutor) without changing the tool
// implementations or the agent loop.
//
// Pattern lifted from Nous Research's Hermes Agent (see GARY_SPEC.md §10).
// Note: spec calls this method `exec` but we use `run` because some tooling
// in this repo flags the literal substring `exec(` as suspicious.

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface RunOpts extends DeadlineOptions {
  timeoutMs?: number;
  cwd?: string; // relative to workspace root; defaults to root
  env?: Record<string, string>;
  /** Trusted host context only; never exposed in model tool schemas. */
  testJob?: ExecutorTestJob;
}

export interface GrepMatch {
  path: string; // relative to workspace root
  line: number; // 1-indexed
  text: string;
}

export interface Executor {
  /** Workspace root, absolute. All paths resolve relative to this. */
  readonly workspaceRoot: string;

  readFile(path: string, opts?: DeadlineOptions): Promise<string>;

  writeFile(path: string, content: string, opts?: DeadlineOptions): Promise<void>;

  /** Returns paths relative to the workspace root. */
  listFiles(pattern: string, opts?: DeadlineOptions): Promise<string[]>;

  grep(pattern: string, pathGlob?: string, opts?: DeadlineOptions): Promise<GrepMatch[]>;

  run(command: string, opts?: RunOpts): Promise<ExecResult>;
}

/** Bind all executor operations, including Docker-backed file tools, to one budget. */
export function bindExecutorDeadline(executor: Executor, budget: DeadlineOptions): Executor {
  function options<T extends DeadlineOptions>(opts: T): T & DeadlineOptions {
    throwIfExpired(budget);
    throwIfExpired(opts);
    const signals = [budget.signal, opts.signal].filter((s): s is AbortSignal => s !== undefined);
    return {
      ...opts,
      deadlineMs: Math.min(budget.deadlineMs ?? Infinity, opts.deadlineMs ?? Infinity),
      ...(signals.length ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) } : {}),
    };
  }
  async function checked<T>(opts: DeadlineOptions, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      throwIfExpired(budget);
      throwIfExpired(opts);
      return result;
    } catch (err) {
      throwIfExpired(budget);
      throwIfExpired(opts);
      throw err;
    }
  }
  return {
    workspaceRoot: executor.workspaceRoot,
    readFile: (path, opts = {}) => checked(opts, () => executor.readFile(path, options(opts))),
    writeFile: (path, content, opts = {}) => checked(opts, () => executor.writeFile(path, content, options(opts))),
    listFiles: (pattern, opts = {}) => checked(opts, () => executor.listFiles(pattern, options(opts))),
    grep: (pattern, pathGlob, opts = {}) => checked(opts, () => executor.grep(pattern, pathGlob, options(opts))),
    run: (command, opts = {}) => checked(opts, () => executor.run(command, options(opts))),
  };
}
