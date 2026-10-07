import { spawn } from "node:child_process";
import { createDeadline, type DeadlineOptions } from "../deadline.ts";
import type { ExecResult } from "./index.ts";

/** Kill the whole process group and await close so descendants cannot keep mutating. */
export async function runProcess(
  executable: string,
  args: string[],
  opts: DeadlineOptions & {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
  },
): Promise<ExecResult> {
  const budget = createDeadline(opts);
  try {
    budget.throwIfExpired();
    const child = spawn(executable, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      if (child.pid !== undefined && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    budget.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    // A cancelled command can close stdin before queued input is written.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") stderr += `${stderr ? "\n" : ""}${err.message}`;
    });
    const result = await new Promise<ExecResult>((resolveResult) => {
      child.on("error", (err) => { stderr += `${stderr ? "\n" : ""}${err.message}`; });
      child.on("close", (code, signal) => {
        budget.signal.removeEventListener("abort", stop);
        resolveResult({
          stdout, stderr,
          exitCode: cancelled ? 124 : (code ?? (signal ? 128 : -1)),
          timedOut: cancelled,
        });
      });
      child.stdin.end(opts.stdin);
      if (budget.signal.aborted) stop();
    });
    return result;
  } finally {
    budget.dispose();
  }
}
