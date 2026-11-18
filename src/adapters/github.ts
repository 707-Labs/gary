import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubConfig } from "../config.ts";
import { log } from "../logger.ts";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
  headSha: string;
  /** Observed GitHub response values; absent evidence must remain unknown. */
  baseRef?: string;
  baseSha?: string;
  state: "open" | "closed";
  merged: boolean;
  isDraft: boolean;
  /** ISO timestamp when the PR was opened. Used to decide staleness. */
  createdAt: string;
}

export interface CheckRun {
  name: string;
  // Octokit's check run status enum is broader than the docs suggest; mirror it.
  status:
    | "queued"
    | "in_progress"
    | "completed"
    | "pending"
    | "waiting"
    | "requested";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped"
    | "stale"
    | null;
  detailsUrl: string;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CheckRunDetail extends CheckRun {
  outputTitle: string | null;
  outputSummary: string | null;
  outputText: string | null;
}

export interface PullRequestDetail extends PullRequestRef {
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  /** Unified diff — can be large; callers truncate at their boundary. */
  diff: string;
}

export interface PullRequestComment {
  id: number;
  /**
   * "issue" = a top-level PR comment (general discussion).
   * "review" = a line-level review comment, inline on the diff.
   * "review_body" = the body of a formal review (the text reviewers write
   *   alongside an Approve / Request Changes / Comment action). This is
   *   distinct from inline review comments, which are anchored to lines.
   */
  kind: "issue" | "review" | "review_body";
  authorLogin: string | null;
  /**
   * GitHub user type of the comment author. Used to filter out bot noise
   * (linear[bot] linkbacks, dependabot, Gary himself) from the pending-
   * review signature.
   */
  authorType: "User" | "Bot" | "Mannequin" | "Organization" | string;
  body: string;
  createdAt: string;
  htmlUrl: string;
  /** Set on review comments — file path the comment is anchored to. */
  path?: string | null;
  /** Set on review comments — line in the diff (or null if outdated). */
  line?: number | null;
}

export type AggregateCi = "green" | "red" | "pending" | "none";

export interface ViewerInfo {
  login: string;
  type: "Bot" | "User";
}

/** Host-only App credential capsule for engineering acquisition. Never expose to
 * a model, workspace, receipt or persistent Git configuration. */
export interface GitHubEngineeringInstallationCredential {
  kind: "app";
  appId: number;
  installationId: number;
  accountLogin: string;
  token: string;
  issuedAtMs: number;
  expiresAtMs: number;
  permissions: { contents: "read" | "write"; pullRequests: "none" | "read" | "write" };
}

export interface GitHubEngineeringInstallationApi {
  getInstallation(input: { installation_id: number; request: { timeout: number } }): Promise<{ data: unknown }>;
  createInstallationAccessToken(input: { installation_id: number; request: { timeout: number } }): Promise<{ data: unknown }>;
}

/** RFC 6750 section 2.1 bearer syntax, bounded independently of issuer format.
 * Installation tokens may contain JWT/base64 punctuation; never accept header
 * controls, whitespace, Unicode, or embedded padding. */
export function isGitHubEngineeringToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 4096
    && /^[A-Za-z0-9._~+/-]+=*(?![\s\S])/.test(value);
}

/** Forces a new App installation token; cached clone URLs cannot establish
 * current numeric repository authority or current installation permissions. */
export async function readGitHubEngineeringInstallationCredential(api: GitHubEngineeringInstallationApi,
  binding: { appId: number; installationId: number }, now: () => number = Date.now): Promise<GitHubEngineeringInstallationCredential> {
  const fail = (): never => { throw new Error("github_engineering_installation_unavailable"); };
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  try {
    if (![binding.appId, binding.installationId].every(id => Number.isSafeInteger(id) && id > 0)) return fail();
    const observed = (await api.getInstallation({ installation_id: binding.installationId, request: { timeout: 15_000 } })).data;
    if (!object(observed) || observed.id !== binding.installationId || observed.app_id !== binding.appId
        || observed.suspended_at !== null || !object(observed.account) || typeof observed.account.login !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(observed.account.login) || !object(observed.permissions)) return fail();
    const issuedAtMs = now();
    const issued = (await api.createInstallationAccessToken({ installation_id: binding.installationId, request: { timeout: 15_000 } })).data;
    if (!object(issued) || !isGitHubEngineeringToken(issued.token)
        || typeof issued.expires_at !== "string" || !object(issued.permissions)) return fail();
    const expiresAtMs = Date.parse(issued.expires_at);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now() || now() - issuedAtMs > 60_000) return fail();
    const contents = issued.permissions.contents;
    const pullRequests = issued.permissions.pull_requests ?? "none";
    if ((contents !== "read" && contents !== "write") || !["none", "read", "write"].includes(String(pullRequests))
        || contents !== observed.permissions.contents || pullRequests !== (observed.permissions.pull_requests ?? "none")) return fail();
    return Object.freeze({ kind: "app", ...binding, accountLogin: observed.account.login, token: issued.token,
      issuedAtMs, expiresAtMs, permissions: Object.freeze({ contents, pullRequests: pullRequests as "none" | "read" | "write" }) });
  } catch { return fail(); }
}

