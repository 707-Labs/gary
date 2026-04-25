import { describe, expect, it } from "bun:test";
import type { GitHubClient, PullRequestDetail } from "../src/adapters/github.ts";
import { makeToolset } from "../src/agent/tools.ts";
import type { Executor } from "../src/executors/index.ts";

const noopExecutor: Executor = {
  workspaceRoot: "/tmp",
  readFile: async () => "",
  writeFile: async () => {},
  listFiles: async () => [],
  grep: async () => [],
  run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
};

function makeFakeGithub(detail: PullRequestDetail): GitHubClient {
  return {
    getPullRequestDetail: async () => detail,
  } as unknown as GitHubClient;
}

const samplePr: PullRequestDetail = {
  owner: "707-Labs",
  repo: "ertai",
  number: 260,
  url: "https://github.com/707-Labs/ertai/pull/260",
  headSha: "abc123",
  state: "open",
  merged: false,
  isDraft: false,
  title: "feat(scryfall): split rate limiter",
  body: "## Summary\nsplit interactive and batch queues",
  baseRef: "main",
  headRef: "ERT-1610-split-rate-limiter",
  diff: "diff --git a/src/scryfall.ts b/src/scryfall.ts\n+++ etc",
};

describe("get_pr tool", () => {
  it("returns title, body, and diff for the default repo", async () => {
    const tools = makeToolset(noopExecutor, {
      github: makeFakeGithub(samplePr),
      defaultRepo: "707-Labs/ertai",
    });
    const tool = tools.handlers.get_pr!;
    const out = await tool.run({ number: 260 });
    expect(out).toContain("707-Labs/ertai#260: feat(scryfall): split rate limiter");
    expect(out).toContain("base: main  head: ERT-1610-split-rate-limiter");
    expect(out).toContain("split interactive and batch queues");
    expect(out).toContain("diff --git a/src/scryfall.ts");
  });

  it("can suppress the diff", async () => {
    const tools = makeToolset(noopExecutor, {
      github: makeFakeGithub(samplePr),
      defaultRepo: "707-Labs/ertai",
    });
    const tool = tools.handlers.get_pr!;
    const out = await tool.run({ number: 260, include_diff: false });
    expect(out).not.toContain("diff --git");
  });

  it("errors when no default repo and none provided", async () => {
    const tools = makeToolset(noopExecutor, {
      github: makeFakeGithub(samplePr),
    });
    const tool = tools.handlers.get_pr!;
    const out = await tool.run({ number: 260 });
    expect(out).toMatch(/no repo specified/);
  });

  it("isn't registered when github is not provided", () => {
    const tools = makeToolset(noopExecutor);
    expect(tools.handlers.get_pr).toBeUndefined();
  });

  it("truncates oversized diffs", async () => {
    const big = "x".repeat(60_000);
    const tools = makeToolset(noopExecutor, {
      github: makeFakeGithub({ ...samplePr, diff: big }),
      defaultRepo: "707-Labs/ertai",
    });
    const tool = tools.handlers.get_pr!;
    const out = await tool.run({ number: 260 });
    expect(out).toContain("truncated to 30000");
  });
});
