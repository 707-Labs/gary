import { throwIfExpired, type DeadlineOptions } from "../deadline.ts";
import { runProcess } from "./process.ts";
import { runJournaledDockerInvocation, type ExecutorTestJob } from "./job-journal.ts";
import { log } from "../logger.ts";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Executor, ExecResult, GrepMatch, RunOpts } from "./index.ts";
import { WorkspaceBoundaryError } from "./local.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DockerExecutorOptions {
  image: string;
  readOnly?: boolean;
  networkMode?: "none" | "bridge";
  cpus?: string;
  memory?: string;
  pidsLimit?: number;
  dockerBinary?: string;
  bunCacheVolume?: string;
  /** Host-selected defaults applied to every invocation, including file operations. */
  fixedEnvironment?: Readonly<Record<string, string>>;
  /** Coding-only, disposable 512 MiB tmpfs at the fixed Storybook output path. */
  storybookScratch?: true;
}

interface InvocationOptions extends DeadlineOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  testJob?: ExecutorTestJob;
}

/**
 * Runs every model-controlled command in a fresh, credential-free container.
 * The worktree is the only writable host mount. Git's worktree metadata is
 * mounted separately because `.git` points into Gary's bare repository.
 */
export class DockerExecutor implements Executor {
  readonly workspaceRoot: string;
  private readonly image: string;
  private readonly readOnly: boolean;
  private readonly networkMode: "none" | "bridge";
  private readonly cpus: string;
  private readonly memory: string;
  private readonly pidsLimit: number;
  private readonly dockerBinary: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly gitCommonDir: string | null;
  private readonly bunCacheVolume: string | null;
  private readonly fixedEnvironment: Readonly<Record<string, string>>;
  private readonly storybookScratch: boolean;

