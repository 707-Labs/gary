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
  state: "open" | "closed";
  merged: boolean;
  isDraft: boolean;
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

export type AggregateCi = "green" | "red" | "pending" | "none";

export interface ViewerInfo {
  login: string;
  type: "Bot" | "User";
}

export interface GitHubClient {
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
}

class AppGitHubClient implements GitHubClient {
  private readonly app: Octokit;
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
    this.username = cfg.username;
  }

  async getViewer(): Promise<ViewerInfo> {
    const { data } = await this.app.apps.getAuthenticated();
    return { login: data?.slug ?? this.username, type: "Bot" };
  }

  async cloneUrl(owner: string, repo: string): Promise<string> {
    const { token } = (await this.app.auth({
      type: "installation",
      installationId: this.installationId,
    })) as { token: string };
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
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
}

interface PrPayload {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean | undefined;
  merged?: boolean;
  head: { sha: string };
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
    state: pr.state === "closed" ? "closed" : "open",
    merged: Boolean(pr.merged),
    isDraft: Boolean(pr.draft),
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
