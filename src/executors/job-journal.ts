import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DeadlineOptions } from "../deadline.ts";
import { throwIfExpired } from "../deadline.ts";
import type { ExecResult } from "./index.ts";
import { runProcess } from "./process.ts";
import { armExecutorJobGuardian, type ExecutorJobGuardian } from "./job-guardian.ts";
import type { ExecutorCleanupGuard } from "./cleanup-guard.ts";

export const EXECUTOR_JOB_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CLEANUP_MS = 15_000;
const LABEL = "dev.gary.executor-job";
const JOURNAL_LABEL = "dev.gary.executor-journal";
const instances = new WeakSet<object>();

export interface ExecutorTestJob {
  readonly jobId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly ownerEpoch: string;
  readonly journal: ExecutorJobJournal;
}
export interface ExecutorJobJournal {
  readonly directory: string;
  /** Release the exclusive host ownership only when no invocation is active. */
  close(): void;
}
interface RecordRow {
  id: string; name: string; state: string; binding: string; deadline_ms: number; container_id: string | null; guardian_pid: number | null;
}
interface MetaRow { id: string; daemon_id: string | null; owner_pid: number | null; owner_token: string | null }
interface Invocation {
  context: ExecutorTestJob;
  /** The same sticky action fence used by ordinary executors and paid requests. */
  cleanupGuard: ExecutorCleanupGuard;
  workspaceRoot: string;
  image: string;
  mountedRoots?: readonly string[];
  /** Hash the complete effective Docker argv, not just the model command. */
  args: string[];
  options: DeadlineOptions & { timeoutMs: number; stdin?: string };
}

function fail(code: string): never { throw new Error(code); }
function privateDirectory(path: string, create: boolean): string {
  if (!isAbsolute(path)) fail("executor_journal_directory_invalid");
  const canonicalParent = realpathSync(dirname(path));
  if (canonicalParent !== dirname(resolve(path))) fail("executor_journal_symlink_parent");
  if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700
      || realpathSync(path) !== resolve(path)) fail("executor_journal_directory_unprotected");
  return resolve(path);
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function contextSnapshot(context: ExecutorTestJob): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["jobId", "taskId", "requestId", "actionId", "ownerEpoch"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
        || descriptor.value.length < 1 || descriptor.value.length > 256 || /[\x00-\x1f]/.test(descriptor.value)) {
      fail("executor_job_context_invalid");
    }
    result[key] = descriptor.value;
  }
  return result;
}

/**
 * Durable pre-spawn intents; a process lease prevents concurrent recovery/admission.
 * Dead PID leases may be reclaimed. PID reuse conservatively blocks recovery.
 * Each start is acknowledged by an independent deadline/parent-loss guardian.
 * Reconciliation refuses live guardians and never adopts or re-runs jobs.
 * An unavailable daemon remains cleanup_unknown and blocks new admission.
 */
class Journal implements ExecutorJobJournal {
  readonly directory: string;
  private readonly db: Database;
  private readonly dockerHost: string;
  private readonly binary: string;
  private readonly config: string;
  private readonly token = randomUUID();
  private readonly id: string;
  private ready = false;
  private closed = false;
  private busy = false;