export interface GitHubClient {
  /** App clients only. Fresh authenticated installation metadata and issuance;
   * absent on PAT clients. This method is never a model-facing tool. */
  engineeringInstallationCredential?(): Promise<GitHubEngineeringInstallationCredential>;
  /**
   * Returns the URL to use with `git clone` and `git push`. The URL embeds an
   * installation token (App auth) or PAT (user auth). Tokens are short-lived
   * for App auth; callers should fetch a fresh URL per operation rather than
   * caching across runs.
   */
  cloneUrl(owner: string, repo: string): Promise<string>;

  getViewer(): Promise<ViewerInfo>;

  openPullRequest(args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PullRequestRef>;

  getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestRef>;

  /**
   * Like getPullRequest but also returns title, body, base/head refs, and the
   * full unified diff. Used by the agent's `get_pr` tool.
   */
  getPullRequestDetail(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestDetail>;

  getCheckRuns(owner: string, repo: string, sha: string): Promise<CheckRun[]>;

  getFailingCheckDetails(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CheckRunDetail[]>;

  aggregateCiStatus(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<AggregateCi>;

  comment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void>;

  /**
   * Stream of PRs opened by Gary against the given repo, in any state.
   * Used by the poll loop to find Gary's open PRs.
   */
  listOwnPullRequests(
    owner: string,
    repo: string,
    creatorLogin: string,
  ): Promise<PullRequestRef[]>;

  /**
   * Combined fetch of top-level PR comments and inline review comments.
   * Sorted oldest-first so callers can identify the latest. Used by the
   * pr-review handler to find new reviewer feedback Gary needs to address.
   */
  getPullRequestComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestComment[]>;
}

class AppGitHubClient implements GitHubClient {
  private readonly app: Octokit;
  private readonly appId: number;
  private readonly installationId: number;
  private readonly username: string;

  constructor(cfg: Extract<GitHubConfig, { kind: "app" }>) {
    this.app = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: cfg.appId,
        privateKey: cfg.privateKey,
        installationId: cfg.installationId,
      },
    });
    this.installationId = Number(cfg.installationId);
    this.appId = Number(cfg.appId);
    this.username = cfg.username;
  }

  async getViewer(): Promise<ViewerInfo> {
    const { data } = await this.app.apps.getAuthenticated();
    // The App's slug ("gary-707-labs") is NOT the login that appears on PR
    // comments authored by the App's installation token — those use the
    // bot-suffixed login ("gary-707-labs[bot]"). The pr-review handler
    // filters Gary's own comments by login, so returning the wrong form
    // here loops the handler. Fall back to the configured username, which
    // is already in [bot] form per .env.example.
    const slug = data?.slug;
    return {
      login: slug ? `${slug}[bot]` : this.username,
      type: "Bot",
    };
  }

  async cloneUrl(owner: string, repo: string): Promise<string> {
    const { token } = (await this.app.auth({
      type: "installation",
      installationId: this.installationId,
    })) as { token: string };
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }

  async engineeringInstallationCredential(): Promise<GitHubEngineeringInstallationCredential> {
    return readGitHubEngineeringInstallationCredential(this.app.apps, { appId: this.appId, installationId: this.installationId });
  }

  async openPullRequest(args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PullRequestRef> {
    const { data } = await this.app.pulls.create({
      owner: args.owner,
      repo: args.repo,
      head: args.head,
      base: args.base,
      title: args.title,
      body: args.body,
      draft: args.draft ?? false,
    });
    log.info("pr opened", { owner: args.owner, repo: args.repo, number: data.number });
    return prRefFromOctokit(args.owner, args.repo, data);
  }

  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestRef> {
    const { data } = await this.app.pulls.get({ owner, repo, pull_number: number });
    return prRefFromOctokit(owner, repo, data);
  }

  async getPullRequestDetail(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestDetail> {
    return getPrDetailVia(this.app, owner, repo, number);
  }

  async getCheckRuns(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CheckRun[]> {
    const { data } = await this.app.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    return data.check_runs.map((r) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      detailsUrl: r.details_url ?? "",
      htmlUrl: r.html_url ?? "",
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }

  async aggregateCiStatus(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<AggregateCi> {
    const runs = await this.getCheckRuns(owner, repo, sha);
    return summarizeCi(runs);
  }

  async getFailingCheckDetails(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CheckRunDetail[]> {
    const { data } = await this.app.checks.listForRef({
      owner,
      repo,
      ref: sha,
      filter: "latest",
      per_page: 100,
    });
    return data.check_runs
      .filter((r) => isFailingConclusion(r.conclusion))
      .map((r) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        detailsUrl: r.details_url ?? "",
        htmlUrl: r.html_url ?? "",
        startedAt: r.started_at,
        completedAt: r.completed_at,
        outputTitle: r.output?.title ?? null,
        outputSummary: r.output?.summary ?? null,
        outputText: r.output?.text ?? null,
      }));
  }

  async comment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.app.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  async listOwnPullRequests(
    owner: string,
    repo: string,
    creatorLogin: string,
  ): Promise<PullRequestRef[]> {
    const { data } = await this.app.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: 50,
    });
    return data
      .filter((p) => p.user?.login === creatorLogin)
      .map((p) => prRefFromOctokit(owner, repo, p));
  }

  async getPullRequestComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestComment[]> {
    return getPrCommentsVia(this.app, owner, repo, number);
  }
}

class PatGitHubClient implements GitHubClient {
  private readonly api: Octokit;
  private readonly token: string;
  private readonly username: string;

  constructor(cfg: Extract<GitHubConfig, { kind: "pat" }>) {
    this.api = new Octokit({ auth: cfg.token });
    this.token = cfg.token;
    this.username = cfg.username;
  }

  async getViewer(): Promise<ViewerInfo> {
    const { data } = await this.api.users.getAuthenticated();
    return { login: data.login, type: "User" };
  }

  async cloneUrl(owner: string, repo: string): Promise<string> {
    return `https://x-access-token:${this.token}@github.com/${owner}/${repo}.git`;
  }

  async openPullRequest(args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<PullRequestRef> {
    const { data } = await this.api.pulls.create({
      owner: args.owner,
      repo: args.repo,
      head: args.head,
      base: args.base,
      title: args.title,
      body: args.body,
      draft: args.draft ?? false,
    });
    return prRefFromOctokit(args.owner, args.repo, data);
  }

  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestRef> {
    const { data } = await this.api.pulls.get({ owner, repo, pull_number: number });
    return prRefFromOctokit(owner, repo, data);
  }

  async getPullRequestDetail(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestDetail> {
    return getPrDetailVia(this.api, owner, repo, number);
  }

  async getCheckRuns(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CheckRun[]> {
    const { data } = await this.api.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    return data.check_runs.map((r) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      detailsUrl: r.details_url ?? "",
      htmlUrl: r.html_url ?? "",
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }

  async aggregateCiStatus(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<AggregateCi> {
    const runs = await this.getCheckRuns(owner, repo, sha);
    return summarizeCi(runs);
  }

  async getFailingCheckDetails(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CheckRunDetail[]> {
    const { data } = await this.api.checks.listForRef({
      owner,
      repo,
      ref: sha,
      filter: "latest",
      per_page: 100,
    });
    return data.check_runs
      .filter((r) => isFailingConclusion(r.conclusion))
      .map((r) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        detailsUrl: r.details_url ?? "",
        htmlUrl: r.html_url ?? "",
        startedAt: r.started_at,
        completedAt: r.completed_at,
        outputTitle: r.output?.title ?? null,
        outputSummary: r.output?.summary ?? null,
        outputText: r.output?.text ?? null,
      }));
  }

  async comment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.api.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  async listOwnPullRequests(
    owner: string,
    repo: string,
    creatorLogin: string,
  ): Promise<PullRequestRef[]> {
    const { data } = await this.api.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: 50,
    });
    return data
      .filter((p) => p.user?.login === creatorLogin)
      .map((p) => prRefFromOctokit(owner, repo, p));
  }

  async getPullRequestComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestComment[]> {
    return getPrCommentsVia(this.api, owner, repo, number);
  }
}

interface PrPayload {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean | undefined;
  merged?: boolean;
  head: { sha: string };
  base?: { ref: string; sha: string };
  created_at: string;
}

function prRefFromOctokit(
  owner: string,
  repo: string,
  pr: PrPayload,
): PullRequestRef {
  return {
    owner,
    repo,
    number: pr.number,
    url: pr.html_url,
    headSha: pr.head.sha,
    ...(typeof pr.base?.ref === "string" ? { baseRef: pr.base.ref } : {}),
    ...(typeof pr.base?.sha === "string" ? { baseSha: pr.base.sha } : {}),
    state: pr.state === "closed" ? "closed" : "open",
    merged: Boolean(pr.merged),
    isDraft: Boolean(pr.draft),
    createdAt: pr.created_at,
  };
}

async function getPrDetailVia(
  api: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestDetail> {
  const { data } = await api.pulls.get({ owner, repo, pull_number: number });
  // Octokit decodes the diff response as a string when the diff media type
  // is requested. The type system doesn't capture that, so we widen.
  const diffRes = await api.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: number,
    mediaType: { format: "diff" },
  });
  const diff = typeof diffRes.data === "string" ? diffRes.data : "";
  return {
    ...prRefFromOctokit(owner, repo, data),
    title: data.title,
    body: data.body ?? "",
    baseRef: data.base.ref,
    headRef: data.head.ref,
    diff,
  };
}

async function getPrCommentsVia(
  api: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestComment[]> {
  const [issueRes, reviewRes, reviewsRes] = await Promise.all([
    api.issues.listComments({
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    }),
    api.pulls.listReviewComments({
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    }),
    api.pulls.listReviews({
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    }),
  ]);
  return mergePrComments({
    issueComments: issueRes.data,
    reviewComments: reviewRes.data,
    reviews: reviewsRes.data,
  });
}

export interface RawIssueComment {
  id: number;
  user: { login: string; type?: string } | null;
  body?: string | null;
  created_at: string;
  html_url: string;
}
export interface RawReviewComment extends RawIssueComment {
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
}
export interface RawReview {
  id: number;
  user: { login: string; type?: string } | null;
  state: string;
  body?: string | null;
  submitted_at?: string;
  html_url: string;
}

/**
 * Merge GitHub's three PR-feedback streams into one ordered list. Pure
 * function (no I/O) so it can be tested without standing up Octokit.
 *
 * Review bodies are included only when they carry actionable content:
 * APPROVED reviews are terminal and don't require a response; DISMISSED
 * reviews are no-ops; CHANGES_REQUESTED and COMMENTED bodies become
 * comments Gary owes a response to. Inline review comments on the same
 * review are surfaced separately as `kind: "review"`.
 */
export function mergePrComments(args: {
  issueComments: ReadonlyArray<RawIssueComment>;
  reviewComments: ReadonlyArray<RawReviewComment>;
  reviews: ReadonlyArray<RawReview>;
}): PullRequestComment[] {
  const merged: PullRequestComment[] = [
    ...args.issueComments.map(
      (c): PullRequestComment => ({
        id: c.id,
        kind: "issue",
        authorLogin: c.user?.login ?? null,
        authorType: c.user?.type ?? "User",
        body: c.body ?? "",
        createdAt: c.created_at,
        htmlUrl: c.html_url,
      }),
    ),
    ...args.reviewComments.map(
      (c): PullRequestComment => ({
        id: c.id,
        kind: "review",
        authorLogin: c.user?.login ?? null,
        authorType: c.user?.type ?? "User",
        body: c.body ?? "",
        createdAt: c.created_at,
        htmlUrl: c.html_url,
        path: c.path ?? null,
        line: c.line ?? c.original_line ?? null,
      }),
    ),
    ...args.reviews
      .filter(
        (r) =>
          (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") &&
          (r.body ?? "").trim().length > 0,
      )
      .map(
        (r): PullRequestComment => ({
          id: r.id,
          kind: "review_body",
          authorLogin: r.user?.login ?? null,
          authorType: r.user?.type ?? "User",
          body: r.body ?? "",
          createdAt: r.submitted_at ?? new Date(0).toISOString(),
          htmlUrl: r.html_url,
        }),
      ),
  ];
  return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function summarizeCi(runs: CheckRun[]): AggregateCi {
  if (runs.length === 0) return "none";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const failed = runs.some((r) => isFailingConclusion(r.conclusion));
  return failed ? "red" : "green";
}

function isFailingConclusion(c: CheckRun["conclusion"]): boolean {
  return c === "failure" || c === "timed_out" || c === "action_required";
}

export function makeGitHubClient(cfg: GitHubConfig): GitHubClient {
  return cfg.kind === "app"
    ? new AppGitHubClient(cfg)
    : new PatGitHubClient(cfg);
}
