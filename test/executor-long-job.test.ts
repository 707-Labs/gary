import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerExecutor } from "../src/executors/docker.ts";
import { createExecutorJobJournal, reconcileDockerExecutorJobs, type ExecutorJobJournal, type ExecutorTestJob } from "../src/executors/index.ts";
import { runProcess } from "../src/executors/process.ts";

let root: string, workspace: string, binary: string, directory: string, modePath: string, callsPath: string, containerPath: string;
let journal: ExecutorJobJournal | undefined;
let savedSecret: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "gary-long-job-")));
  workspace = join(root, "workspace"); mkdirSync(workspace);
  binary = join(root, "docker-fake"); directory = join(root, "journal"); modePath = join(root, "mode.json");
  callsPath = join(root, "calls.jsonl"); containerPath = join(root, "container.json");
  writeFileSync(modePath, "{}"); writeFileSync(callsPath, "");
  savedSecret = process.env.GARY_FAKE_SECRET; process.env.GARY_FAKE_SECRET = "must-never-be-in-child";
  writeFileSync(binary, `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
const raw=process.argv.slice(2); const args=raw.slice(4);
const mode=JSON.parse(readFileSync(${JSON.stringify(modePath)},'utf8'));
const path=${JSON.stringify(containerPath)};
const record=()=>JSON.parse(readFileSync(path,'utf8'));
appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({raw,args,secret:process.env.GARY_FAKE_SECRET??null,context:process.env.DOCKER_CONTEXT??null})+'\\n');
if(args[0]==='info'){console.log(mode.daemon??'fake-daemon-0123456789');process.exit(0);}
if(args[0]==='create'){
  if(mode.createNoContainer)process.exit(7);
  const name=args[args.indexOf('--name')+1];const labels={};
  args.forEach((a,i)=>{if(a==='--label'){const [k,v]=args[i+1].split('=');labels[k]=v;}});
  const id=createHash('sha256').update(name).digest('hex');
  writeFileSync(path,JSON.stringify({Id:id,Name:'/'+name,Config:{Labels:labels}}));
  if(mode.createLost)process.exit(9);
  console.log(id);process.exit(0);
}
if(args[0]==='start'){
  if(mode.rename){const r=record();r.Name='/renamed';writeFileSync(path,JSON.stringify(r));}
  if(mode.overflow){process.stdout.write(Buffer.alloc(9*1024*1024,97));process.stderr.write(Buffer.alloc(9*1024*1024,98));setInterval(()=>{},1000);}
  else if(mode.hang){console.log('started');setInterval(()=>{},1000);}
  else {console.log('completed-check');console.error('check-stderr');process.exit(mode.exitCode??0);}
}
else if(args[0]==='container'&&args[1]==='ls'){
  if(mode.listFail)process.exit(1);
  if(existsSync(path)){ const r=record();const filter=args.at(-1);if(filter.startsWith('id=')?filter.slice(3)===r.Id:filter==='name=^'+r.Name+'$')console.log(r.Id); }
}
else if(args[0]==='container'&&args[1]==='inspect'){
  if(!existsSync(path))process.exit(1);
  const r=record(); if(mode.foreign)r.Config.Labels['dev.gary.executor-job']='foreign';console.log(JSON.stringify(r));
}
else if(args[0]==='container'&&args[1]==='rm'){
  if(mode.rmFail)process.exit(1);
  const recordName=existsSync(path)?record().Name:'/unknown';
  if(existsSync(path))rmSync(path);
  if(mode.replacement)writeFileSync(path,JSON.stringify({Id:'b'.repeat(64),Name:recordName,Config:{Labels:{}}}));
}
else process.exit(88);
`, { mode: 0o755 });
});
afterEach(() => {
  try { journal?.close(); } catch { /* tests may explicitly close */ }
  journal = undefined;
  if (savedSecret === undefined) delete process.env.GARY_FAKE_SECRET; else process.env.GARY_FAKE_SECRET = savedSecret;
  rmSync(root, { recursive: true, force: true });
});
function mode(value: Record<string, unknown>) { writeFileSync(modePath, JSON.stringify(value)); }
function open(): ExecutorJobJournal {
  return createExecutorJobJournal({ directory, dockerHost: "unix:///fake/docker.sock", dockerBinary: binary });
}
async function ready() { journal = open(); await reconcileDockerExecutorJobs(journal); }
function context(): ExecutorTestJob { return Object.freeze({ jobId: "logical-job", taskId: "task", requestId: "request", actionId: "action", ownerEpoch: "owner", journal: journal! }); }
function executor(readOnly = false) { return new DockerExecutor(workspace, { image: "sha256:" + "a".repeat(64), dockerBinary: binary, readOnly }); }
function rows(): Array<Record<string, unknown>> { const db = new Database(join(directory, "jobs.sqlite"), { readonly: true }); try { return db.query("SELECT * FROM invocations").all() as Array<Record<string, unknown>>; } finally { db.close(); } }
function calls(): Array<{ raw: string[]; args: string[]; secret: string | null; context: string | null }> { return readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
function run(options: { timeoutMs?: number; signal?: AbortSignal; deadlineMs?: number } = {}) {
  return executor().run("bun run ci:full", { testJob: context(), timeoutMs: 10_000, deadlineMs: Date.now() + 10_000, ...options });
}

test("durable labeled create/start/immutable-ID cleanup and absence precede success; clean client environment", async () => {
  await ready();
  expect((await run()).stdout).toBe("completed-check\n");
  const row = rows()[0]!;
  expect(row.state).toBe("completed"); expect(row.container_id).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(row.binding as string)).toMatchObject({ jobId: "logical-job", ownerEpoch: "owner", actionId: "action" });
  expect(existsSync(containerPath)).toBe(false);
  expect(row.guardian_pid).toBeNumber();
  const receipt = JSON.parse(readFileSync(join(directory, `guardian-${row.id}.json`), "utf8"));
  expect(receipt.absenceVerified).toBe(true); expect(receipt.containerId).toBe(row.container_id);
  const cs = calls(); expect(cs.every(c => c.secret === null && c.context === null)).toBe(true);
  expect(cs.every(c => c.raw[0] === "--host" && c.raw[1] === "unix:///fake/docker.sock")).toBe(true);
  const create = cs.find(c => c.args[0] === "create")!;
  expect(create.args).toContain("--network"); expect(create.args).toContain("none");
  expect(create.args).toContain("--cap-drop=ALL"); expect(create.args).toContain(`dev.gary.executor-job=${row.id}`);
  const start = cs.find(c => c.args[0] === "start")!;
  expect(start.args.at(-1)).toBe(row.container_id as string);
  expect(cs.find(c => c.args[1] === "rm")!.args.at(-1)).toBe(row.container_id as string);
  expect(cs.at(-1)!.args[1]).toBe("ls");
  await run(); expect(rows()).toHaveLength(2); expect(rows()[0]!.id).not.toBe(rows()[1]!.id);
});