  constructor(options: { directory: string; dockerHost: string; dockerBinary: string }) {
    if (!isAbsolute(options.dockerBinary) || !/^unix:\/\/\/[^\x00-\x1f]+$/.test(options.dockerHost)) {
      fail("executor_journal_docker_binding_invalid");
    }
    this.binary = options.dockerBinary;
    this.dockerHost = options.dockerHost;
    this.directory = privateDirectory(options.directory, true);
    this.config = privateDirectory(join(this.directory, "docker-config"), true);
    const path = join(this.directory, "jobs.sqlite");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) {
      fail("executor_journal_database_unprotected");
    }
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
      if ((this.db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous !== 2) fail("executor_journal_not_durable");
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL,
        daemon_id TEXT, owner_pid INTEGER, owner_token TEXT, docker_host TEXT NOT NULL, docker_binary TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
        binding TEXT NOT NULL, deadline_ms INTEGER NOT NULL, created_ms INTEGER NOT NULL, terminal_ms INTEGER, container_id TEXT, guardian_pid INTEGER);`);
      this.id = this.db.transaction(() => {
        const prior = this.db.query("SELECT * FROM meta WHERE singleton=1").get() as (MetaRow & { docker_host: string; docker_binary: string }) | null;
        if (prior && (prior.docker_host !== this.dockerHost || prior.docker_binary !== this.binary)) fail("executor_journal_binding_changed");
        if (prior?.owner_pid !== null && prior?.owner_pid !== undefined && pidAlive(prior.owner_pid)) fail("executor_journal_owner_alive");
        const id = prior?.id ?? randomUUID();
        if (prior) this.db.query("UPDATE meta SET owner_pid=?,owner_token=? WHERE singleton=1").run(process.pid, this.token);
        else this.db.query("INSERT INTO meta VALUES(1,?,NULL,?,?,?,?)").run(id, process.pid, this.token, this.dockerHost, this.binary);
        return id;
      }).immediate();
      syncDirectory(this.directory);
      instances.add(this);
    } catch (e) { this.db.close(); throw e; }
  }

  private owned(): void {
    if (this.closed) fail("executor_journal_closed");
    privateDirectory(this.directory, false);
    privateDirectory(this.config, false);
    if (readdirSync(this.config).length) fail("executor_journal_docker_config_changed");
    const owner = this.db.query("SELECT owner_pid,owner_token FROM meta WHERE singleton=1").get() as MetaRow;
    if (owner.owner_pid !== process.pid || owner.owner_token !== this.token) fail("executor_journal_owner_changed");
  }

  private async cli(args: string[], options: DeadlineOptions & { timeoutMs: number; stdin?: string; maxOutputBytes?: number }): Promise<ExecResult> {
    this.owned();
    // No inherited DOCKER_CONTEXT, config, credential helpers or host secrets.
    return runProcess(this.binary, ["--host", this.dockerHost, "--config", this.config, ...args], {
      ...options, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: this.config },
      maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
    });
  }

  private async daemon(deadlineMs: number): Promise<void> {
    const result = await this.cli(["info", "--format", "{{.ID}}"], { timeoutMs: CLEANUP_MS, deadlineMs });
    const id = result.stdout.trim();
    if (result.exitCode !== 0 || result.timedOut || !/^[a-zA-Z0-9:._-]{8,128}$/.test(id)) fail("executor_journal_daemon_unverified");
    const meta = this.db.query("SELECT daemon_id FROM meta WHERE singleton=1").get() as MetaRow;
    if (meta.daemon_id !== null && meta.daemon_id !== id) fail("executor_journal_daemon_changed");
    if (meta.daemon_id === null) this.db.query("UPDATE meta SET daemon_id=? WHERE singleton=1").run(id);
  }

  private async ids(name: string, deadlineMs: number, byId = false): Promise<string[]> {
    const result = await this.cli(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", byId ? `id=${name}` : `name=^/${name}$`], { timeoutMs: CLEANUP_MS, deadlineMs });
    if (result.exitCode !== 0 || result.timedOut) fail("executor_job_absence_unverified");
    const ids = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
    if (ids.length > 1 || ids.some(id => !/^[a-f0-9]{64}$/.test(id) || (byId && id !== name))) fail("executor_job_identity_unverified");
    return ids;
  }

  private async cleanup(record: RecordRow): Promise<boolean> {
    const deadlineMs = Date.now() + CLEANUP_MS;
    await this.daemon(deadlineMs);
    const named = await this.ids(record.name, deadlineMs);
    const recorded = record.container_id === null ? [] : await this.ids(record.container_id, deadlineMs, true);
    const ids = [...new Set([...named, ...recorded])];
    for (const id of ids) {
      if (record.container_id !== null && record.container_id !== id) fail("executor_job_identity_unverified");
      const result = await this.cli(["container", "inspect", "--format", "{{json .}}", id], { timeoutMs: CLEANUP_MS, deadlineMs });
      // --rm may remove it between list/inspect. Only a fresh successful empty
      // listing establishes absence; never infer absence from CLI error text.
      if (result.exitCode !== 0 || result.timedOut) {
        if ((await this.ids(record.name, deadlineMs)).length === 0 && record.container_id !== null
            && (await this.ids(record.container_id, deadlineMs, true)).length === 0) return true;
        fail("executor_job_identity_unverified");
      }
      let item: { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> } };
      try { item = JSON.parse(result.stdout); } catch { fail("executor_job_identity_unverified"); }
      if (item!.Id !== id || item!.Name !== `/${record.name}` || item!.Config?.Labels?.[LABEL] !== record.id
          || item!.Config?.Labels?.[JOURNAL_LABEL] !== this.id) fail("executor_job_ownership_mismatch");
      // Remove the immutable ID, not the mutable name (prevents replacement ABA).
      const removed = await this.cli(["container", "rm", "--force", id], { timeoutMs: CLEANUP_MS, deadlineMs });
      if (removed.exitCode !== 0 || removed.timedOut) fail("executor_job_cleanup_failed");
    }
    if ((await this.ids(record.name, deadlineMs)).length !== 0
        || (record.container_id !== null && (await this.ids(record.container_id, deadlineMs, true)).length !== 0)) fail("executor_job_absence_unverified");
    return record.container_id !== null || ids.length > 0;
  }

  async reconcile(): Promise<void> {
    this.owned();
    if (this.busy) fail("executor_journal_busy");
    this.busy = true;
    this.ready = false;
    try {
      await this.daemon(Date.now() + CLEANUP_MS);
      const rows = this.db.query("SELECT id,name,state,binding,deadline_ms,container_id,guardian_pid FROM invocations WHERE state IN ('pending','cleanup_unknown','spawn_unknown') ORDER BY created_ms,id").all() as RecordRow[];
      for (const row of rows) {
        if (row.guardian_pid !== null && pidAlive(row.guardian_pid)) fail("executor_job_guardian_alive");
        if (!/^[a-f0-9-]{36}$/.test(row.id) || row.name !== `gary-longjob-${row.id}`) fail("executor_journal_record_invalid");
        if (!await this.cleanup(row)) fail("executor_job_spawn_unresolved");
        this.db.query("UPDATE invocations SET state='abandoned',terminal_ms=? WHERE id=?").run(Date.now(), row.id);
      }
      this.ready = true;
    } finally { this.busy = false; }
  }

  async invoke(invocation: Invocation): Promise<ExecResult> {
    invocation.cleanupGuard.assertSafe();
    this.owned();
    if (!this.ready || this.busy) fail("executor_journal_not_ready");
    const context = contextSnapshot(invocation.context);
    for (const root of invocation.mountedRoots ?? [invocation.workspaceRoot]) {
      const rel = relative(realpathSync(root), this.directory);
      if (!(rel === ".." || rel.startsWith(`..${sep}`)) && !isAbsolute(rel)) fail("executor_journal_inside_workspace");
    }
    if (!Number.isFinite(invocation.options.deadlineMs) || !Number.isFinite(invocation.options.timeoutMs)
        || invocation.options.timeoutMs <= 0 || invocation.options.timeoutMs > 30 * 60_000) fail("executor_job_deadline_required");
    throwIfExpired(invocation.options);
    const deadlineMs = Math.min(invocation.options.deadlineMs!, Date.now() + invocation.options.timeoutMs);
    this.busy = true;
    let record: RecordRow | undefined;
    let cleanupProven = false, terminalPersisted = false, creationAttempted = false;
    try {
      await this.daemon(Math.min(deadlineMs, Date.now() + CLEANUP_MS));
      throwIfExpired({ ...invocation.options, deadlineMs });
      const id = randomUUID();
      const name = `gary-longjob-${id}`;
      const args = [...invocation.args];
      const nameIndex = args.indexOf("--name");
      if (args[0] !== "run" || nameIndex < 0) fail("executor_job_argv_invalid");
      args[0] = "create";
      args[nameIndex + 1] = name;
      args.splice(1, 0, "--label", `${LABEL}=${id}`, "--label", `${JOURNAL_LABEL}=${this.id}`);
      record = { id, name, state: "pending", deadline_ms: deadlineMs, container_id: null, guardian_pid: null,
        binding: JSON.stringify({ ...context, workspaceRoot: invocation.workspaceRoot, image: invocation.image, argvSha256: hash(args) }) };
      // Synchronous FULL transaction completes before the first docker create byte.
      this.db.query("INSERT INTO invocations VALUES(?,?,?,?,?,?,NULL,NULL,NULL)").run(record.id, record.name, record.state, record.binding, deadlineMs, Date.now());
      let result: ExecResult | undefined;
      let error: unknown;
      let guardian: ExecutorJobGuardian | undefined;
      try {
        guardian = await armExecutorJobGuardian({
          dockerHost: this.dockerHost, dockerBinary: this.binary, dockerConfig: this.config,
          directory: this.directory, databasePath: join(this.directory, "jobs.sqlite"),
          journalId: this.id, invocationId: id, containerName: name, deadlineMs,
          expectedBinding: record.binding, ownerToken: this.token, ownerPid: process.pid,
        });
        record.guardian_pid = guardian.pid;
        this.db.query("UPDATE invocations SET guardian_pid=? WHERE id=?").run(guardian.pid, id);
        const signal = invocation.options.signal ? AbortSignal.any([invocation.options.signal, guardian.signal]) : guardian.signal;
        throwIfExpired({ signal, deadlineMs });
        creationAttempted = true;
        const created = await this.cli(args, { deadlineMs, signal, timeoutMs: Math.min(CLEANUP_MS, invocation.options.timeoutMs) });
        const containerId = created.stdout.trim();
        if (created.exitCode !== 0 || created.timedOut || !/^[a-f0-9]{64}$/.test(containerId)) fail("executor_job_create_unverified");
        record.container_id = containerId;
        this.db.query("UPDATE invocations SET container_id=? WHERE id=?").run(containerId, record.id);
        await guardian.bind(containerId);
        throwIfExpired({ signal, deadlineMs });
        // Start only after independent guardian acknowledgement of the durable
        // immutable ID. The guardian survives parent death and owns cleanup.
        result = await this.cli(["start", "--attach", "--interactive", containerId], {
          ...invocation.options, deadlineMs, signal, maxOutputBytes: EXECUTOR_JOB_OUTPUT_LIMIT,
        });
      } catch (e) { error = e; }
      try {
        let proven = !creationAttempted;
        if (guardian) {
          try {
            // complete() guarantees child exit on both fulfillment/rejection;
            // parent fallback must never compete with a live guardian remover.
            const receipt = await guardian.complete();
            if (receipt.journalId !== this.id || receipt.invocationId !== record.id
                || receipt.absenceVerified !== true
                || (record.container_id !== null && receipt.containerId !== record.container_id)) fail("executor_guardian_receipt_invalid");
            if (record.container_id === null) record.container_id = receipt.containerId;
            const proofDeadline = Date.now() + CLEANUP_MS;
            await this.daemon(proofDeadline);
            if ((await this.ids(record.name, proofDeadline)).length !== 0
                || (record.container_id !== null && (await this.ids(record.container_id, proofDeadline, true)).length !== 0)) fail("executor_job_absence_unverified");
            proven = !creationAttempted || record.container_id !== null;
          } catch (guardianError) {
            error ??= guardianError;
            if (creationAttempted) proven = await this.cleanup(record);
          }
        }
        if (!proven) {
          this.db.query("UPDATE invocations SET state='spawn_unknown' WHERE id=?").run(record.id);
          fail("executor_job_spawn_unresolved");
        }
        cleanupProven = true;
      } catch (e) {
        this.ready = false;
        if (record.container_id !== null) this.db.query("UPDATE invocations SET state='cleanup_unknown' WHERE id=?").run(record.id);
        if (e instanceof Error && e.message === "executor_job_spawn_unresolved") throw e;
        fail("executor_job_cleanup_unverified");
      }
      const success = !error && result?.exitCode === 0 && !result.timedOut;
      this.db.query("UPDATE invocations SET state=?,terminal_ms=? WHERE id=?").run(success ? "completed" : "failed", Date.now(), record.id);
      terminalPersisted = true;
      if (error) throw error;
      return result!;
    } catch (e) {
      // A durable pending row survives any unanticipated journal/IO failure.
      // No further invocation is admitted until recovery proves its absence.
      if (record) {
        this.ready = false;
        // Journal refusal only fences a later executor invocation. A reviewer
        // can catch this tool error and approve without invoking another tool,
        // so uncertain physical cleanup or durable closure must also revoke the
        // shared action and every subsequent physical model/publication path.
        // Keep known-clean failed command results recoverable.
        if (!cleanupProven || !terminalPersisted) invocation.cleanupGuard.markUncertain({
          container: record.name,
          reason: cleanupProven || !creationAttempted ? "journal_terminal_unverified"
            : record.container_id === null ? "journal_spawn_unresolved" : "journal_cleanup_unverified",
          exitCode: null, timedOut: null,
        });
      }
      throw e;
    } finally { this.busy = false; }
  }

  close(): void {
    this.owned();
    if (this.busy) fail("executor_journal_busy");
    this.db.query("UPDATE meta SET owner_pid=NULL,owner_token=NULL WHERE singleton=1 AND owner_token=?").run(this.token);
    this.db.close(); this.closed = true;
  }
}

export function createExecutorJobJournal(options: { directory: string; dockerHost: string; dockerBinary: string }): ExecutorJobJournal {
  return new Journal(options);
}
export async function reconcileDockerExecutorJobs(journal: ExecutorJobJournal): Promise<void> {
  if (!instances.has(journal)) fail("executor_journal_untrusted");
  await (journal as Journal).reconcile();
}
/** Internal executor entry point; genuine host-created journal only. */
export async function runJournaledDockerInvocation(invocation: Invocation): Promise<ExecResult> {
  const descriptor = Object.getOwnPropertyDescriptor(invocation.context, "journal");
  if (!descriptor || !("value" in descriptor) || !instances.has(descriptor.value)) fail("executor_journal_untrusted");
  return (descriptor.value as Journal).invoke(invocation);
}
