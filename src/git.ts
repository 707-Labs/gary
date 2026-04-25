import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run git with explicit argv (no shell). Token URLs may appear in argv but
 * not in shell-interpolated strings, so we don't risk shell injection from
 * voice-generated input.
 */
export async function gitRun(
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolve) => {
    const child = spawn("git", [...args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + err.message, exitCode: -1 });
    });
  });
}

export async function gitMust(
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<GitResult> {
  const r = await gitRun(args, opts);
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`,
    );
  }
  return r;
}

export interface EnsureBareCloneArgs {
  owner: string;
  repo: string;
  reposDir: string;
  /**
   * Clone URL with a fresh installation token embedded. Used for the initial
   * clone and for subsequent fetches; we don't persist it in the bare repo's
   * remote config since installation tokens expire.
   */
  freshTokenUrl: string;
}

/**
 * Path to a bare clone for `<owner>/<repo>` under `reposDir`. Creates it on
 * first call; otherwise fetches the latest refs using the fresh token URL.
 */
export async function ensureBareClone(args: EnsureBareCloneArgs): Promise<string> {
  await mkdir(args.reposDir, { recursive: true });
  const bareDir = `${args.reposDir}/${args.repo}.git`;
  const cleanUrl = `https://github.com/${args.owner}/${args.repo}.git`;

  if (!existsSync(bareDir)) {
    await gitMust(["clone", "--bare", args.freshTokenUrl, bareDir]);
    await gitMust(["remote", "set-url", "origin", cleanUrl], { cwd: bareDir });
  } else {
    // Fetch latest from origin. We only refresh `main` because Gary's
    // active worktree branches live in `refs/heads/*` of this same bare
    // clone — fetching `+refs/heads/*:refs/heads/*` would refuse to update
    // any branch that's currently checked out in a worktree.
    await gitMust(
      [
        "fetch",
        args.freshTokenUrl,
        "+refs/heads/main:refs/heads/main",
      ],
      { cwd: bareDir },
    );
  }
  return bareDir;
}

export interface CreateWorktreeArgs {
  bareDir: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  authorName: string;
  authorEmail: string;
}

/**
 * Create a worktree off `baseBranch` with a new branch, scrubbing any prior
 * worktree at the same path. Configures git user.name / user.email for the
 * worktree so commits are attributed to Gary.
 */
export async function createWorktree(args: CreateWorktreeArgs): Promise<void> {
  if (existsSync(args.worktreePath)) {
    // Best-effort cleanup of any prior worktree state.
    await gitRun(["worktree", "remove", "--force", args.worktreePath], {
      cwd: args.bareDir,
    });
    await rm(args.worktreePath, { recursive: true, force: true });
  }
  await mkdir(dirname(args.worktreePath), { recursive: true });
  await gitMust(
    [
      "worktree",
      "add",
      "-B",
      args.branch,
      args.worktreePath,
      args.baseBranch,
    ],
    { cwd: args.bareDir },
  );
  await gitMust(["config", "user.name", args.authorName], {
    cwd: args.worktreePath,
  });
  await gitMust(["config", "user.email", args.authorEmail], {
    cwd: args.worktreePath,
  });
  await gitMust(["config", "commit.gpgsign", "false"], {
    cwd: args.worktreePath,
  });
}

export async function pushBranch(args: {
  worktreePath: string;
  freshTokenUrl: string;
  branch: string;
}): Promise<void> {
  await gitMust(
    ["push", args.freshTokenUrl, `${args.branch}:${args.branch}`, "--force-with-lease"],
    { cwd: args.worktreePath },
  );
}

export async function hasCommitsAhead(
  worktreePath: string,
  baseBranch: string,
): Promise<boolean> {
  const r = await gitRun(
    ["rev-list", "--count", `${baseBranch}..HEAD`],
    { cwd: worktreePath },
  );
  if (r.exitCode !== 0) return false;
  return Number(r.stdout.trim()) > 0;
}

export async function getHeadSha(worktreePath: string): Promise<string> {
  const r = await gitMust(["rev-parse", "HEAD"], { cwd: worktreePath });
  return r.stdout.trim();
}

export async function getDiff(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  const r = await gitMust(["diff", `${baseBranch}...HEAD`], {
    cwd: worktreePath,
  });
  return r.stdout;
}

export async function getCommitLog(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  const r = await gitMust(
    ["log", `${baseBranch}..HEAD`, "--pretty=format:%h %s"],
    { cwd: worktreePath },
  );
  return r.stdout;
}

/** Convert a free-form string to a kebab-case slug, max 40 chars. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}