  constructor(workspaceRoot: string, opts: DockerExecutorOptions) {
    if (!isAbsolute(workspaceRoot)) {
      throw new Error(`DockerExecutor workspaceRoot must be absolute, got ${workspaceRoot}`);
    }
    if (!opts.image.trim()) throw new Error("DockerExecutor image must not be empty");
    this.workspaceRoot = resolve(workspaceRoot);
    this.image = opts.image;
    this.readOnly = opts.readOnly ?? false;
    this.networkMode = opts.networkMode ?? "none";
    if (opts.storybookScratch !== undefined && (opts.storybookScratch !== true
        || this.readOnly || this.networkMode !== "none")) {
      throw new Error("invalid_storybook_scratch");
    }
    this.storybookScratch = opts.storybookScratch === true;
    this.cpus = opts.cpus ?? "4";
    this.memory = opts.memory ?? "12g";
    this.pidsLimit = opts.pidsLimit ?? 512;
    this.dockerBinary = opts.dockerBinary ?? "docker";
    this.uid = process.getuid?.() ?? 1000;
    this.gid = process.getgid?.() ?? 1000;
    this.gitCommonDir = discoverGitCommonDir(this.workspaceRoot);
    this.bunCacheVolume = opts.bunCacheVolume?.trim() || null;
    const fixed = opts.fixedEnvironment ?? {};
    const entries = Object.getOwnPropertyDescriptors(fixed);
    const reserved = new Set(["CI", "LANG", "HOME", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "BUN_INSTALL_CACHE_DIR"]);
    if (Object.keys(entries).length > 32 || Object.entries(entries).some(([key, descriptor]) =>
      !SAFE_ENV_NAME.test(key) || reserved.has(key) || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string" || descriptor.value.includes("\0") || descriptor.value.length > 4096)) {
      throw new Error("invalid_fixed_executor_environment");
    }
    this.fixedEnvironment = Object.freeze(Object.fromEntries(Object.entries(entries).map(([key, descriptor]) => [key, descriptor.value as string])));
    assertMountSafe(this.workspaceRoot);
    if (this.gitCommonDir) assertMountSafe(this.gitCommonDir);
    if (this.bunCacheVolume && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(this.bunCacheVolume)) {
      throw new Error(`invalid Docker volume name: ${this.bunCacheVolume}`);
    }
  }

  async readFile(path: string, opts: DeadlineOptions = {}): Promise<string> {
    const result = await this.invoke(["cat", "--", this.containerPath(path)], opts);
    if (result.exitCode !== 0) throw invocationError("readFile", result);
    return result.stdout;
  }

  async writeFile(path: string, content: string, opts: DeadlineOptions = {}): Promise<void> {
    if (this.readOnly) throw new Error("DockerExecutor is read-only");
    const result = await this.invoke(
      [
        "bash",
        "-c",
        'set -euo pipefail; mkdir -p -- "$(dirname -- "$1")"; cat > "$1"',
        "gary-write",
        this.containerPath(path),
      ],
      { ...opts, stdin: content },
    );
    if (result.exitCode !== 0) throw invocationError("writeFile", result);
  }

  async listFiles(pattern: string, opts: DeadlineOptions = {}): Promise<string[]> {
    const result = await this.invoke([
      "rg",
      "--files",
      "--glob",
      pattern,
      "--glob",
      "!.git/**",
    ], opts);
    if (result.exitCode === 1 && result.stdout.length === 0) return [];
    if (result.exitCode !== 0) throw invocationError("listFiles", result);
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  }

  async grep(pattern: string, pathGlob = "**/*", opts: DeadlineOptions = {}): Promise<GrepMatch[]> {
    const result = await this.invoke([
      "rg",
      "--line-number",
      "--no-heading",
      "--color=never",
      "--glob",
      pathGlob,
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--regexp",
      pattern,
      ".",
    ], opts);
    if (result.exitCode === 1 && result.stdout.length === 0) return [];
    if (result.exitCode !== 0) throw invocationError("grep", result);
    const matches: GrepMatch[] = [];
    for (const raw of result.stdout.split("\n")) {
      const match = raw.match(/^(?:\.\/)?(.*?):(\d+):(.*)$/);
      if (!match?.[1] || !match[2]) continue;
      matches.push({ path: match[1], line: Number(match[2]), text: match[3] ?? "" });
    }
    return matches;
  }

  async run(command: string, opts: RunOpts = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? this.containerPath(opts.cwd) : "/workspace";
    const invocation = this.bunCacheVolume
      ? [
          "bash",
          "-c",
          "set -e; mkdir -p /tmp/bun-cache; find /bun-cache -mindepth 1 -maxdepth 1 -exec ln -s '{}' /tmp/bun-cache/ ';'; exec bash -lc \"$1\"",
          "gary-shell",
          command,
        ]
      : ["bash", "-lc", command];
    return await this.invoke(invocation, {
      ...opts,
      cwd,
    });
  }

  private containerPath(path: string): string {
    const candidate = isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path);
    const rel = relative(this.workspaceRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new WorkspaceBoundaryError(path);
    if (rel.length === 0) return "/workspace";
    return `/workspace/${rel.split(sep).join("/")}`;
  }

  private async invoke(command: string[], opts: InvocationOptions = {}): Promise<ExecResult> {
    const name = `gary-exec-${process.pid}-${crypto.randomUUID().slice(0, 12)}`;
    const mountMode = this.readOnly ? ",readonly" : "";
    const args = [
      "run",
      "--name",
      name,
      "--rm",
      "--init",
      "--interactive",
      "--pull=never",
      "--network",
      this.networkMode,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit",
      String(this.pidsLimit),
      "--memory",
      this.memory,
      "--cpus",
      this.cpus,
      "--user",
      `${this.uid}:${this.gid}`,
      "--hostname",
      "gary-worker",
      "--env",
      "CI=1",
      "--env",
      "LANG=C.UTF-8",
      "--env",
      "HOME=/tmp",
      "--env",
      "GIT_CONFIG_COUNT=1",
      "--env",
      "GIT_CONFIG_KEY_0=safe.directory",
      "--env",
      "GIT_CONFIG_VALUE_0=/workspace",
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,nodev,size=1g,uid=${this.uid},gid=${this.gid}`,
      "--mount",
      `type=bind,src=${this.workspaceRoot},dst=/workspace${mountMode}`,
    ];
    if (this.storybookScratch) {
      args.push("--tmpfs", `/workspace/storybook-static:rw,noexec,nosuid,nodev,size=512m,uid=${this.uid},gid=${this.gid}`);
    }
    if (this.gitCommonDir) {
      args.push(
        "--mount",
        `type=bind,src=${this.gitCommonDir},dst=${this.gitCommonDir}${mountMode}`,
      );
    }
    if (this.bunCacheVolume) {
      args.push(
        "--mount",
        `type=volume,src=${this.bunCacheVolume},dst=/bun-cache,readonly`,
        "--env",
        "BUN_INSTALL_CACHE_DIR=/tmp/bun-cache",
      );
    }
    const environment = { ...this.fixedEnvironment };
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (!SAFE_ENV_NAME.test(key)) throw new Error(`invalid environment variable name: ${key}`);
      if (Object.hasOwn(this.fixedEnvironment, key) && value !== this.fixedEnvironment[key]) {
        throw new Error("fixed_executor_environment_conflict");
      }
      environment[key] = value;
    }
    for (const [key, value] of Object.entries(environment).sort()) args.push("--env", `${key}=${value}`);
    args.push("--workdir", opts.cwd ?? "/workspace", this.image, ...command);

    throwIfExpired(opts);
    if (opts.testJob !== undefined) {
      if (this.readOnly || this.networkMode !== "none") throw new Error("executor_job_requires_isolated_coding_executor");
      return runJournaledDockerInvocation({
        context: opts.testJob, workspaceRoot: this.workspaceRoot, image: this.image, args,
        mountedRoots: [this.workspaceRoot, ...(this.gitCommonDir ? [this.gitCommonDir] : [])],
        options: {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
          ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
      });
    }
    const result = await runProcess(this.dockerBinary, args, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      // opts.cwd/env belong to the container, not the Docker client process.
      cwd: this.workspaceRoot,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.timedOut) {
      // Killing the Docker client does not stop the container. Await removal
      // before returning; cleanup has a separate, strictly bounded grace period.
      const cleanup = await runProcess(this.dockerBinary, ["rm", "-f", name], {
        timeoutMs: 5_000,
      });
      if (cleanup.exitCode !== 0) {
        const detail = cleanup.stderr || cleanup.stdout || String(cleanup.exitCode);
        result.stderr += `\ncontainer cleanup failed for ${name}: ${detail}`;
        // A caller may replace this result with the shared deadline error.
        // Preserve cleanup evidence in operational logs as well.
        log.error("container cleanup failed", {
          container: name,
          exitCode: cleanup.exitCode,
          timedOut: cleanup.timedOut,
          detail,
        });
      }
    }
    return result;
  }
}

function discoverGitCommonDir(workspaceRoot: string): string | null {
  const dotGit = resolve(workspaceRoot, ".git");
  if (!existsSync(dotGit)) return null;
  let text: string;
  try {
    text = readFileSync(dotGit, "utf8").trim();
  } catch {
    return null;
  }
  if (!text.startsWith("gitdir: ")) throw new Error(`unsupported .git file in ${workspaceRoot}`);
  const gitDir = resolve(text.slice("gitdir: ".length));
  const marker = `${sep}worktrees${sep}`;
  const markerAt = gitDir.lastIndexOf(marker);
  if (markerAt < 0) throw new Error(`worktree gitdir lacks /worktrees/: ${gitDir}`);
  const common = gitDir.slice(0, markerAt);
  if (!common.endsWith(".git") || !existsSync(common)) {
    throw new Error(`invalid worktree common git directory: ${common}`);
  }
  return common;
}

function assertMountSafe(path: string): void {
  if (path.includes(",") || path.includes("\n") || path.includes("\r")) {
    throw new Error(`Docker mount path contains unsupported characters: ${path}`);
  }
}

function invocationError(operation: string, result: ExecResult): Error {
  return new Error(
    `${operation} failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${result.stderr || result.stdout}`,
  );
}
