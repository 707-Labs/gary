import { throwIfExpired, type DeadlineOptions } from "../deadline.ts";
import { runProcess } from "./process.ts";
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

  async readFile(path: string, opts: DeadlineOptions = {}): Promise<string> {
    throwIfExpired(opts);
    const abs = this.resolveInside(path);
    return await readFile(abs, { encoding: "utf8", ...(opts.signal ? { signal: opts.signal } : {}) });
  }

  async writeFile(path: string, content: string, opts: DeadlineOptions = {}): Promise<void> {
    throwIfExpired(opts);
    const abs = this.resolveInside(path);
    await mkdir(dirname(abs), { recursive: true });
    throwIfExpired(opts);
    await writeFile(abs, content, { encoding: "utf8", ...(opts.signal ? { signal: opts.signal } : {}) });
  }

  async listFiles(pattern: string, opts: DeadlineOptions = {}): Promise<string[]> {
    throwIfExpired(opts);
    const glob = new Bun.Glob(pattern);
    const out: string[] = [];
    for await (const match of glob.scan({
      cwd: this.workspaceRoot,
      onlyFiles: true,
      dot: false,
    })) {
      throwIfExpired(opts);
      out.push(match);
    }
    return out.sort();
  }

  async grep(pattern: string, pathGlob = "**/*", opts: DeadlineOptions = {}): Promise<GrepMatch[]> {
    throwIfExpired(opts);
    const re = new RegExp(pattern);
    const matches: GrepMatch[] = [];
    const files = await this.listFiles(pathGlob, opts);
    const skip = new Set([".git", "node_modules", ".gary", "dist"]);
    for (const rel of files) {
      throwIfExpired(opts);
      const top = rel.split(sep)[0];
      if (top !== undefined && skip.has(top)) continue;
      let content: string;
      try {
        content = await this.readFile(rel, opts);
      } catch {
        throwIfExpired(opts);
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
    return await runProcess("bash", ["-lc", command], {
      ...opts,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cwd: opts.cwd ? this.resolveInside(opts.cwd) : this.workspaceRoot,
      env: { ...process.env, ...(opts.env ?? {}) },
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
