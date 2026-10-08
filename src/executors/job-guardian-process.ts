import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExecutorJobGuardianBinding } from "./job-guardian.ts";

const GRACE_MS = 15_000;
const JOB_LABEL = "dev.gary.executor-job", JOURNAL_LABEL = "dev.gary.executor-journal";
const UUID = /^[a-f0-9-]{36}$/, ID = /^[a-f0-9]{64}$/;
type Row = { id: string; name: string; binding: string; deadline_ms: number; container_id: string | null; guardian_pid: number | null };
type Meta = { id: string; daemon_id: string; owner_pid: number; owner_token: string; docker_host: string; docker_binary: string };
function fail(code: string): never { throw new Error(code); }

/** Standalone trusted child. This process deliberately never acquires/writes the SQLite owner lease. */
export async function runGuardian(): Promise<void> {
  // The launcher supplies only these two keys; detect accidental dotenv/preload inheritance.
  if (Object.keys(process.env).some(key => key !== "PATH" && key !== "HOME")) {
    process.exitCode = 1; return;
  }
  let binding: ExecutorJobGuardianBinding | undefined, db: Database | undefined, daemonId = "";
  let timer: ReturnType<typeof setTimeout> | undefined, stopPromise: Promise<void> | undefined;
  let boundId: string | null = null, input = "", inputBytes = 0, initialized = false;
  let serial = Promise.resolve();
  const bootTimer = setTimeout(() => { process.exitCode = 1; process.stdin.destroy(); }, GRACE_MS);
  const emit = (value: object) => process.stdout.write(JSON.stringify({
    journalId: binding?.journalId, invocationId: binding?.invocationId, ...value,
  }) + "\n");
  const privatePath = (path: string, directory: boolean) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
        || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
        || realpathSync(path) !== resolve(path)) fail("guardian_private_path_invalid");
    return stat;
  };
  let dbIdentity = "";
  const read = (initial = false): Row => {
    if (!binding || !db) fail("guardian_not_armed");
    privatePath(binding.directory, true); privatePath(binding.dockerConfig, true);
    const stat = privatePath(binding.databasePath, false);
    if (`${stat.dev}:${stat.ino}` !== dbIdentity || readdirSync(binding.dockerConfig).length) fail("guardian_identity_changed");
    const meta = db.query("SELECT * FROM meta WHERE singleton=1").get() as Meta | null;
    const row = db.query("SELECT id,name,binding,deadline_ms,container_id,guardian_pid FROM invocations WHERE id=?").get(binding.invocationId) as Row | null;
    if (!meta || meta.id !== binding.journalId || meta.daemon_id !== daemonId
        || meta.docker_host !== binding.dockerHost || meta.docker_binary !== binding.dockerBinary
        || (initial && (meta.owner_pid !== binding.ownerPid || meta.owner_token !== binding.ownerToken))
        || !row || row.name !== binding.containerName || row.binding !== binding.expectedBinding
        || row.deadline_ms !== binding.deadlineMs || (row.container_id !== null && !ID.test(row.container_id))
        || (boundId !== null && row.container_id !== boundId)) fail("guardian_journal_binding_changed");
    return row;
  };
  const cli = (args: string[], deadline: number): Promise<{ ok: boolean; stdout: string }> => {
    if (!binding) fail("guardian_not_armed");
    const timeout = Math.max(1, Math.min(GRACE_MS, deadline - Date.now()));
    // Inherit guardian's process group, so a bounded parent force-stop also drains its CLI.
    return new Promise(resolveResult => execFile(binding!.dockerBinary,
      ["--host", binding!.dockerHost, "--config", binding!.dockerConfig, ...args], {
        cwd: binding!.dockerConfig, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: binding!.dockerConfig },
        timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8",
      }, (error, stdout) => resolveResult({ ok: !error, stdout })));
  };
  const daemon = async (deadline: number) => {
    const result = await cli(["info", "--format", "{{.ID}}"], deadline);
    if (!result.ok || result.stdout.trim() !== daemonId) fail("guardian_daemon_unverified");
  };
  const ids = async (deadline: number, filter: string) => {
    const result = await cli(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", filter], deadline);
    if (!result.ok) fail("guardian_absence_unverified");
    const values = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
    if (values.length > 1 || values.some(id => !ID.test(id))) fail("guardian_identity_unverified");
    return values;
  };
  const verify = async (id: string, deadline: number) => {
    const result = await cli(["container", "inspect", "--format", "{{json .}}", id], deadline);
    if (!result.ok) fail("guardian_identity_unverified");
    let item: { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> } };
    try { item = JSON.parse(result.stdout); } catch { fail("guardian_identity_unverified"); }
    if (item!.Id !== id || item!.Name !== `/${binding!.containerName}`
        || item!.Config?.Labels?.[JOB_LABEL] !== binding!.invocationId
        || item!.Config?.Labels?.[JOURNAL_LABEL] !== binding!.journalId) fail("guardian_ownership_mismatch");
  };
  const cleanup = async (): Promise<string> => {
    const deadline = Date.now() + GRACE_MS;
    const row = read();
    await daemon(deadline);
    const found = await ids(deadline, `name=^/${binding!.containerName}$`);
    const known = row.container_id ?? boundId;
    if (known !== null && found.some(id => id !== known)) fail("guardian_identity_unverified");
    const id = known ?? found[0];
    if (!id) fail("guardian_spawn_unresolved");
    const direct = await ids(deadline, `id=${id}`);
    if (direct.some(value => value !== id)) fail("guardian_identity_unverified");
    if (found.length || direct.length) {
      try { await verify(id, deadline); }
      catch (error) {
        // A --rm completion race is harmless only after two positive absence probes.
        if ((await ids(deadline, `name=^/${binding!.containerName}$`)).length
            || (await ids(deadline, `id=${id}`)).length) throw error;
        if (known === null) throw error;
        return id;
      }
      const removed = await cli(["container", "rm", "--force", id], deadline);
      if (!removed.ok) fail("guardian_removal_failed");
    }
    if ((await ids(deadline, `name=^/${binding!.containerName}$`)).length
        || (await ids(deadline, `id=${id}`)).length) fail("guardian_absence_unverified");
    read();
    return id;
  };
  const receipt = (value: object) => {
    if (!binding || !initialized) return;
    privatePath(binding.directory, true);
    const path = join(binding.directory, `guardian-${binding.invocationId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ journalId: binding.journalId, invocationId: binding.invocationId,
      deadlineMs: binding.deadlineMs, ...value }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(binding.directory, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const stop = (reason: string): Promise<void> => {
    stopPromise ??= (async () => {
      clearTimeout(timer); clearTimeout(bootTimer); emit({ type: "stopping", reason });
      let exit = 1;
      try {
        const containerId = await cleanup();
        receipt({ absenceVerified: true, containerId, reason });
        emit({ type: "complete", absenceVerified: true, containerId }); exit = 0;
      } catch {
        try { receipt({ absenceVerified: false, containerId: boundId, reason }); } catch { /* No fabricated receipt. */ }
        emit({ type: "error" });
      } finally {
        db?.close();
        process.stdout.end(() => process.exit(exit));
      }
    })();
    return stopPromise;
  };
  process.stdout.on("error", () => { void stop("parent_disconnected"); });
  const receive = async (message: unknown) => {
    if (stopPromise) return;
    if (!message || typeof message !== "object") fail("guardian_control_invalid");
    const value = message as Record<string, unknown>;
    if (!initialized) {
      if (value.type !== "arm" || !value.binding || typeof value.binding !== "object") fail("guardian_control_invalid");
      binding = value.binding as ExecutorJobGuardianBinding;
      if (!UUID.test(binding.journalId) || !UUID.test(binding.invocationId)
          || binding.containerName !== `gary-longjob-${binding.invocationId}`
          || !Number.isSafeInteger(binding.ownerPid) || binding.ownerPid < 1
          || typeof binding.ownerToken !== "string" || !binding.ownerToken
          || typeof binding.expectedBinding !== "string" || binding.expectedBinding.length > 16_384
          || !Number.isSafeInteger(binding.deadlineMs) || binding.deadlineMs <= Date.now()
          || binding.deadlineMs > Date.now() + 30 * 60_000
          || !isAbsolute(binding.dockerBinary) || !/^unix:\/\/\/[^\x00-\x1f]+$/.test(binding.dockerHost)
          || !isAbsolute(binding.directory) || binding.databasePath !== join(binding.directory, "jobs.sqlite")
          || binding.dockerConfig !== join(binding.directory, "docker-config")) fail("guardian_manifest_invalid");
      privatePath(binding.directory, true); privatePath(binding.dockerConfig, true);
      const stat = privatePath(binding.databasePath, false); dbIdentity = `${stat.dev}:${stat.ino}`;
      db = new Database(binding.databasePath, { readonly: true, strict: true });
      db.exec("PRAGMA busy_timeout=1000;");
      daemonId = (db.query("SELECT daemon_id FROM meta WHERE singleton=1").get() as Meta | null)?.daemon_id ?? "";
      if (!/^[a-zA-Z0-9:._-]{8,128}$/.test(daemonId)) fail("guardian_daemon_unverified");
      read(true);
      // The one-shot monotonic timer cannot be renewed by messages or wall-clock rollback.
      timer = setTimeout(() => { void stop("deadline"); }, binding.deadlineMs - Date.now());
      initialized = true; clearTimeout(bootTimer);
      await daemon(Math.min(binding.deadlineMs, Date.now() + GRACE_MS));
      if (!stopPromise) emit({ type: "armed" });
    } else if (value.type === "bind" && boundId === null && typeof value.containerId === "string" && ID.test(value.containerId)) {
      const row = read();
      if (row.container_id !== value.containerId || row.guardian_pid !== process.pid) fail("guardian_container_not_durable");
      boundId = value.containerId;
      await daemon(Math.min(binding!.deadlineMs, Date.now() + GRACE_MS));
      await verify(boundId, binding!.deadlineMs);
      if (!stopPromise) emit({ type: "bound" });
    } else if (value.type === "complete") await stop("parent_complete");
    else fail("guardian_control_invalid");
  };
  process.stdin.on("data", (chunk: Buffer) => {
    inputBytes += chunk.length;
    if (inputBytes > 32_768) { void stop("control_overflow"); return; }
    input += chunk.toString();
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      serial = serial.then(async () => { await receive(JSON.parse(line)); }).catch(() => stop("control_invalid"));
    }
  });
  process.stdin.on("end", () => {
    if (initialized) void stop("parent_eof");
    else void serial.finally(() => stop("parent_eof"));
  });
  process.stdin.on("error", () => { void stop("parent_disconnected"); });
}
if (import.meta.main) await runGuardian();
