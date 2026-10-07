import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { redactGitHubTokens } from "./redact.ts";
import { createDeadline, throwIfExpired, type DeadlineOptions } from "./deadline.ts";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Per-bare-repo serializer. Concurrent `git fetch` or `git worktree add`
 * calls against the same bare repo race on internal locks (refs, HEAD,
 * worktree metadata) — git emits "another git process is running" or
 * silently corrupts state. The loop now dispatches multiple handlers
 * concurrently, each of which prepares a worktree off the same bare clone,
 * so we serialize bare-repo writes per path.
 *
 * Worktree-local operations (commits, push from the worktree) don't touch
 * the bare repo's lock-protected files and don't go through here.
 */
const bareRepoLocks = new Map<string, Promise<unknown>>();

export async function withBareLock<T>(
  bareDir: string,
  fn: () => Promise<T>,
  opts: DeadlineOptions = {},
): Promise<T> {
  const deadline = createDeadline(opts);
  try {
    deadline.throwIfExpired();
    const prev = bareRepoLocks.get(bareDir);
    // Keep an expired queue entry behind its predecessor. Removing it early
    // would let a later caller overlap a still-running bare-repo mutation.
    const ready = prev ? prev.catch(() => undefined) : Promise.resolve();
    let started = false;
    const next = ready.then(() => {
      deadline.throwIfExpired();
      started = true;
      return fn();
    });
    bareRepoLocks.set(bareDir, next);
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        // Running work owns its cleanup; retain the lock until it settles.
        if (!started) reject(deadline.signal.reason);
      };
      deadline.signal.addEventListener("abort", onAbort, { once: true });
      next.then(
        (value) => {
          deadline.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          deadline.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
      if (deadline.signal.aborted) onAbort();
    });
  } finally {
    deadline.dispose();
  }
}

export interface GitRunOptions extends DeadlineOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Run git with explicit argv (no shell). Token URLs may appear in argv but
 * not in shell-interpolated strings, so we don't risk shell injection from
 * voice-generated input.
 */
export async function gitRun(
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  const deadline = createDeadline(opts);
  try {
    deadline.throwIfExpired();
    return await new Promise<GitResult>((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        // Git may start ssh, credential helpers, or hooks. A separate process
        // group lets cancellation terminate those children along with git.
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let aborted = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The process may already have exited between abort and close.
        }
      };
      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 250);
      };
      deadline.signal.addEventListener("abort", onAbort, { once: true });
      if (deadline.signal.aborted) onAbort();
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        deadline.signal.removeEventListener("abort", onAbort);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (aborted) {
          // A helper may have closed its inherited pipes before git exited.
          // Reap the rest of the process group before releasing the caller.
          kill("SIGKILL");
          reject(deadline.signal.reason);
        } else {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        }
      });
      child.on("error", (err) => {
        // Spawn failures also emit close. Settle there so cancellation never
        // releases the bare-repo lock while a process is still shutting down.
        stderr += err.message;
      });
    });
  } finally {
    deadline.dispose();
  }
}

export async function gitMust(
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  const r = await gitRun(args, opts);
  if (r.exitCode !== 0) {
    // Redact token URLs from both argv (we pass them on the command line)
    // and git's own stderr (it sometimes echoes the URL on push errors).
    const cmd = redactGitHubTokens(args.join(" "));
    const out = redactGitHubTokens(r.stderr || r.stdout);
    throw new Error(`git ${cmd} failed (exit ${r.exitCode}): ${out}`);
  }
  return r;
}

export interface EnsureBareCloneArgs extends DeadlineOptions {
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
  throwIfExpired(args);
  await mkdir(args.reposDir, { recursive: true });
  const bareDir = `${args.reposDir}/${args.repo}.git`;
  const cleanUrl = `https://github.com/${args.owner}/${args.repo}.git`;

  return await withBareLock(bareDir, async () => {
    if (!existsSync(bareDir)) {
      await gitMust(["clone", "--bare", args.freshTokenUrl, bareDir], args);
      await gitMust(["remote", "set-url", "origin", cleanUrl], { ...args, cwd: bareDir });
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
        { ...args, cwd: bareDir },
      );
    }
    return bareDir;
  }, args);
}

export interface CreateWorktreeArgs extends DeadlineOptions {
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
  // Lock the bare repo for the duration: `worktree add` mutates the bare
  // repo's worktree metadata and refs. `worktree remove` does the same.
  // Per-worktree config (user.name/user.email) is local to the worktree
  // path so we leave it outside the lock.
  await withBareLock(args.bareDir, async () => {
    if (existsSync(args.worktreePath)) {
      // Best-effort cleanup of any prior worktree state.
      await gitRun(["worktree", "remove", "--force", args.worktreePath], {
        ...args,
        cwd: args.bareDir,
      });
      throwIfExpired(args);
      await rm(args.worktreePath, { recursive: true, force: true });
    }
    throwIfExpired(args);
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
      { ...args, cwd: args.bareDir },
    );
  }, args);
  await gitMust(["config", "user.name", args.authorName], {
    ...args,
    cwd: args.worktreePath,
  });
  await gitMust(["config", "user.email", args.authorEmail], {
    ...args,
    cwd: args.worktreePath,
  });
  await gitMust(["config", "commit.gpgsign", "false"], {
    ...args,
    cwd: args.worktreePath,
  });
}

