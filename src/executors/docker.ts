import { spawn } from "node:child_process";
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
}

interface InvocationOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
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

  constructor(workspaceRoot: string, opts: DockerExecutorOptions) {
    if (!isAbsolute(workspaceRoot)) {
      throw new Error(`DockerExecutor workspaceRoot must be absolute, got ${workspaceRoot}`);
    }
    if (!opts.image.trim()) throw new Error("DockerExecutor image must not be empty");
    this.workspaceRoot = resolve(workspaceRoot);
    this.image = opts.image;
    this.readOnly = opts.readOnly ?? false;
    this.networkMode = opts.networkMode ?? "none";
    this.cpus = opts.cpus ?? "4";
    this.memory = opts.memory ?? "12g";
    this.pidsLimit = opts.pidsLimit ?? 512;
    this.dockerBinary = opts.dockerBinary ?? "docker";
    this.uid = process.getuid?.() ?? 1000;
    this.gid = process.getgid?.() ?? 1000;
    this.gitCommonDir = discoverGitCommonDir(this.workspaceRoot);
    this.bunCacheVolume = opts.bunCacheVolume?.trim() || null;
    assertMountSafe(this.workspaceRoot);
    if (this.gitCommonDir) assertMountSafe(this.gitCommonDir);
    if (this.bunCacheVolume && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(this.bunCacheVolume)) {
      throw new Error(`invalid Docker volume name: ${this.bunCacheVolume}`);
    }
  }

  async readFile(path: string): Promise<string> {
    const result = await this.invoke(["cat", "--", this.containerPath(path)]);
    if (result.exitCode !== 0) throw invocationError("readFile", result);
    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.readOnly) throw new Error("DockerExecutor is read-only");
    const result = await this.invoke(
      [
        "bash",
        "-c",
        'set -euo pipefail; mkdir -p -- "$(dirname -- "$1")"; cat > "$1"',
        "gary-write",
        this.containerPath(path),
      ],
      { stdin: content },
    );
    if (result.exitCode !== 0) throw invocationError("writeFile", result);
  }

  async listFiles(pattern: string): Promise<string[]> {
    const result = await this.invoke([
      "rg",
      "--files",
      "--glob",
      pattern,
      "--glob",
      "!.git/**",
    ]);
    if (result.exitCode === 1 && result.stdout.length === 0) return [];
    if (result.exitCode !== 0) throw invocationError("listFiles", result);
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  }

  async grep(pattern: string, pathGlob = "**/*"): Promise<GrepMatch[]> {
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
    ]);
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
      cwd,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
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
    for (const [key, value] of Object.entries(opts.env ?? {}).sort()) {
      if (!SAFE_ENV_NAME.test(key)) throw new Error(`invalid environment variable name: ${key}`);
      args.push("--env", `${key}=${value}`);
    }
    args.push("--workdir", opts.cwd ?? "/workspace", this.image, ...command);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(this.dockerBinary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      const cleanup = spawn(this.dockerBinary, ["rm", "-f", name], { stdio: "ignore" });
      cleanup.unref();
    }, timeoutMs);

    return await new Promise<ExecResult>((resolveResult) => {
      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ stdout, stderr, exitCode: timedOut ? 124 : exitCode, timedOut });
      };
      child.on("close", (code, signal) => finish(code ?? (signal ? 128 : -1)));
      child.on("error", (err) => {
        stderr += `${stderr ? "\n" : ""}${err.message}`;
        finish(-1);
      });
    });
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
