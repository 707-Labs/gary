/** Persistent-session adapter for the existing independent deadline/parent-loss
 * guardian. No process, directory or database is created until arm() is called. */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { armExecutorJobGuardian } from './job-guardian.ts';
import type { EngineeringCommandRunner, EngineeringSessionBinding } from './engineering-session.ts';

export interface EngineeringGuardianContext {
  binding: EngineeringSessionBinding;
  containerName: string;
  deadlineMs: number;
  workspaceRoot: string;
  image: string;
  dockerBinary: string;
  dockerHost: string;
  runner: EngineeringCommandRunner;
}
export interface EngineeringSessionGuardian {
  readonly signal: AbortSignal;
  readonly daemonId: string;
  readonly reference: Readonly<{ directory: string; databasePath: string; journalId: string; invocationId: string; pid: number }>;
  bind(containerId: string): Promise<void>;
  /** Drains guardian on success AND failure, so exact-ID fallback cannot race it. */
  complete(): Promise<{ containerId: string; absenceVerified: true }>;
}
export interface EngineeringSessionGuardianFactory {
  arm(context: EngineeringGuardianContext): Promise<EngineeringSessionGuardian>;
}
function fail(code: string): never { throw new Error(code); }
function privateDirectory(path: string, exclusive = false): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) fail('engineering_guardian_directory_invalid');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || realpathSync(path) !== path) fail('engineering_guardian_directory_unprotected');
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The reused guardian has a reviewed 30-minute maximum. Host task policy must
 * narrow the session to that bound; it cannot silently renew the guardian. */
export function createEngineeringSessionGuardianFactory(options: { directory: string }): EngineeringSessionGuardianFactory {
  const root = options.directory;
  return { async arm(context) {
    const invocationId = context.containerName.replace(/^gary-longjob-/, '');
    if (!/^[a-f0-9-]{36}$/.test(invocationId) || context.containerName !== `gary-longjob-${invocationId}`
      || !Number.isSafeInteger(context.deadlineMs) || context.deadlineMs <= Date.now() || context.deadlineMs > Date.now() + 30 * 60_000
      || !isAbsolute(context.dockerBinary) || !/^unix:\/\/\/[^\x00-\x1f]+\.sock$/.test(context.dockerHost)) fail('engineering_guardian_context_invalid');
    const rel = relative(realpathSync(context.workspaceRoot), root);
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) fail('engineering_guardian_inside_workspace');
    privateDirectory(root);
    const directory = join(root, invocationId); privateDirectory(directory, true);
    const config = join(directory, 'docker-config'); privateDirectory(config, true);
    const databasePath = join(directory, 'jobs.sqlite');
    const fd = openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const db = new Database(databasePath, { strict: true });
    try {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,daemon_id TEXT NOT NULL,
          owner_pid INTEGER NOT NULL,owner_token TEXT NOT NULL,docker_host TEXT NOT NULL,docker_binary TEXT NOT NULL);
        CREATE TABLE invocations(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,binding TEXT NOT NULL,deadline_ms INTEGER NOT NULL,
          container_id TEXT,guardian_pid INTEGER);`);
      const result = await context.runner.run({ argv: [context.dockerBinary, 'info', '--format', '{{.ID}}'],
        env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', DOCKER_HOST: context.dockerHost },
        timeoutMs: Math.max(1, Math.min(5000, context.deadlineMs - Date.now())), maxOutputBytes: 4096 });
      const daemonId = result.output.trim();
      if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || !/^[a-zA-Z0-9:._-]{8,128}$/.test(daemonId)) fail('engineering_guardian_daemon_unverified');
      const journalId = randomUUID(), ownerToken = randomUUID();
      const expectedBinding = JSON.stringify({ ...context.binding, workspaceRoot: context.workspaceRoot, image: context.image });
      db.transaction(() => {
        db.query('INSERT INTO meta VALUES(1,?,?,?,?,?,?)').run(journalId, daemonId, process.pid, ownerToken, context.dockerHost, context.dockerBinary);
        db.query('INSERT INTO invocations VALUES(?,?,?,?,NULL,NULL)').run(invocationId, context.containerName, expectedBinding, context.deadlineMs);
      }).immediate();
      syncDirectory(directory); syncDirectory(root);
      const guardian = await armExecutorJobGuardian({ directory, dockerConfig: config, databasePath,
        dockerBinary: context.dockerBinary, dockerHost: context.dockerHost, journalId, invocationId,
        containerName: context.containerName, deadlineMs: context.deadlineMs, expectedBinding, ownerToken, ownerPid: process.pid });
      try { db.query('UPDATE invocations SET guardian_pid=? WHERE id=?').run(guardian.pid, invocationId); }
      catch (error) { await guardian.complete().catch(() => {}); throw error; }
      let completed: Promise<{ containerId: string; absenceVerified: true }> | undefined;
      return Object.freeze({ signal: guardian.signal, daemonId,
        reference: Object.freeze({ directory, databasePath, journalId, invocationId, pid: guardian.pid }),
        async bind(containerId: string) {
          if (completed || !/^[a-f0-9]{64}$/.test(containerId)) fail('engineering_guardian_bind_invalid');
          db.query('UPDATE invocations SET container_id=? WHERE id=? AND container_id IS NULL').run(containerId, invocationId);
          await guardian.bind(containerId);
        },
        complete() {
          completed ??= (async () => {
            try {
              const proof = await guardian.complete();
              if (proof.journalId !== journalId || proof.invocationId !== invocationId || proof.absenceVerified !== true
                || proof.containerId === null || !/^[a-f0-9]{64}$/.test(proof.containerId)) fail('engineering_guardian_receipt_invalid');
              return { containerId: proof.containerId, absenceVerified: true as const };
            } finally { db.close(); }
          })();
          return completed;
        },
      });
    } catch (error) { db.close(); throw error; }
  } };
}
