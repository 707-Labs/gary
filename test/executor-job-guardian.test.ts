import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armExecutorJobGuardian, type ExecutorJobGuardian, type ExecutorJobGuardianBinding } from "../src/executors/job-guardian.ts";

let root: string, directory: string, database: Database, binding: ExecutorJobGuardianBinding;
let modePath: string, containerPath: string, callsPath: string;
let guardian: ExecutorJobGuardian | undefined;
const containerId = "a".repeat(64);
function mode(value: object) { writeFileSync(modePath, JSON.stringify(value)); }
function calls(): Array<{ args: string[]; secret: string | null }> {
  return readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("fixture_wait_timeout"); await Bun.sleep(10); }
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function container() {
  return { Id: containerId, Name: `/${binding.containerName}`,
    Config: { Labels: { "dev.gary.executor-job": binding.invocationId, "dev.gary.executor-journal": binding.journalId } } };
}
async function armAndBind() {
  guardian = await armExecutorJobGuardian(binding);
  database.query("UPDATE invocations SET guardian_pid=?,container_id=? WHERE id=?").run(guardian.pid, containerId, binding.invocationId);
  writeFileSync(containerPath, JSON.stringify(container()));
  await guardian.bind(containerId);
  return guardian;
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "gary-guardian-test-")));
  directory = join(root, "journal"); mkdirSync(directory, { mode: 0o700 });
  const dockerConfig = join(directory, "docker-config"); mkdirSync(dockerConfig, { mode: 0o700 });
  const binary = join(root, "docker-fake");
  modePath = join(root, "mode.json"); containerPath = join(root, "container.json"); callsPath = join(root, "calls.jsonl");
  mode({}); writeFileSync(callsPath, "");
  writeFileSync(binary, `#!${process.execPath}
import {appendFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
const raw=process.argv.slice(2), args=raw.slice(4);
const mode=JSON.parse(readFileSync(${JSON.stringify(modePath)},'utf8'));
const path=${JSON.stringify(containerPath)};
appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,secret:process.env.GARY_GUARDIAN_TEST_SECRET??null})+'\\n');
if(mode.hang){setInterval(()=>{},1000);}
else if(args[0]==='info'){console.log(mode.daemon??'fake-daemon-12345678');}
else if(args[0]==='container'&&args[1]==='ls'){
  if(mode.listFail)process.exit(1);
  if(existsSync(path)){
    const item=JSON.parse(readFileSync(path,'utf8'));const filter=args.at(-1);
    if(filter==='id='+item.Id||filter==='name=^'+item.Name+'$')console.log(item.Id);
  }
} else if(args[0]==='container'&&args[1]==='inspect'){
  if(!existsSync(path))process.exit(1);
  const item=JSON.parse(readFileSync(path,'utf8'));
  if(mode.foreign)item.Config.Labels['dev.gary.executor-job']='foreign';
  console.log(JSON.stringify(item));
} else if(args[0]==='container'&&args[1]==='rm'){
  if(mode.rmFail)process.exit(1);
  if(existsSync(path))rmSync(path);
} else process.exit(99);
`, { mode: 0o755 });
  const databasePath = join(directory, "jobs.sqlite");
  database = new Database(databasePath, { strict: true }); chmodSync(databasePath, 0o600);
  database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE meta(singleton INTEGER PRIMARY KEY,id TEXT,daemon_id TEXT,owner_pid INTEGER,owner_token TEXT,docker_host TEXT,docker_binary TEXT);
    CREATE TABLE invocations(id TEXT PRIMARY KEY,name TEXT,binding TEXT,deadline_ms INTEGER,container_id TEXT,guardian_pid INTEGER);`);
  const journalId = randomUUID(), invocationId = randomUUID();
  binding = { directory, dockerConfig, databasePath, dockerBinary: binary, dockerHost: "unix:///fake/docker.sock",
    journalId, invocationId, containerName: `gary-longjob-${invocationId}`, deadlineMs: Date.now() + 6000,
    expectedBinding: JSON.stringify({ actionId: "action", ownerEpoch: "epoch" }), ownerToken: randomUUID(), ownerPid: process.pid };
  database.query("INSERT INTO meta VALUES(1,?,'fake-daemon-12345678',?,?,?,?)").run(journalId, process.pid, binding.ownerToken, binding.dockerHost, binary);
  database.query("INSERT INTO invocations VALUES(?,?,?,?,NULL,NULL)").run(invocationId, binding.containerName, binding.expectedBinding, binding.deadlineMs);
});
afterEach(async () => {
  try { await guardian?.complete(); } catch { /* Failure is the expected terminal result in adversarial fixtures. */ }
  guardian = undefined;
  database.close(); rmSync(root, { recursive: true, force: true });
});

test("armed and durably bound handshakes precede isolated cleanup and successful receipt", async () => {
  const previous = process.env.GARY_GUARDIAN_TEST_SECRET; process.env.GARY_GUARDIAN_TEST_SECRET = "never-inherit";
  try {
    guardian = await armExecutorJobGuardian(binding);
    expect(calls().map(c => c.args[0])).toEqual(["info"]);
    expect(existsSync(containerPath)).toBe(false);
    database.query("UPDATE invocations SET guardian_pid=?,container_id=?").run(guardian.pid, containerId);
    writeFileSync(containerPath, JSON.stringify(container()));
    await guardian.bind(containerId);
    expect(calls().some(c => c.args[1] === "inspect")).toBe(true);
    const result = await guardian.complete();
    expect(result).toEqual({ journalId: binding.journalId, invocationId: binding.invocationId, containerId, absenceVerified: true });
    expect(alive(guardian.pid)).toBe(false); expect(existsSync(containerPath)).toBe(false);
    expect(calls().every(c => c.secret === null)).toBe(true);
    expect(calls().filter(c => c.args[1] === "rm").map(c => c.args.at(-1))).toEqual([containerId]);
    expect(JSON.parse(readFileSync(join(directory, `guardian-${binding.invocationId}.json`), "utf8")).absenceVerified).toBe(true);
  } finally { if (previous === undefined) delete process.env.GARY_GUARDIAN_TEST_SECRET; else process.env.GARY_GUARDIAN_TEST_SECRET = previous; }
});

test("poisoned parent cwd dotenv is not loaded by the guardian or its Docker CLI", async () => {
  const previous = process.cwd();
  const poison = join(root, "poisoned-parent"); mkdirSync(poison);
  writeFileSync(join(poison, ".env"), "GARY_GUARDIAN_TEST_SECRET=must-not-be-loaded\n");
  process.chdir(poison);
  try {
    // The child rejects every environment key except the explicit PATH/HOME pair.
    guardian = await armAndBind();
    await guardian.complete();
    expect(calls().every(call => call.secret === null)).toBe(true);
  } finally { process.chdir(previous); }
});

test("bind refuses an ID that is not durable, then drains and removes only the observed owned container", async () => {
  guardian = await armExecutorJobGuardian(binding);
  database.query("UPDATE invocations SET guardian_pid=?").run(guardian.pid);
  writeFileSync(containerPath, JSON.stringify(container()));
  await expect(guardian.bind(containerId)).rejects.toThrow();
  await expect(guardian.complete()).rejects.toThrow();
  expect(alive(guardian.pid)).toBe(false); expect(existsSync(containerPath)).toBe(false);
});

test("lost create response is removable but absent unbound creation remains unresolved", async () => {
  guardian = await armExecutorJobGuardian(binding);
  database.query("UPDATE invocations SET guardian_pid=?").run(guardian.pid);
  writeFileSync(containerPath, JSON.stringify(container()));
  expect((await guardian.complete()).containerId).toBe(containerId);
  guardian = undefined;
  guardian = await armExecutorJobGuardian(binding);
  await expect(guardian.complete()).rejects.toThrow();
  expect(alive(guardian.pid)).toBe(false);
  expect(JSON.parse(readFileSync(join(directory, `guardian-${binding.invocationId}.json`), "utf8")).absenceVerified).toBe(false);
});

test("original absolute deadline stops a bound job without any parent completion request", async () => {
  binding.deadlineMs = Date.now() + 1000;
  database.query("UPDATE invocations SET deadline_ms=?").run(binding.deadlineMs);
  guardian = await armAndBind();
  await until(() => guardian!.signal.aborted);
  await guardian.complete().catch(() => {});
  expect(existsSync(containerPath)).toBe(false); expect(alive(guardian.pid)).toBe(false);
  expect(Date.now()).toBeLessThan(binding.deadlineMs + 1500);
});

test.each(["foreign", "rmFail", "listFail", "daemon"])("%s uncertainty never yields a successful cleanup receipt", async failure => {
  guardian = await armAndBind();
  mode(failure === "daemon" ? { daemon: "different-daemon-123" } : { [failure]: true });
  await expect(guardian.complete()).rejects.toThrow();
  expect(alive(guardian.pid)).toBe(false); expect(existsSync(containerPath)).toBe(true);
  if (failure === "foreign" || failure === "daemon") expect(calls().some(c => c.args[1] === "rm")).toBe(false);
});

test.each(["binding", "deadline_ms", "container_id"])("journal %s drift fails closed without removing an unverified target", async column => {
  guardian = await armAndBind();
  database.query(`UPDATE invocations SET ${column}=?`).run(column === "deadline_ms" ? binding.deadlineMs + 1 : "changed");
  await expect(guardian.complete()).rejects.toThrow();
  expect(existsSync(containerPath)).toBe(true); expect(calls().some(c => c.args[1] === "rm")).toBe(false);
});

test("guardian SIGKILL aborts parent and complete rejects only after child exit", async () => {
  guardian = await armAndBind();
  process.kill(guardian.pid, "SIGKILL");
  await until(() => guardian!.signal.aborted);
  await expect(guardian.complete()).rejects.toThrow();
  expect(alive(guardian.pid)).toBe(false); expect(existsSync(containerPath)).toBe(true);
});

test("renamed immutable container is found by ID and never removed under a foreign name", async () => {
  guardian = await armAndBind();
  writeFileSync(containerPath, JSON.stringify({ ...container(), Name: "/foreign-name" }));
  await expect(guardian.complete()).rejects.toThrow();
  expect(existsSync(containerPath)).toBe(true); expect(calls().some(c => c.args[1] === "rm")).toBe(false);
});

test("parent SIGKILL leaves detached guardian alive long enough to remove the bound container", async () => {
  const manifestPath = join(root, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(binding));
  const readyPath = join(root, "parent-ready.json");
  const helper = join(root, "parent.ts");
  const module = new URL("../src/executors/job-guardian.ts", import.meta.url).pathname;
  writeFileSync(helper, `import {Database} from 'bun:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {armExecutorJobGuardian} from ${JSON.stringify(module)};
