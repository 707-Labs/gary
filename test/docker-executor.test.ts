import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDeadline } from "../src/deadline.ts";
import { bindExecutorDeadline, type ExecResult, type Executor } from "../src/executors/index.ts";
import { DockerExecutor } from "../src/executors/docker.ts";
import { runProcess } from "../src/executors/process.ts";
import { WorkspaceBoundaryError } from "../src/executors/local.ts";

const image = process.env.GARY_DOCKER_TEST_IMAGE;
const dockerIt = image ? it : it.skip;
// Leaves room inside Bun's 30-second test timeout for bounded container cleanup.
const TEST_DEADLINE_MS = 20_000;

function expectCommandSucceeded(result: ExecResult): void {
  if (result.exitCode !== 0) throw new Error(`container command failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
}

function expectWriteDenied(result: ExecResult): void {
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/(?:read-only file system|permission denied)/i);
}

async function expectStarted(executor: Executor): Promise<void> {
  const result = await executor.run("printf 'gary-container-ready\\n'");
  expectCommandSucceeded(result);
  expect(result.stdout.trim()).toBe("gary-container-ready");
}

describe("DockerExecutor integration", () => {
  let workspace = "";

  beforeAll(async () => {
    if (!image) return;
    const workspaces = process.env.GARY_WORKSPACES_DIR ?? join(homedir(), ".gary/workspaces");
    workspace = await mkdtemp(join(workspaces, ".gary-docker-executor-"));
    await writeFile(join(workspace, "hello.txt"), "hello sandbox\n");
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  dockerIt("reads, writes, searches, and runs without host credentials", async () => {
    const budget = createDeadline({ timeoutMs: TEST_DEADLINE_MS });
    const originalSentinel = process.env.GARY_SENTINEL_SECRET;
    process.env.GARY_SENTINEL_SECRET = "must-not-cross";
    try {
      const executor = bindExecutorDeadline(new DockerExecutor(workspace, { image: image! }), budget);
      await expectStarted(executor);
      expect(await executor.readFile("hello.txt")).toBe("hello sandbox\n");
      await executor.writeFile("src/new.ts", "export const value = 42;\n");
      expect(await executor.listFiles("**/*.ts")).toEqual(["src/new.ts"]);
      expect(await executor.grep("value", "**/*.ts")).toEqual([
        { path: "src/new.ts", line: 1, text: "export const value = 42;" },
      ]);
      const result = await executor.run(
        'set -e; id -u; test "$(id -u)" != 0; test -z "${GARY_SENTINEL_SECRET:-}"; test ! -S /var/run/docker.sock',
      );
      expectCommandSucceeded(result);
      expect(result.stdout.trim()).toMatch(/^[1-9][0-9]*$/);
    } finally {
      budget.dispose();
      if (originalSentinel === undefined) delete process.env.GARY_SENTINEL_SECRET;
      else process.env.GARY_SENTINEL_SECRET = originalSentinel;
    }
  }, 30_000);

  dockerIt("has no network and cannot write outside the mounted worktree", async () => {
    const budget = createDeadline({ timeoutMs: TEST_DEADLINE_MS });
    try {
      const executor = bindExecutorDeadline(new DockerExecutor(workspace, { image: image! }), budget);
      await expectStarted(executor);
      const network = await executor.run(`set -e
python3 - <<'PY'
from pathlib import Path
interfaces = sorted(p.name for p in Path('/sys/class/net').iterdir())
assert interfaces == ['lo'], f'unexpected interfaces: {interfaces}'
routes = Path('/proc/net/route').read_text().splitlines()
assert routes and routes[0].split()[0] == 'Iface', 'missing route table header'
assert all(line.split()[0] == 'lo' for line in routes[1:] if line.strip()), 'non-loopback route present'
print('loopback-only; no non-loopback IPv4 routes')
PY`);
      expectCommandSucceeded(network);
      expect(network.stdout.trim()).toBe("loopback-only; no non-loopback IPv4 routes");
      const rootWrite = await executor.run("LC_ALL=C touch /root/escape");
      expectWriteDenied(rootWrite);
      await expect(executor.readFile("../escape")).rejects.toThrow(WorkspaceBoundaryError);
    } finally {
      budget.dispose();
    }
  }, 30_000);

  dockerIt("runs Node-shebang test tools through Bun's script launcher", async () => {
    const budget = createDeadline({ timeoutMs: TEST_DEADLINE_MS });
    try {
      const executor = bindExecutorDeadline(new DockerExecutor(workspace, { image: image! }), budget);
      await executor.writeFile("runtime-probe/package.json", JSON.stringify({ scripts: { probe: "runtime-probe" } }));
      await executor.writeFile("runtime-probe/node_modules/.bin/runtime-probe", `#!/usr/bin/env node
console.log(JSON.stringify({ node: process.versions.node, bun: process.versions.bun ?? null }));
`);
      const result = await executor.run("chmod +x node_modules/.bin/runtime-probe && bun run probe", { cwd: "runtime-probe" });
      expectCommandSucceeded(result);
      expect(JSON.parse(result.stdout.trim())).toEqual({ node: "24.21.0", bun: null });
    } finally {
      budget.dispose();
    }
  }, 30_000);

  dockerIt("enforces read-only worktree mounts", async () => {
    const budget = createDeadline({ timeoutMs: TEST_DEADLINE_MS });
    try {
      const executor = bindExecutorDeadline(new DockerExecutor(workspace, { image: image!, readOnly: true }), budget);
      await expectStarted(executor);
      expect(await executor.readFile("hello.txt")).toBe("hello sandbox\n");
      await expect(executor.writeFile("blocked.txt", "nope")).rejects.toThrow(/read-only/i);
      const shellWrite = await executor.run("LC_ALL=C touch blocked.txt");
      expectWriteDenied(shellWrite);
      expect(shellWrite.stderr).toMatch(/read-only file system/i);
    } finally {
      budget.dispose();
    }
  }, 30_000);

  dockerIt("removes a running container before returning from timeout", async () => {
    const executor = new DockerExecutor(workspace, { image: image! });
    const result = await executor.run("printf 'gary-cancellation-ready\\n'; sleep 30", { timeoutMs: 3_000 });
    expect(result.stdout).toContain("gary-cancellation-ready");
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).not.toContain("container cleanup failed");
    const remaining = await runProcess("docker", ["ps", "-a", "--filter", `name=gary-exec-${process.pid}-`, "--format", "{{.Names}}"], { timeoutMs: 5_000 });
    expectCommandSucceeded(remaining);
    expect(remaining.stdout.trim()).toBe("");
  }, 15_000);
});
