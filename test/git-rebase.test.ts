import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitMust, gitRun, rebaseOntoFreshBase } from "../src/git.ts";

async function init(dir: string, bare = false) {
  // -b main: the tests assume a `main` default branch; machines without
  // init.defaultBranch configured would otherwise create `master`.
  await gitMust(
    bare ? ["init", "-b", "main", "--bare", dir] : ["init", "-b", "main", dir],
  );
  if (!bare) {
    await gitMust(["config", "user.email", "t@t"], { cwd: dir });
    await gitMust(["config", "user.name", "t"], { cwd: dir });
    await gitMust(["config", "commit.gpgsign", "false"], { cwd: dir });
  }
}
async function commit(dir: string, file: string, contents: string, msg: string) {
  writeFileSync(join(dir, file), contents);
  await gitMust(["add", file], { cwd: dir });
  await gitMust(["commit", "-m", msg], { cwd: dir });
}

describe("rebaseOntoFreshBase", () => {
  let root: string;
  let origin: string; // simulated remote (non-bare so we can commit to it)
  let local: string; // gary's bare clone
  let worktree: string; // gary's worktree off a feature branch
  let baseSha: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "gary-rebase-"));
    origin = join(root, "origin");
    local = join(root, "local.git");
    worktree = join(root, "wt");

    await init(origin);
    await commit(origin, "a.txt", "v1\n", "init");
    baseSha = (await gitMust(["rev-parse", "HEAD"], { cwd: origin })).stdout.trim();

    // Bare clone of origin, then worktree off main with one feature commit.
    await gitMust(["clone", "--bare", origin, local]);
    await gitMust(
      ["worktree", "add", "-B", "feat", worktree, "main"],
      { cwd: local },
    );
    await gitMust(["config", "user.email", "g@g"], { cwd: worktree });
    await gitMust(["config", "user.name", "g"], { cwd: worktree });
    await gitMust(["config", "commit.gpgsign", "false"], { cwd: worktree });
    await commit(worktree, "feat.txt", "feature\n", "feat: add feat.txt");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns no_op when main hasn't moved", async () => {
    const r = await rebaseOntoFreshBase({
      bareDir: local,
      worktreePath: worktree,
      freshTokenUrl: origin,
      baseBranch: "main",
    });
    expect(r.kind).toBe("no_op");
    // Worktree's HEAD is still the feature commit, not the base.
    const head = (await gitMust(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
    expect(head).not.toBe(baseSha);
  });

  it("rebases cleanly when main has advanced with non-conflicting changes", async () => {
    await commit(origin, "b.txt", "v1\n", "main: add b.txt");

    const preFeat = (await gitMust(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
    const r = await rebaseOntoFreshBase({
      bareDir: local,
      worktreePath: worktree,
      freshTokenUrl: origin,
      baseBranch: "main",
    });
    expect(r.kind).toBe("clean");
    if (r.kind !== "clean") return;
    expect(r.preRebaseSha).toBe(preFeat);
    expect(r.postRebaseSha).not.toBe(preFeat);

    // Both files exist on the rebased branch.
    const files = (await gitMust(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: worktree })).stdout.trim().split("\n");
    expect(files).toContain("a.txt");
    expect(files).toContain("b.txt");
    expect(files).toContain("feat.txt");
  });

  it("returns conflict and aborts cleanly when rebase conflicts", async () => {
    // Feature branch already touches feat.txt. Make main also touch feat.txt
    // with incompatible content.
    writeFileSync(join(origin, "feat.txt"), "main-version\n");
    await gitMust(["add", "feat.txt"], { cwd: origin });
    await gitMust(["commit", "-m", "main: feat.txt collision"], { cwd: origin });

    // Edit the feature branch's feat.txt to a different value than its
    // initial commit so the rebase sees a real content collision.
    await commit(worktree, "feat.txt", "feature-version\n", "feat: change feat.txt");
    const preFeat = (await gitMust(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();

    const r = await rebaseOntoFreshBase({
      bareDir: local,
      worktreePath: worktree,
      freshTokenUrl: origin,
      baseBranch: "main",
    });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") return;
    expect(r.preRebaseSha).toBe(preFeat);

    // Worktree HEAD is still where it was; rebase was aborted, no half-state.
    const head = (await gitMust(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
    expect(head).toBe(preFeat);

    // No in-progress rebase artifacts.
    const status = await gitRun(["status", "--porcelain=v1"], { cwd: worktree });
    expect(status.exitCode).toBe(0);
    const inProgress = await gitRun(["rev-parse", "--git-path", "rebase-merge"], { cwd: worktree });
    // The path is reported either way; what matters is that it doesn't exist.
    const path = inProgress.stdout.trim();
    const fs = await import("node:fs");
    expect(fs.existsSync(path)).toBe(false);
  });
});