test("nonzero execution still removes the owned container and retains failed record", async () => {
  await ready(); mode({ exitCode: 19 });
  expect((await run()).exitCode).toBe(19); expect(rows()[0]!.state).toBe("failed"); expect(existsSync(containerPath)).toBe(false);
});

test("cancellation kills CLI, awaits container removal, and returns timeout", async () => {
  await ready(); mode({ hang: true });
  const controller = new AbortController();
  const pending = run({ signal: controller.signal });
  // Wait for actual start, not an arbitrary timeout preceding spawn.
  while (!calls().some(c => c.args[0] === "start")) await Bun.sleep(5);
  controller.abort();
  const result = await pending;
  expect(result.timedOut).toBe(true); expect(existsSync(containerPath)).toBe(false); expect(rows()[0]!.state).toBe("failed");
});

test("absolute command deadline cannot be extended by a larger timeout", async () => {
  await ready(); mode({ hang: true });
  const result = await run({ timeoutMs: 5_000, deadlineMs: Date.now() + 400 });
  expect(result.timedOut).toBe(true); expect(existsSync(containerPath)).toBe(false); expect(rows()[0]!.state).toBe("failed");
});

test("combined stdout/stderr overflow is terminal after exact cleanup", async () => {
  await ready(); mode({ overflow: true });
  await expect(run()).rejects.toThrow("executor_output_limit_exceeded");
  expect(existsSync(containerPath)).toBe(false); expect(rows()[0]!.state).toBe("failed");
  await expect(run()).rejects.toThrow("executor_journal_not_ready");
});

