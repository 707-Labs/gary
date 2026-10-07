import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeadlineExceededError } from "../src/deadline.ts";
import {
  createWorktree,
  ensureBareClone,
  getCommitLog,
  getDiff,
  getHeadSha,
  gitMust,
  gitRun,
  hasCommitsAhead,
  pushBranch,
  rebaseOntoFreshBase,
  withBareLock,
} from "../src/git.ts";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + 1_500;
  while (!check()) {
    if (Date.now() >= until) throw new Error("timed out waiting for fake git");
    await Bun.sleep(10);
  }
}

describe("git deadlines", () => {
  let root: string;
  let env: Record<string, string>;
  let pidsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gary-git-deadline-"));
    pidsPath = join(root, "pids");
    env = { PATH: `${root}:${process.env.PATH ?? ""}`, GARY_TEST_PIDS: pidsPath };
  });

  afterEach(() => {
    if (existsSync(pidsPath)) {
      for (const pid of readFileSync(pidsPath, "utf8").trim().split(/\s+/).map(Number)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  function fakeGit(script: string): void {
    writeFileSync(join(root, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  it("does not spawn an expired command", async () => {
    fakeGit('printf "%s" "$$" > "$GARY_TEST_PIDS"');
    await expect(gitRun(["status"], { env, deadlineMs: Date.now() - 1 }))
      .rejects.toBeInstanceOf(DeadlineExceededError);
    expect(existsSync(pidsPath)).toBe(false);
  });

  it("rejects a deadline and kills git plus its helper before returning", async () => {
    // Both processes ignore TERM, exercising the bounded KILL fallback.
    fakeGit('trap "" TERM\nsleep 30 &\nprintf "%s %s" "$$" "$!" > "$GARY_TEST_PIDS"\nwait');
    const started = Date.now();
    const result = gitRun(["fetch"], { env, deadlineMs: started + 1_200 });
    await expect(result).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(Date.now() - started).toBeLessThan(2_500);
    const pids = readFileSync(pidsPath, "utf8").split(/\s+/).map(Number);
    await waitFor(() => pids.every((pid) => !isRunning(pid)));
  });

  it("propagates caller aborts and retains the lock until process cleanup", async () => {
    fakeGit('trap "" TERM\nprintf "%s" "$$" > "$GARY_TEST_PIDS"\nwhile :; do :; done');
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const active = withBareLock(root, () => gitMust(["fetch"], { env, signal: controller.signal }), {
      signal: controller.signal,
    });
    await waitFor(() => existsSync(pidsPath));
    const pid = Number(readFileSync(pidsPath, "utf8"));
    const next = withBareLock(root, async () => isRunning(pid));
    controller.abort(reason);
    await expect(active).rejects.toBe(reason);
    expect(await next).toBe(false);
  });

  it("expires queue waits promptly without letting later work bypass the active lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const active = withBareLock(root, async () => {
      order.push("active");
      await gate;
      order.push("released");
    });
    const expired = withBareLock(root, async () => { order.push("expired"); }, {
      deadlineMs: Date.now() + 30,
    });
    const next = withBareLock(root, async () => { order.push("next"); });
    try {
      await expect(expired).rejects.toBeInstanceOf(DeadlineExceededError);
      expect(order).toEqual(["active"]);
    } finally {
      release();
      await Promise.all([active, next]);
    }
    expect(order).toEqual(["active", "released", "next"]);
  });

  it("passes expired deadlines through every code-handler helper before mutations", async () => {
    const opts = { deadlineMs: Date.now() - 1 };
    const worktreePath = join(root, "worktree");
    const reposDir = join(root, "repos");
    mkdirSync(worktreePath);
    writeFileSync(join(worktreePath, "keep"), "existing work");
    const args = {
      ...opts,
      owner: "offline",
      repo: "repo",
      reposDir,
      bareDir: join(reposDir, "repo.git"),
      worktreePath,
      branch: "feature",
      baseBranch: "main",
      authorName: "test",
      authorEmail: "test@example.invalid",
      freshTokenUrl: join(root, "origin"),
    };
    const actions = [
      () => ensureBareClone(args),
      () => createWorktree(args),
      () => rebaseOntoFreshBase(args),
      () => pushBranch(args),
      () => hasCommitsAhead(worktreePath, "main", opts),
      () => getDiff(worktreePath, "main", opts),
      () => getCommitLog(worktreePath, "main", opts),
      () => getHeadSha(worktreePath, opts),
    ];
    for (const action of actions) {
      await expect(action()).rejects.toBeInstanceOf(DeadlineExceededError);
    }
    expect(existsSync(reposDir)).toBe(false);
    expect(readFileSync(join(worktreePath, "keep"), "utf8")).toBe("existing work");
  });
});
