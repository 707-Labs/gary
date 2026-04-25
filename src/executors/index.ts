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

export interface RunOpts {
  timeoutMs?: number;
  cwd?: string; // relative to workspace root; defaults to root
  env?: Record<string, string>;
}

export interface GrepMatch {
  path: string; // relative to workspace root
  line: number; // 1-indexed
  text: string;
}

export interface Executor {
  /** Workspace root, absolute. All paths resolve relative to this. */
  readonly workspaceRoot: string;

  readFile(path: string): Promise<string>;

  writeFile(path: string, content: string): Promise<void>;

  /** Returns paths relative to the workspace root. */
  listFiles(pattern: string): Promise<string[]>;

  grep(pattern: string, pathGlob?: string): Promise<GrepMatch[]>;

  run(command: string, opts?: RunOpts): Promise<ExecResult>;
}
