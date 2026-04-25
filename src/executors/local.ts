import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  Executor,
  ExecResult,
  GrepMatch,
  RunOpts,
} from "./index.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export class WorkspaceBoundaryError extends Error {
  constructor(path: string) {
    super(`path resolves outside workspace root: ${path}`);
    this.name = "WorkspaceBoundaryError";
  }
}

export class LocalExecutor implements Executor {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    if (!isAbsolute(workspaceRoot)) {
      throw new Error(
        `LocalExecutor workspaceRoot must be absolute, got ${workspaceRoot}`,
      );
    }
    this.workspaceRoot = resolve(workspaceRoot);
  }

  async readFile(path: string): Promise<string> {
    const abs = this.resolveInside(path);
    return await readFile(abs, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.resolveInside(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async listFiles(pattern: string): Promise<string[]> {
    const glob = new Bun.Glob(pattern);
    const out: string[] = [];
    for await (const match of glob.scan({
      cwd: this.workspaceRoot,
      onlyFiles: true,
      dot: false,
    })) {
      out.push(match);
    }
    return out.sort();
  }

  async grep(pattern: string, pathGlob = "**/*"): Promise<GrepMatch[]> {
    const re = new RegExp(pattern);
    const matches: GrepMatch[] = [];
    const files = await this.listFiles(pathGlob);
    const skip = new Set([".git", "node_modules", ".gary", "dist"]);
    for (const rel of files) {
      const top = rel.split(sep)[0];
      if (top !== undefined && skip.has(top)) continue;
      let content: string;
      try {
        content = await readFile(resolve(this.workspaceRoot, rel), "utf8");
      } catch {
        continue; // binary, missing, permission — skip
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (re.test(line)) {
          matches.push({ path: rel, line: i + 1, text: line });
        }
      }
    }
    return matches;
  }

  async run(command: string, opts: RunOpts = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cwd = opts.cwd ? this.resolveInside(opts.cwd) : this.workspaceRoot;
    const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const child = spawn("bash", ["-lc", command], {
      cwd,
      env,
      signal: controller.signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    return await new Promise<ExecResult>((resolveResult) => {
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        resolveResult({
          stdout,
          stderr,
          exitCode: code ?? (signal !== null ? 128 : -1),
          timedOut,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        resolveResult({
          stdout,
          stderr: stderr + (stderr ? "\n" : "") + (err.message ?? String(err)),
          exitCode: -1,
          timedOut,
        });
      });
    });
  }

  private resolveInside(path: string): string {
    const candidate = isAbsolute(path)
      ? resolve(path)
      : resolve(this.workspaceRoot, path);
    const rel = relative(this.workspaceRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new WorkspaceBoundaryError(path);
    }
    return candidate;
  }
}
