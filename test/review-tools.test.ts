import { describe, expect, it } from "bun:test";
import { makeReviewerToolset } from "../src/review/tools.ts";
import type { ExecResult, Executor, GrepMatch } from "../src/executors/index.ts";

function fakeExecutor(): Executor {
  return {
    workspaceRoot: "/tmp/fake",
    async readFile() { return "fake"; },
    async writeFile() {},
    async listFiles(): Promise<string[]> { return []; },
    async grep(): Promise<GrepMatch[]> { return []; },
    async run(): Promise<ExecResult> {
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  };
}

describe("makeReviewerToolset", () => {
  it("exposes only read+run+submit_review tools", () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const names = tools.definitions.map((d) => d.name).sort();
    expect(names).toEqual(["fetch_url", "grep", "list_files", "read_file", "run_bash", "submit_review"]);
    expect(tools.handlers["write_file"]).toBeUndefined();
    expect(tools.handlers["edit_file"]).toBeUndefined();
    expect(tools.handlers["commit"]).toBeUndefined();
    expect(tools.handlers["finish"]).toBeUndefined();
  });

  it("submit_review with approve captures the review", async () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const result = await tools.handlers["submit_review"]!.run({
      verdict: "approve",
      findings: [],
      advisory_notes: ["consider adding a test for the helper"],
      verification_report: "## Verification\n\n- ran tests, all pass",
    });
    expect(result).toBe("review submitted");
    expect(tools.review).not.toBeNull();
    expect(tools.review!.verdict).toBe("approve");
    expect(tools.review!.advisoryNotes).toEqual(["consider adding a test for the helper"]);
  });

  it("submit_review with changes_needed requires non-empty findings", async () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const r = await tools.handlers["submit_review"]!.run({
      verdict: "changes_needed",
      findings: [],
      advisory_notes: [],
      verification_report: "",
    });
    expect(r).toMatch(/findings.*non-empty|at least one finding/i);
    expect(tools.review).toBeNull();
  });

  it("submit_review with approve rejects non-empty findings", async () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const r = await tools.handlers["submit_review"]!.run({
      verdict: "approve",
      findings: [{ title: "broken", detail: "no", bug_class: "wrong_code_path" }],
      advisory_notes: [],
      verification_report: "",
    });
    expect(r).toMatch(/approve.*findings|cannot approve/i);
    expect(tools.review).toBeNull();
  });

  it("run_bash appends to runLog with redacted command and exit code", async () => {
    const exec: Executor = {
      ...fakeExecutor(),
      async run(): Promise<ExecResult> {
        return { stdout: "", stderr: "", exitCode: 7, timedOut: false };
      },
    };
    const tools = makeReviewerToolset(exec);
    await tools.handlers["run_bash"]!.run({
      command: "git fetch https://x-access-token:ghs_secret@github.com/o/r.git",
    });
    expect(tools.runLog.length).toBe(1);
    expect(tools.runLog[0]!.exit).toBe(7);
    expect(tools.runLog[0]!.cmd).toContain("[REDACTED]");
    expect(tools.runLog[0]!.cmd).not.toContain("ghs_secret");
  });
});
