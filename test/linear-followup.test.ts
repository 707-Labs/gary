import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GLMClient } from "../src/adapters/glm.ts";
import type { GitHubClient, PullRequestDetail } from "../src/adapters/github.ts";
import type { AssignedIssue, IssueComment, LinearAdapter } from "../src/adapters/linear.ts";
import { gitMust, restorePrWorktree } from "../src/git.ts";
import { runLinearFollowup } from "../src/handlers/linear-followup.ts";
import { type PrReviewHandlerDeps } from "../src/handlers/pr-review.ts";
import { computeHumanInputSignature } from "../src/state-fingerprint.ts";
import { closeDb, openDb, type DB } from "../src/state/db.ts";
import { getRevisitMark, setRevisitMark, upsertTicket } from "../src/state/queries.ts";

let dir: string, remote: string, workspace: string, db: DB;
let replies: string[], classifications: string[], toolsSeen: string[][];
let mode: "change" | "answer", failReply: boolean;
let script: ((turn: number) => Promise<Anthropic.Message>) | null;
let deps: PrReviewHandlerDeps;
const issue = { id: "ticket", identifier: "TEST-1", title: "test change", description: "context", teamId: "team", teamKey: "TEST" } as AssignedIssue;
const old: IssueComment = { id: "old", body: "initial work", createdAt: "2026-01-01T00:00:00Z", userId: "person", userName: "Person" };
const request: IssueComment = { ...old, id: "new", body: "please fix the value", createdAt: "2026-01-01T00:01:00Z" };
const signature = (comments: readonly IssueComment[]) => computeHumanInputSignature({ description: issue.description, comments, garyUserId: "worker" });
const git = async (cwd: string, ...args: string[]) => (await gitMust(args, { cwd })).stdout.trim();
function tool(name: string, input: Record<string, unknown>): Anthropic.Message {
  return { id: "fake", type: "message", role: "assistant", model: "fake", content: [{ type: "tool_use", id: `use-${name}`, name, input }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as Anthropic.Message;
}
function args(comments = [old, request]) {
  return { issue, repo: "example/test", prGithubId: 1, prNumber: 2, branch: "task", comments, humanInputSignature: signature(comments) };
}
beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "gary-followup-"));
  remote = resolve(dir, "remote.git"); workspace = resolve(dir, "workspaces/TEST-1");
  mkdirSync(resolve(dir, "workspaces"));
  await git(dir, "init", "--bare", remote);
  await git(dir, "init", "-b", "task", workspace);
  await git(workspace, "config", "user.name", "Test"); await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "commit.gpgsign", "false");
  writeFileSync(resolve(workspace, "value.txt"), "before\n");
  await git(workspace, "add", "."); await git(workspace, "commit", "-m", "initial"); await git(workspace, "push", remote, "task");
  db = openDb(resolve(dir, "state.db")); upsertTicket(db, { linearId: "ticket", identifier: "TEST-1" });
  setRevisitMark(db, issue.id, signature([old]));
  replies = []; classifications = []; toolsSeen = []; mode = "change"; failReply = false; script = null;
  let turns = 0;
  const glm = {
    async complete(input: { user: string }) { classifications.push(input.user); return JSON.stringify({ mode, confidence: 1 }); },
    async createMessage(input: { tools: Anthropic.Tool[] }) {
      toolsSeen.push(input.tools.map(t => t.name));
      if (script) return script(turns++);
      return tool("finish", { summary: "handled test follow-up" });
    },
  } as unknown as GLMClient;
  const github = {
    async getViewer() { return { login: "test-bot", type: "Bot" }; },
    async getPullRequestDetail() { return { state: "open", merged: false, headRef: "task", headSha: await git(remote, "rev-parse", "refs/heads/task"), title: "Test", body: "", number: 2 } as PullRequestDetail; },
    async cloneUrl() { return remote; },
    async comment() { throw new Error("Linear follow-ups must reply on Linear"); },
  } as unknown as GitHubClient;
  const linear = { linearUserId: "worker", async postComment(_id: string, body: string) { if (failReply) throw new Error("reply failed"); replies.push(body); return "reply"; } } as unknown as LinearAdapter;
  deps = { db, glm, github, linear, cloudflare: null, reposDir: resolve(dir, "repos"), workspacesDir: resolve(dir, "workspaces"), agentLoopMaxIterations: 8, agentLoopTimeoutMs: 10_000 };
});
afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