test.each(["rmFail", "foreign", "listFail", "replacement"])("%s cleanup uncertainty blocks further admission", async flag => {
  await ready(); mode({ [flag]: true });
  await expect(run()).rejects.toThrow("executor_job_cleanup_unverified");
  expect(rows()[0]!.state).toBe("cleanup_unknown");
  await expect(run()).rejects.toThrow("executor_journal_not_ready");
  if (flag === "foreign") expect(calls().some(c => c.args[1] === "rm")).toBe(false);
});

test("restart reconciliation removes only recorded owned container and abandons, never runs it", async () => {
  await ready(); mode({ rmFail: true }); await expect(run()).rejects.toThrow("executor_job_cleanup_unverified");
  const original = rows()[0]!;
  journal!.close(); journal = open(); mode({});
  const before = calls().length;
  await reconcileDockerExecutorJobs(journal);
  expect(rows()[0]!.state).toBe("abandoned"); expect(rows()[0]!.id).toBe(original.id);
  expect(existsSync(containerPath)).toBe(false);
  expect(calls().slice(before).some(c => c.args[0] === "start" || c.args[0] === "create")).toBe(false);
  await run(); expect(rows()).toHaveLength(2);
});

test("daemon changes block recovery without removing from a different daemon", async () => {
  await ready(); mode({ rmFail: true }); await expect(run()).rejects.toThrow();
  journal!.close(); journal = open(); mode({ daemon: "different-daemon-0001" });
  const before = calls().length;
  await expect(reconcileDockerExecutorJobs(journal)).rejects.toThrow("executor_journal_daemon_changed");
  expect(calls().slice(before).every(c => c.args[0] === "info")).toBe(true);
});

test("ambiguous create without observed container remains unresolved despite empty listing", async () => {
  await ready(); mode({ createNoContainer: true });
  await expect(run()).rejects.toThrow("executor_job_spawn_unresolved");
  expect(rows()[0]!.state).toBe("spawn_unknown");
  journal!.close(); journal = open(); mode({});
  await expect(reconcileDockerExecutorJobs(journal)).rejects.toThrow("executor_job_spawn_unresolved");
  expect(calls().some(c => c.args[0] === "start")).toBe(false);
});

test("lost create response with observed owned container removes it but never starts it", async () => {
  await ready(); mode({ createLost: true });
  await expect(run()).rejects.toThrow("executor_job_create_unverified");
  expect(rows()[0]!.state).toBe("failed"); expect(existsSync(containerPath)).toBe(false);
  expect(calls().some(c => c.args[0] === "start")).toBe(false);
});

test("journal cannot be shared with a live owner or used before reconciliation", async () => {
  journal = open(); expect(() => open()).toThrow("executor_journal_owner_alive");
  await expect(run()).rejects.toThrow("executor_journal_not_ready"); expect(rows()).toHaveLength(0);
});

test("read-only executor, forged journal, unbounded timeout and mounted journal reject before creation", async () => {
  await ready();
  await expect(executor(true).run("noop", { testJob: context(), deadlineMs: Date.now() + 1000 })).rejects.toThrow("executor_job_requires_isolated_coding_executor");
  await expect(executor().run("noop", { testJob: { ...context(), journal: { directory, close() {} } }, deadlineMs: Date.now() + 1000 })).rejects.toThrow("executor_journal_untrusted");
  await expect(run({ timeoutMs: 1_800_001 })).rejects.toThrow("executor_job_deadline_required");
  await expect(new DockerExecutor(root, { image: "fixture" }).run("noop", { testJob: context(), deadlineMs: Date.now() + 1000 })).rejects.toThrow("executor_journal_inside_workspace");
  expect(rows()).toHaveLength(0); expect(calls().some(c => c.args[0] === "create")).toBe(false);
});

test("private journal permissions and persistent client binding cannot drift", async () => {
  mkdirSync(directory, { mode: 0o755 });
  expect(() => open()).toThrow("executor_journal_directory_unprotected");
  chmodSync(directory, 0o700); await ready(); journal!.close();
  expect(() => createExecutorJobJournal({ directory, dockerHost: "unix:///other.sock", dockerBinary: binary })).toThrow("executor_journal_binding_changed");
});

test("process cap counts both streams while legacy omitted cap preserves output", async () => {
  const script = "process.stdout.write('12345'); process.stderr.write('67890')";
  await expect(runProcess(process.execPath, ["-e", script], { timeoutMs: 1000, maxOutputBytes: 9 })).rejects.toThrow("executor_output_limit_exceeded");
  const legacy = await runProcess(process.execPath, ["-e", script], { timeoutMs: 1000 });
  expect(legacy.stdout).toBe("12345"); expect(legacy.stderr).toBe("67890"); expect(legacy.exitCode).toBe(0);
});