const binding=JSON.parse(readFileSync(${JSON.stringify(manifestPath)},'utf8'));binding.ownerPid=process.pid;
const db=new Database(binding.databasePath);db.query('UPDATE meta SET owner_pid=?').run(process.pid);
const guardian=await armExecutorJobGuardian(binding);
db.query('UPDATE invocations SET guardian_pid=?,container_id=?').run(guardian.pid,${JSON.stringify(containerId)});
writeFileSync(${JSON.stringify(containerPath)},${JSON.stringify(JSON.stringify(container()))});
await guardian.bind(${JSON.stringify(containerId)});
writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({pid:guardian.pid}));
setInterval(()=>{},1000);
`);
  const parent = spawn(process.execPath, [helper], { stdio: "ignore", detached: true });
  try {
    await until(() => existsSync(readyPath));
    const { pid } = JSON.parse(readFileSync(readyPath, "utf8"));
    expect(alive(pid)).toBe(true);
    parent.kill("SIGKILL");
    const receiptPath = join(directory, `guardian-${binding.invocationId}.json`);
    await until(() => existsSync(receiptPath));
    expect(existsSync(containerPath)).toBe(false);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ containerId, absenceVerified: true });
    await until(() => !alive(pid));
  } finally { parent.kill("SIGKILL"); }
});
