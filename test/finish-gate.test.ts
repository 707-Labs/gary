import { describe, expect, it } from "bun:test";
import { makeToolset } from "../src/agent/tools.ts";
import type { ExecResult, Executor, GrepMatch } from "../src/executors/index.ts";

function fakeExecutor(runImpl?: (cmd: string) => ExecResult): Executor {
  const defaultImpl = (): ExecResult => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
  return {
    workspaceRoot: "/tmp/fake",
    async readFile() {
      return "";
    },
    async writeFile() {},
    async listFiles(): Promise<string[]> {
      return [];
    },
    async grep(): Promise<GrepMatch[]> {
      return [];
    },
    async run(cmd: string): Promise<ExecResult> {
      return runImpl ? runImpl(cmd) : defaultImpl();
    },
  };
}

describe("finish gate", () => {
  it("without a gate command, finish() succeeds immediately", async () => {
    const tools = makeToolset(fakeExecutor());
    const result = await tools.handlers["finish"]!.run({ summary: "did stuff" });
    expect(result).toBe("finished");
    expect(tools.finishSummary).toBe("did stuff");
  });

  it("with a gate command, finish() rejects until run_bash succeeds with the command", async () => {
    const tools = makeToolset(fakeExecutor(), { finishGateCommand: "bun run check" });

    // Without running the gate command, finish should be rejected.
    const denied = await tools.handlers["finish"]!.run({ summary: "ship it" });
    expect(denied).toMatch(/cannot finish/);
    expect(tools.finishSummary).toBeNull();

    // Run an unrelated bash command — gate stays unmet.
    await tools.handlers["run_bash"]!.run({ command: "echo hi" });
    const stillDenied = await tools.handlers["finish"]!.run({ summary: "ship it" });
    expect(stillDenied).toMatch(/cannot finish/);
    expect(tools.finishSummary).toBeNull();
  });

  it("a non-zero exit on the gate command does not flip the gate", async () => {
    const tools = makeToolset(
      fakeExecutor((cmd) =>
        cmd === "bun run check"
          ? { stdout: "", stderr: "type error", exitCode: 1, timedOut: false }
          : { stdout: "", stderr: "", exitCode: 0, timedOut: false },
      ),
      { finishGateCommand: "bun run check" },
    );

    await tools.handlers["run_bash"]!.run({ command: "bun run check" });
    expect(tools.finishGateMet).toBe(false);
    const denied = await tools.handlers["finish"]!.run({ summary: "done" });
    expect(denied).toMatch(/cannot finish/);
  });

  it("a successful gate-command run flips the gate and lets finish() through", async () => {
    const tools = makeToolset(fakeExecutor(), { finishGateCommand: "bun run check" });

    await tools.handlers["run_bash"]!.run({ command: "bun run check" });
    expect(tools.finishGateMet).toBe(true);

    const accepted = await tools.handlers["finish"]!.run({ summary: "verified" });
    expect(accepted).toBe("finished");
    expect(tools.finishSummary).toBe("verified");
  });

  it("matching is exact (whitespace-trimmed but no fuzzy match)", async () => {
    const tools = makeToolset(fakeExecutor(), { finishGateCommand: "bun run check" });

    // Different command — does NOT trip the gate.
    await tools.handlers["run_bash"]!.run({ command: "bun run check:watch" });
    expect(tools.finishGateMet).toBe(false);

    // Same command with leading/trailing whitespace trims to a match.
    await tools.handlers["run_bash"]!.run({ command: "  bun run check  " });
    expect(tools.finishGateMet).toBe(true);
  });
});
