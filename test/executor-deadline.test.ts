import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeadline, DeadlineExceededError } from "../src/deadline.ts";
import { bindExecutorDeadline } from "../src/executors/index.ts";
import { LocalExecutor } from "../src/executors/local.ts";
import { DockerExecutor } from "../src/executors/docker.ts";

describe("executor deadline cancellation (offline)", () => {
  let workspace: string;
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "gary-deadline-")); });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

  it("kills shell descendants before returning and prevents their delayed write", async () => {
    const exec = new LocalExecutor(workspace);
    const start = Date.now();
    const result = await exec.run("(sleep 0.3; echo escaped > late.txt) & wait", { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(existsSync(join(workspace, "late.txt"))).toBe(false);
  });

  it("clamps an oversized command timeout to the shared deadline", async () => {
    const budget = createDeadline({ timeoutMs: 50 });
    const exec = bindExecutorDeadline(new LocalExecutor(workspace), budget);
    try {
      await expect(exec.run("sleep 5", { timeoutMs: 60_000 })).rejects.toBeInstanceOf(DeadlineExceededError);
    } finally { budget.dispose(); }
  });

  it("honors an explicit external abort and starts no later command", async () => {
    const controller = new AbortController();
    const exec = bindExecutorDeadline(new LocalExecutor(workspace), { signal: controller.signal });
    const pending = exec.run("sleep 5");
    controller.abort(new Error("cancelled by owner"));
    await expect(pending).rejects.toThrow("cancelled by owner");
    await expect(exec.run("echo late > late.txt")).rejects.toThrow("cancelled by owner");
    expect(existsSync(join(workspace, "late.txt"))).toBe(false);
  });

  it("waits for named Docker removal after cancellation, using a fake CLI", async () => {
    const binary = join(workspace, "fake-docker");
    writeFileSync(binary, `#!/bin/bash
if [ "$1" = "run" ]; then
  echo "$3" > "${workspace}/container-name"
  sleep 5
elif [ "$1" = "rm" ]; then
  sleep 0.02
  echo "$3" > "${workspace}/removed"
fi
`, { mode: 0o755 });
    const exec = new DockerExecutor(workspace, { image: "fake", dockerBinary: binary });
    const controller = new AbortController();
    const pending = exec.run("unused", { timeoutMs: 2_000, signal: controller.signal });
    const readinessDeadline = Date.now() + 1_000;
    while (!existsSync(join(workspace, "container-name")) && Date.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(readFileSync(join(workspace, "removed"), "utf8")).toBe(readFileSync(join(workspace, "container-name"), "utf8"));
  });

  it("cancels Docker-backed read_file and waits for cleanup, using a fake CLI", async () => {
    const binary = join(workspace, "fake-docker");
    writeFileSync(binary, `#!/bin/bash
if [ "$1" = "run" ]; then
  sleep 5
elif [ "$1" = "rm" ]; then
  touch "${workspace}/removed"
fi
`, { mode: 0o755 });
    const budget = createDeadline({ timeoutMs: 100 });
    const exec = bindExecutorDeadline(new DockerExecutor(workspace, { image: "fake", dockerBinary: binary }), budget);
    try {
      await expect(exec.readFile("file")).rejects.toBeInstanceOf(DeadlineExceededError);
      expect(existsSync(join(workspace, "removed"))).toBe(true);
    } finally { budget.dispose(); }
  });
});