function sql(statement: string) { const db = new Database(join(directory, "jobs.sqlite")); try { db.exec(statement); } finally { db.close(); } }

test("renaming a recorded ID cannot masquerade as container absence", async () => {
  await ready(); mode({ rename: true });
  await expect(run()).rejects.toThrow("executor_job_cleanup_unverified");
  expect(rows()[0]!.state).toBe("cleanup_unknown"); expect(existsSync(containerPath)).toBe(true);
  expect(calls().some(c => c.args[1] === "rm")).toBe(false);
});

test.each(["insert", "id", "terminal"])("journal %s durability failure cannot yield success or another start", async stage => {
  await ready();
  const event = stage === "insert" ? "BEFORE INSERT" : "BEFORE UPDATE";
  const when = stage === "id" ? "WHEN NEW.container_id IS NOT NULL" : stage === "terminal" ? "WHEN NEW.terminal_ms IS NOT NULL" : "";
  sql(`CREATE TRIGGER injected_failure ${event} ON invocations ${when} BEGIN SELECT RAISE(ABORT,'injected durability failure'); END;`);
  await expect(run()).rejects.toThrow("injected durability failure");
  expect(existsSync(containerPath)).toBe(false);
  expect(calls().filter(c => c.args[0] === "start")).toHaveLength(stage === "terminal" ? 1 : 0);
  await expect(run()).rejects.toThrow("executor_journal_not_ready");
  sql("DROP TRIGGER injected_failure");
  journal!.close(); journal = open();
  // A failed ID transaction was nevertheless cleaned before its failed state
  // committed. A failed terminal transaction retains its exact ID for recovery.
  await reconcileDockerExecutorJobs(journal);
  if (stage === "terminal") expect(rows()[0]!.state).toBe("abandoned");
});

test("dead-owner pending state recovers conservatively without changing history or starting work", async () => {
  await ready(); await run();
  const completed = rows()[0]!;
  journal!.close();
  sql("UPDATE meta SET owner_pid=2147483647,owner_token='dead-owner'; UPDATE invocations SET state='pending',terminal_ms=NULL;");
  journal = open(); const before = calls().length;
  await reconcileDockerExecutorJobs(journal);
  expect(rows()[0]!.id).toBe(completed.id); expect(rows()[0]!.state).toBe("abandoned");
  expect(rows()[0]!.binding).toBe(completed.binding);
  expect(calls().slice(before).some(c => c.args[0] === "start" || c.args[0] === "create")).toBe(false);
});


test("a child directory named ..journal is still inside the writable mount", async () => {
  directory = join(workspace, "..journal");
  await ready();
  await expect(run()).rejects.toThrow("executor_journal_inside_workspace");
  expect(rows()).toHaveLength(0); expect(calls().some(c => c.args[0] === "create")).toBe(false);
});


test("guardian death aborts the attached CLI and awaited parent fallback cleans exact container", async () => {
  await ready(); mode({ hang: true });
  const pending = run();
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  while (!calls().some(c => c.args[0] === "start")) await Bun.sleep(5);
  const guardianPid = rows()[0]!.guardian_pid as number;
  expect(guardianPid).toBeGreaterThan(1); expect(guardianPid).not.toBe(process.pid);
  process.kill(guardianPid, "SIGKILL");
  const result = await outcome;
  expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined();
  expect(rows()[0]!.state).toBe("failed"); expect(existsSync(containerPath)).toBe(false);
  expect(calls().filter(c => c.args[1] === "rm")).toHaveLength(1);
  await expect(run()).rejects.toThrow("executor_journal_not_ready");
});

test("recovery never competes with a still-live persisted guardian", async () => {
  await ready(); await run(); journal!.close();
  sql(`UPDATE invocations SET state='pending',terminal_ms=NULL,guardian_pid=${process.pid};`);
  journal = open(); const before = calls().length;
  await expect(reconcileDockerExecutorJobs(journal)).rejects.toThrow("executor_job_guardian_alive");
  expect(calls().slice(before).some(c => c.args[1] === "rm" || c.args[0] === "create" || c.args[0] === "start")).toBe(false);
  expect(rows()[0]!.state).toBe("pending");
});