describe("Linear follow-up execution", () => {
  it("pushes a concrete change to the existing branch, replies on Linear and deduplicates", async () => {
    const before = await git(remote, "rev-parse", "task");
    script = async i => [tool("write_file", { path: "value.txt", content: "after\n" }), tool("commit", { message: "fix requested value" }), tool("finish", { summary: "fixed value" })][i]!;
    await runLinearFollowup(deps, args());
    const after = await git(remote, "rev-parse", "task");
    expect(after).not.toBe(before);
    expect(await git(remote, "rev-parse", `${after}^`)).toBe(before);
    expect(replies).toEqual(["fixed value"]);
    expect(getRevisitMark(db, issue.id)).toBe(args().humanInputSignature);
    await runLinearFollowup(deps, args());
    expect(classifications).toHaveLength(1); expect(replies).toHaveLength(1);
  });
  it("questions cannot run shell/write/commit tools even if the model asks", async () => {
    mode = "answer";
    script = async i => [tool("write_file", { path: "value.txt", content: "bad" }), tool("run_bash", { command: "touch forbidden" }), tool("finish", { summary: "answer" })][i]!;
    await runLinearFollowup(deps, args());
    expect(readFileSync(resolve(workspace, "value.txt"), "utf8")).toBe("before\n");
    expect(existsSync(resolve(workspace, "forbidden"))).toBe(false);
    for (const names of toolsSeen) for (const forbidden of ["write_file", "commit", "run_bash", "dispatch_subagent"]) expect(names).not.toContain(forbidden);
    expect(replies).toEqual(["answer"]);
  });
  it("sends every pending request to classification and preserves failed replies", async () => {
    const question = { ...request, id: "question", body: "also why does it retry?", createdAt: "2026-01-01T00:02:00Z" };
    failReply = true;
    await expect(runLinearFollowup(deps, args([old, request, question]))).rejects.toThrow("reply failed");
    expect(classifications[0]).toContain(request.body); expect(classifications[0]).toContain(question.body);
    expect(getRevisitMark(db, issue.id)).toBe(signature([old]));
  });
  it("unfinished runs never consume input", async () => {
    script = async () => ({ ...tool("finish", {}), content: [{ type: "text", text: "stopped" }], stop_reason: "end_turn" } as Anthropic.Message);
    await expect(runLinearFollowup(deps, args())).rejects.toThrow("did not finish");
    expect(getRevisitMark(db, issue.id)).toBe(signature([old])); expect(replies).toEqual([]);
  });
  it("rejects a dirty or divergent checkout without resetting its files/commits", async () => {
    writeFileSync(resolve(workspace, "value.txt"), "retained progress\n");
    await expect(runLinearFollowup(deps, args())).rejects.toThrow("uncommitted");
    expect(readFileSync(resolve(workspace, "value.txt"), "utf8")).toBe("retained progress\n");
    await git(workspace, "add", "."); await git(workspace, "commit", "-m", "retained");
    const local = await git(workspace, "rev-parse", "HEAD");
    await expect(runLinearFollowup(deps, args())).rejects.toThrow("differs from the live PR");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(local);
  });
  it("a remote advance during work preserves local commits and refuses the push", async () => {
    let competitor = "";
    script = async i => {
      if (i === 0) return tool("write_file", { path: "value.txt", content: "ours\n" });
      if (i === 1) return tool("commit", { message: "ours" });
      const other = resolve(dir, "other"); await git(dir, "clone", "-b", "task", remote, other);
      await git(other, "config", "user.name", "Other"); await git(other, "config", "user.email", "other@example.invalid");
      writeFileSync(resolve(other, "other.txt"), "theirs"); await git(other, "add", "."); await git(other, "-c", "commit.gpgsign=false", "commit", "-m", "theirs");
      competitor = await git(other, "rev-parse", "HEAD"); await git(other, "push", remote, "task");
      return tool("finish", { summary: "ours" });
    };
    await expect(runLinearFollowup(deps, args())).rejects.toThrow("advanced during follow-up");
    expect(await git(remote, "rev-parse", "task")).toBe(competitor);
    expect(await git(workspace, "rev-parse", "HEAD")).not.toBe(competitor);
    expect(getRevisitMark(db, issue.id)).toBe(signature([old]));
  });
  it("comment arrival after candidate selection stays unconsumed", async () => {
    const selected = args(); selected.comments = [...selected.comments, { ...request, id: "later" }];
    await expect(runLinearFollowup(deps, selected)).rejects.toThrow("changed during selection");
    expect(classifications).toEqual([]); expect(replies).toEqual([]);
  });
});

describe("safe PR worktree restoration", () => {
  async function setup() {
    const bare = resolve(dir, "restore.git"); await git(dir, "clone", "--bare", remote, bare);
    return { bareDir: bare, worktreePath: resolve(dir, "restored"), branch: "task", expectedHead: await git(remote, "rev-parse", "task"), freshTokenUrl: remote, authorName: "Test", authorEmail: "test@example.invalid" };
  }
  it("refuses to reset a retained local branch when its worktree is missing", async () => {
    const restore = await setup();
    writeFileSync(resolve(workspace, "value.txt"), "retained"); await git(workspace, "add", "."); await git(workspace, "commit", "-m", "retained");
    await git(restore.bareDir, "fetch", workspace, "task:task");
    const retained = await git(restore.bareDir, "rev-parse", "task");
    await expect(restorePrWorktree(restore)).rejects.toThrow("Retained local");
    expect(await git(restore.bareDir, "rev-parse", "task")).toBe(retained); expect(existsSync(restore.worktreePath)).toBe(false);
  });
  it("serializes concurrent restoration without removing the winner's checkout", async () => {
    const restore = await setup();
    const results = await Promise.allSettled([restorePrWorktree(restore), restorePrWorktree(restore)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await git(restore.worktreePath, "rev-parse", "HEAD")).toBe(restore.expectedHead);
  });
});
