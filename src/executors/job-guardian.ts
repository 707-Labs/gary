import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ExecutorJobGuardianBinding {
  dockerHost: string; dockerBinary: string; dockerConfig: string; directory: string;
  journalId: string; invocationId: string; containerName: string; deadlineMs: number;
  databasePath: string; expectedBinding: string; ownerToken: string; ownerPid: number;
}
export interface ExecutorJobGuardianReceipt {
  journalId: string; invocationId: string; containerId: string | null; absenceVerified: true;
}
export interface ExecutorJobGuardian {
  readonly pid: number;
  readonly signal: AbortSignal;
  bind(containerId: string): Promise<void>;
  /** Always drains the child before resolving or rejecting; fallback cleanup is then safe. */
  complete(): Promise<ExecutorJobGuardianReceipt>;
}
const HANDSHAKE_MS = 17_000;
const DRAIN_MS = 18_000;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  // Startup/exit can reject before the caller has reached bind/complete.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("executor_guardian_timeout")), ms);
  })]); } finally { clearTimeout(timer); }
}

/** The anonymous pipes are the sole control channel; no sockets or inherited secrets. */
export async function armExecutorJobGuardian(binding: ExecutorJobGuardianBinding): Promise<ExecutorJobGuardian> {
  if (process.platform === "win32" || binding.ownerPid !== process.pid) throw new Error("executor_guardian_owner_invalid");
  const child = spawn(process.execPath, ["--no-env-file", fileURLToPath(new URL("./job-guardian-process.ts", import.meta.url))], {
    detached: true, stdio: ["pipe", "pipe", "pipe"],
    cwd: binding.directory,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: binding.directory },
  });
  const armed = deferred<void>(), bound = deferred<void>(), closed = deferred<void>();
  const abort = new AbortController();
  let buffer = "", bytes = 0, stderrBytes = 0, hasArmed = false, hasBound = false;
  let bindSent = false, completing = false, exited = false, receipt: ExecutorJobGuardianReceipt | undefined;
  let failure: Error | undefined;
  const fail = (code: string) => {
    failure ??= new Error(code);
    abort.abort(failure); armed.reject(failure); bound.reject(failure);
    child.stdin.end();
  };
  child.stdin.on("error", () => fail("executor_guardian_channel_failed"));
  child.on("error", () => fail("executor_guardian_spawn_failed"));
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 8192) fail("executor_guardian_output_invalid");
  });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 32_768) { fail("executor_guardian_output_invalid"); return; }
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.journalId !== binding.journalId || value.invocationId !== binding.invocationId) throw new Error();
        if (value.type === "armed" && !hasArmed && !completing) { hasArmed = true; armed.resolve(); }
        else if (value.type === "bound" && hasArmed && bindSent && !hasBound && !completing) { hasBound = true; bound.resolve(); }
        else if (value.type === "stopping") abort.abort(new Error("executor_guardian_stopping"));
        else if (value.type === "complete" && value.absenceVerified === true && !receipt
            && typeof value.containerId === "string" && /^[a-f0-9]{64}$/.test(value.containerId)) {
          receipt = { journalId: value.journalId, invocationId: value.invocationId,
            containerId: value.containerId, absenceVerified: true };
        } else if (value.type === "error") fail("executor_guardian_cleanup_unverified");
        else throw new Error();
      } catch { fail("executor_guardian_protocol_invalid"); }
    }
  });
  child.on("close", (code) => {
    exited = true;
    if (code !== 0 || !receipt || buffer.length > 0) fail("executor_guardian_cleanup_unverified");
    else if (!completing) fail("executor_guardian_stopped");
    closed.resolve();
  });
  child.unref();
  const drain = async () => {
    try { await bounded(closed.promise, DRAIN_MS); }
    catch {
      fail("executor_guardian_drain_timeout");
      if (!exited && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
        }
      }
      await closed.promise;
    }
  };
  try {
    child.stdin.write(JSON.stringify({ type: "arm", binding }) + "\n");
    await bounded(armed.promise, HANDSHAKE_MS);
  } catch (error) {
    fail("executor_guardian_arm_failed"); await drain(); throw error;
  }
  let completion: Promise<ExecutorJobGuardianReceipt> | undefined;
  return Object.freeze({
    pid: child.pid!, signal: abort.signal,
    async bind(containerId: string): Promise<void> {
      if (bindSent || completing || abort.signal.aborted || !/^[a-f0-9]{64}$/.test(containerId)) {
        fail("executor_guardian_bind_invalid"); throw failure!;
      }
      bindSent = true;
      child.stdin.write(JSON.stringify({ type: "bind", containerId }) + "\n");
      try { await bounded(bound.promise, HANDSHAKE_MS); }
      catch (error) { fail("executor_guardian_bind_failed"); throw error; }
    },
    complete(): Promise<ExecutorJobGuardianReceipt> {
      completion ??= (async () => {
        completing = true;
        if (!exited && !child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.end(JSON.stringify({ type: "complete" }) + "\n");
        }
        await drain();
        if (failure || !receipt) throw failure ?? new Error("executor_guardian_cleanup_unverified");
        return receipt;
      })();
      return completion;
    },
  });
}
