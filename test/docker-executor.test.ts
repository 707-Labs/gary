import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DockerExecutor } from "../src/executors/docker.ts";
import { WorkspaceBoundaryError } from "../src/executors/local.ts";

const image = process.env.GARY_DOCKER_TEST_IMAGE;
const dockerIt = image ? it : it.skip;

describe("DockerExecutor integration", () => {
  let workspace = "";

  beforeAll(async () => {
    const workspaces = process.env.GARY_WORKSPACES_DIR ?? join(homedir(), ".gary/workspaces");
    workspace = await mkdtemp(join(workspaces, ".gary-docker-executor-"));
    await writeFile(join(workspace, "hello.txt"), "hello sandbox\n");
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  dockerIt("reads, writes, searches, and runs without host credentials", async () => {
    process.env.GARY_SENTINEL_SECRET = "must-not-cross";
    const executor = new DockerExecutor(workspace, { image: image! });
    expect(await executor.readFile("hello.txt")).toBe("hello sandbox\n");
    await executor.writeFile("src/new.ts", "export const value = 42;\n");
    expect(await executor.listFiles("**/*.ts")).toEqual(["src/new.ts"]);
    expect(await executor.grep("value", "**/*.ts")).toEqual([
      { path: "src/new.ts", line: 1, text: "export const value = 42;" },
    ]);
    const result = await executor.run(
      'id -u; test "$(id -u)" != 0; test -z "${GARY_SENTINEL_SECRET:-}"; test ! -S /var/run/docker.sock',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).not.toBe("0");
    delete process.env.GARY_SENTINEL_SECRET;
  }, 30_000);

  dockerIt("has no network and cannot write outside the mounted worktree", async () => {
    const executor = new DockerExecutor(workspace, { image: image! });
    const network = await executor.run("curl -fsS --max-time 2 https://example.com");
    expect(network.exitCode).not.toBe(0);
    const rootWrite = await executor.run("touch /root/escape");
    expect(rootWrite.exitCode).not.toBe(0);
    expect(() => executor.readFile("../escape")).toThrow(WorkspaceBoundaryError);
  }, 30_000);

  dockerIt("enforces read-only worktree mounts", async () => {
    const executor = new DockerExecutor(workspace, { image: image!, readOnly: true });
    await expect(executor.writeFile("blocked.txt", "nope")).rejects.toThrow(/read-only/i);
    const shellWrite = await executor.run("touch blocked.txt");
    expect(shellWrite.exitCode).not.toBe(0);
  }, 30_000);
});