export interface RebaseOntoBaseArgs extends DeadlineOptions {
  bareDir: string;
  worktreePath: string;
  freshTokenUrl: string;
  baseBranch: string;
}

export type RebaseOutcome =
  | { kind: "clean"; preRebaseSha: string; postRebaseSha: string }
  | { kind: "no_op"; sha: string }
  | { kind: "conflict"; preRebaseSha: string };

/**
 * Refresh `baseBranch` from origin, then rebase the worktree's current branch
 * onto it. Aborts cleanly on conflict so callers can fall back to pushing the
 * un-rebased branch. Caller is responsible for re-running any post-rebase
 * verification (e.g. `bun run check`) and reverting via `preRebaseSha` if
 * desired.
 */
export async function rebaseOntoFreshBase(
  args: RebaseOntoBaseArgs,
): Promise<RebaseOutcome> {
  await withBareLock(args.bareDir, async () => {
    await gitMust(
      [
        "fetch",
        args.freshTokenUrl,
        `+refs/heads/${args.baseBranch}:refs/heads/${args.baseBranch}`,
      ],
      { ...args, cwd: args.bareDir },
    );
  }, args);
  const pre = (
    await gitMust(["rev-parse", "HEAD"], { ...args, cwd: args.worktreePath })
  ).stdout.trim();
  const r = await gitRun(["rebase", args.baseBranch], {
    ...args,
    cwd: args.worktreePath,
  });
  if (r.exitCode !== 0) {
    await gitRun(["rebase", "--abort"], { ...args, cwd: args.worktreePath });
    return { kind: "conflict", preRebaseSha: pre };
  }
  const post = (
    await gitMust(["rev-parse", "HEAD"], { ...args, cwd: args.worktreePath })
  ).stdout.trim();
  if (pre === post) return { kind: "no_op", sha: post };
  return { kind: "clean", preRebaseSha: pre, postRebaseSha: post };
}

export async function pushBranch(args: {
  worktreePath: string;
  freshTokenUrl: string;
  branch: string;
} & DeadlineOptions): Promise<void> {
  // `--force-with-lease` (no value) compares against the local remote-tracking
  // ref. Bare clones with worktrees never populate `refs/remotes/origin/*`, so
  // that form refuses every push with "stale info" once the branch exists on
  // the remote (e.g. on a retry, or when picking a ticket back up). Look up
  // the current remote SHA and pass it as an explicit expected value so the
  // lease has accurate input. An empty value tells git to expect the ref to
  // be absent, which is correct for first-time pushes.
  const lsr = await gitRun(
    ["ls-remote", args.freshTokenUrl, `refs/heads/${args.branch}`],
    { ...args, cwd: args.worktreePath },
  );
  const expectedSha = lsr.stdout.trim().split(/\s+/)[0] ?? "";
  await gitMust(
    [
      "push",
      args.freshTokenUrl,
      `${args.branch}:${args.branch}`,
      `--force-with-lease=${args.branch}:${expectedSha}`,
    ],
    { ...args, cwd: args.worktreePath },
  );
}

export async function hasCommitsAhead(
  worktreePath: string,
  baseBranch: string,
  opts: DeadlineOptions = {},
): Promise<boolean> {
  const r = await gitRun(
    ["rev-list", "--count", `${baseBranch}..HEAD`],
    { ...opts, cwd: worktreePath },
  );
  if (r.exitCode !== 0) return false;
  return Number(r.stdout.trim()) > 0;
}

export async function getHeadSha(worktreePath: string, opts: DeadlineOptions = {}): Promise<string> {
  const r = await gitMust(["rev-parse", "HEAD"], { ...opts, cwd: worktreePath });
  return r.stdout.trim();
}

export async function getDiff(
  worktreePath: string,
  baseBranch: string,
  opts: DeadlineOptions = {},
): Promise<string> {
  const r = await gitMust(["diff", `${baseBranch}...HEAD`], {
    ...opts,
    cwd: worktreePath,
  });
  return r.stdout;
}

export async function getCommitLog(
  worktreePath: string,
  baseBranch: string,
  opts: DeadlineOptions = {},
): Promise<string> {
  const r = await gitMust(
    ["log", `${baseBranch}..HEAD`, "--pretty=format:%h %s"],
    { ...opts, cwd: worktreePath },
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
