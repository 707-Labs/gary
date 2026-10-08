import { describe, expect, it } from "bun:test";
import {
  REVIEW_TASK_INSTRUCTIONS,
  composeReviewerSystemPrompt,
  renderReviewTask,
} from "../src/review/prompts.ts";
import type { RunLogEntry } from "../src/agent/loop.ts";
import type { PrecheckFinding } from "../src/review/precheck.ts";

describe("REVIEW_TASK_INSTRUCTIONS", () => {
  it("frames the reviewer as a bug-finder, not a style critic", () => {
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/bug/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/style|refactor|advisory/i);
  });
  it("lists the four bug classes", () => {
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/wrong[_\s]code[_\s]path/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/unverified[_\s]claim/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/half[_\s-]wired/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/untested[_\s]logic/i);
  });
  it("instructs to call submit_review", () => {
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/submit_review/);
  });
});

describe("renderReviewTask", () => {
  const ticket = { identifier: "ERT-1", title: "fix the foo", description: "foo is broken" };

  it("includes the diff, run-log, ticket, and pre-check findings", () => {
    const runLog: RunLogEntry[] = [
      { cmd: "bun test", exit: 0, ts: 1 },
      { cmd: "git status", exit: 0, ts: 2 },
    ];
    const precheck: PrecheckFinding[] = [
      { kind: "untested_export", name: "buildPayload", file: "src/foo.ts" },
    ];
    const out = renderReviewTask({
      ticket,
      diff: "diff --git a/src/foo.ts b/src/foo.ts",
      runLog,
      precheckFindings: precheck,
      previousFindings: [],
      worktreePath: "/tmp/wt",
    });
    expect(out).toContain("ERT-1");
    expect(out).toContain("foo is broken");
    expect(out).toContain("bun test");
    expect(out).toContain("git status");
    expect(out).toContain("buildPayload");
  });

  it("includes prior-round findings when re-reviewing", () => {
    const out = renderReviewTask({
      ticket,
      diff: "...",
      runLog: [],
      precheckFindings: [],
      previousFindings: [{ title: "missing receiver", detail: "no consumer", bugClass: "half_wired" }],
      worktreePath: "/tmp/wt",
    });
    expect(out).toMatch(/previous round|round 1|earlier finding/i);
    expect(out).toContain("missing receiver");
  });

  it("flags an empty run-log explicitly", () => {
    const out = renderReviewTask({
      ticket,
      diff: "...",
      runLog: [],
      precheckFindings: [],
      previousFindings: [],
      worktreePath: "/tmp/wt",
    });
    expect(out).toMatch(/no.*commands|empty.*run.log|did not run/i);
  });
});

describe("composeReviewerSystemPrompt", () => {
  it("includes the review task instructions", () => {
    expect(composeReviewerSystemPrompt()).toContain(REVIEW_TASK_INSTRUCTIONS);
  });
});


describe("trusted host verification receipt", () => {
  const hostCheck = {
    command: "bun run ci:full", exitCode: 0 as const, timedOut: false as const,
    exactArtifact: { headSha: "a".repeat(40), baseSha: "b".repeat(40), treeSha: "c".repeat(40), worktreeClean: true as const },
  };
  it("distinguishes exact-artifact host evidence from the reviewer's own tests", () => {
    const task = renderReviewTask({ ticket: { identifier: "ERT-1", title: "fix", description: null },
      diff: "fixture diff", runLog: [], precheckFindings: [], previousFindings: [], worktreePath: "/offline", hostCheck });
    expect(task).toContain(JSON.stringify(hostCheck));
    expect(task).toContain("not a command you ran");
    expect(task).not.toContain("strong signal for unverified_claim");
    expect(composeReviewerSystemPrompt(hostCheck)).toContain("never claim you ran the host command yourself");
    expect(composeReviewerSystemPrompt()).not.toContain("host supplied a successful verification receipt");
  });
});
