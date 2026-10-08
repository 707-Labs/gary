import { describe, expect, it, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { GLMClient } from "../src/adapters/glm.ts";
import type { ExecResult, Executor, GrepMatch } from "../src/executors/index.ts";
import { runReviewer } from "../src/review/runner.ts";

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/state/schema.sql");

function freshDb(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.query("INSERT INTO tickets (linear_id, identifier) VALUES ('issue-1', 'ERT-1')").run();
  return db;
}

function fakeExecutor(): Executor {
  return {
    workspaceRoot: "/tmp/fake",
    async readFile() { return ""; },
    async writeFile() {},
    async listFiles(): Promise<string[]> { return []; },
    async grep(): Promise<GrepMatch[]> { return []; },
    async run(): Promise<ExecResult> { return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; },
  };
}

const STANDARD_USAGE = {
  input_tokens: 100, output_tokens: 50,
  cache_creation_input_tokens: null, cache_read_input_tokens: null,
} as unknown as Anthropic.Usage;

function approveTurn(): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "fake",
    content: [{
      type: "tool_use", id: "tu_1", name: "submit_review",
      input: {
        verdict: "approve", findings: [], advisory_notes: [],
        verification_report: "## Verification\n\n- read the diff\n- nothing concerning",
      },
    }],
    stop_reason: "tool_use", stop_sequence: null, usage: STANDARD_USAGE,
  } as Anthropic.Message;
}

function changesNeededTurn(): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "fake",
    content: [{
      type: "tool_use", id: "tu_1", name: "submit_review",
      input: {
        verdict: "changes_needed",
        findings: [{ title: "missing receiver", detail: "no consumer", bug_class: "half_wired" }],
        advisory_notes: [],
        verification_report: "found unwired param",
      },
    }],
    stop_reason: "tool_use", stop_sequence: null, usage: STANDARD_USAGE,
  } as Anthropic.Message;
}

function fakeGlm(turns: Array<() => Anthropic.Message>): GLMClient {
  let i = 0;
  return {
    async createMessage(): Promise<Anthropic.Message> {
      const make = turns[i++];
      if (!make) throw new Error("no scripted turn");
      return make();
    },
    chain: {
      providers: [{ name: "deepseek", model: "deepseek-v4-pro" } as never],
      active: () => ({ name: "deepseek", model: "deepseek-v4-pro" }) as never,
      allArmed: () => false,
      earliestReset: () => null,
    },
  } as unknown as GLMClient;
}

describe("runReviewer", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  it("returns approve verdict and persists a row", async () => {
    const result = await runReviewer({
      db, glm: fakeGlm([approveTurn]), executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 1,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 60_000,
    });
    expect(result.kind).toBe("verdict");
    if (result.kind === "verdict") expect(result.review.verdict).toBe("approve");
    const row = db.query<{ verdict: string; round: number }, []>(
      "SELECT verdict, round FROM review_passes ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row!.verdict).toBe("approve");
    expect(row!.round).toBe(1);
  });

  it("forwards a trusted exact-artifact host receipt without running the gate again", async () => {
    const hostCheck = { command: "bun run ci:full", exitCode: 0 as const, timedOut: false as const,
      exactArtifact: { headSha: "a".repeat(40), baseSha: "b".repeat(40), treeSha: "c".repeat(40), worktreeClean: true as const } };
    const glm = fakeGlm([approveTurn]);
    const createMessage = mock<GLMClient["createMessage"]>(async args => {
      expect(JSON.stringify(args.messages)).toContain("trusted host verification");
      expect(JSON.stringify(args.messages)).toContain(hostCheck.exactArtifact.headSha);
      expect(JSON.stringify(args.messages)).toContain("bun run ci:full");
      expect(args.system).toContain("never claim you ran the host command yourself");
      return approveTurn();
    });
    glm.createMessage = createMessage;
    const executor = fakeExecutor();
    const run = mock<Executor["run"]>(async () => { throw new Error("Unexpected duplicate full gate"); });
    executor.run = run;
    const result = await runReviewer({ db, glm, executor, hostCheck,
      ticket: { identifier: "ERT-1", title: "t", description: null }, issueLinearId: "issue-1", fingerprint: "fp-1", round: 1,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [], worktreePath: "/tmp/wt", iterationCap: 6, timeoutMs: 180_000 });
    expect(result.kind).toBe("verdict");
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns changes_needed and persists with finding count", async () => {
    const result = await runReviewer({
      db, glm: fakeGlm([changesNeededTurn]), executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 2,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 60_000,
    });
    expect(result.kind).toBe("verdict");
    if (result.kind === "verdict") {
      expect(result.review.verdict).toBe("changes_needed");
      expect(result.review.findings.length).toBe(1);
    }
    const row = db.query<{ verdict: string; finding_count: number }, []>(
      "SELECT verdict, finding_count FROM review_passes ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row!.verdict).toBe("changes_needed");
    expect(row!.finding_count).toBe(1);
  });

  it("returns kind=failed and persists when the agent loop times out", async () => {
    const glm = {
      async createMessage(): Promise<Anthropic.Message> {
        await new Promise((r) => setTimeout(r, 200));
        return approveTurn();
      },
      chain: {
        providers: [{ name: "deepseek", model: "deepseek-v4-pro" } as never],
        active: () => ({ name: "deepseek", model: "deepseek-v4-pro" }) as never,
        allArmed: () => false, earliestReset: () => null,
      },
    } as unknown as GLMClient;
    const result = await runReviewer({
      db, glm, executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 1,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 50,
    });
    expect(result.kind).toBe("failed");
    const row = db.query<{ verdict: string }, []>(
      "SELECT verdict FROM review_passes ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row!.verdict).toBe("failed");
  });

  it("returns kind=failed when the agent doesn't call submit_review", async () => {
    const noSubmitTurn = (): Anthropic.Message => ({
      id: "m", type: "message", role: "assistant", model: "fake",
      content: [{ type: "text", text: "I refuse" }],
      stop_reason: "end_turn", stop_sequence: null, usage: STANDARD_USAGE,
    } as Anthropic.Message);
    const result = await runReviewer({
      db, glm: fakeGlm([noSubmitTurn]), executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 1,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 60_000,
    });
    expect(result.kind).toBe("failed");
  });
});
