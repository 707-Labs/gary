import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { GLMClient } from "../src/adapters/glm.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createDeadline, DeadlineExceededError, type DeadlineOptions } from "../src/deadline.ts";
import { bindExecutorDeadline, type Executor } from "../src/executors/index.ts";

function turn(...calls: Array<{ name: string; input: Record<string, unknown> }>): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "fake",
    content: calls.map((call, i) => ({ type: "tool_use", id: `call-${i}`, ...call })),
    stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}
function executor(overrides: Partial<Executor> = {}): Executor {
  return {
    workspaceRoot: "/tmp/fake",
    readFile: async () => "contents", writeFile: async () => {},
    listFiles: async () => [], grep: async () => [],
    run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    ...overrides,
  };
}
function args(glm: GLMClient, exec = executor()) {
  return { glm, executor: exec, systemPrompt: "", task: "test", maxIterations: 4, timeoutMs: 1_000 };
}
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("shared deadlines", () => {
  it("a child cannot extend the absolute parent deadline", () => {
    const parent = createDeadline({ timeoutMs: 1_000 });
    const child = createDeadline({ deadlineMs: parent.deadlineMs, signal: parent.signal, timeoutMs: 60_000 });
    expect(child.deadlineMs).toBe(parent.deadlineMs);
    child.dispose(); parent.dispose();
  });

  it("an expired budget starts no model work", async () => {
    let calls = 0;
    const glm = { createMessage: async () => { calls++; return turn({ name: "finish", input: { summary: "late" } }); } } as unknown as GLMClient;
    const result = await runAgentLoop({ ...args(glm), deadlineMs: Date.now() - 1 });
    expect(result.status).toBe("timeout");
    expect(result.iterations).toBe(0);
    expect(calls).toBe(0);
  });

  it("aborts a pending model request and returns timeout", async () => {
    let cancelled = false;
    const glm = { createMessage: async (_: unknown, opts: DeadlineOptions) => {
      try { return await waitForAbort(opts.signal!); } finally { cancelled = true; }
    } } as unknown as GLMClient;
    const result = await runAgentLoop({ ...args(glm), timeoutMs: 20 });
    expect(cancelled).toBe(true);
    expect(result.status).toBe("timeout");
  });

  it("does not execute a late finish or write from a non-cooperative model", async () => {
    let writes = 0;
    const glm = { createMessage: async (_: unknown, opts: DeadlineOptions) => {
      await waitForAbort(opts.signal!).catch(() => {});
      return turn({ name: "write_file", input: { path: "late", content: "no" } }, { name: "finish", input: { summary: "late" } });
    } } as unknown as GLMClient;
    const result = await runAgentLoop({ ...args(glm, executor({ writeFile: async () => { writes++; } })), timeoutMs: 20 });
    expect(result.status).toBe("timeout");
    expect(writes).toBe(0);
    expect(result.summary).toBeNull();
  });

  it("aborts a running tool and skips the rest of its tool batch", async () => {
    let calls = 0;
    let writes = 0;
    let toolCancelled = false;
    const glm = { createMessage: async () => {
      calls++;
      return turn({ name: "run_bash", input: { command: "slow", timeout_ms: 100_000 } }, { name: "write_file", input: { path: "late", content: "no" } });
    } } as unknown as GLMClient;
    const exec = executor({
      run: async (_cmd, opts) => {
        try { return await waitForAbort(opts!.signal!); } finally { toolCancelled = true; }
      },
      writeFile: async () => { writes++; },
    });
    const result = await runAgentLoop({ ...args(glm, exec), timeoutMs: 20 });
    expect(result.status).toBe("timeout");
    expect(toolCancelled).toBe(true);
    expect(calls).toBe(1);
    expect(writes).toBe(0);
  });

  it("passes the same deadline and cancellation into a nested investigation", async () => {
    const controller = new AbortController();
    const deadlines: number[] = [];
    let calls = 0;
    const glm = { createMessage: async (_: unknown, opts: DeadlineOptions) => {
      deadlines.push(opts.deadlineMs!);
      if (calls++ === 0) return turn({ name: "dispatch_subagent", input: { task: "inspect" } });
      controller.abort();
      await waitForAbort(opts.signal!);
    } } as unknown as GLMClient;
    const shared = Date.now() + 500;
    const result = await runAgentLoop({ ...args(glm), deadlineMs: shared, signal: controller.signal });
    expect(deadlines).toEqual([shared, shared]);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toBe("aborted");
  });

  it("executor binding refuses late success and preserves typed timeout", async () => {
    const budget = createDeadline({ timeoutMs: 20 });
    const exec = bindExecutorDeadline(executor({ readFile: async (_path, opts) => {
      await waitForAbort(opts!.signal!).catch(() => {});
      return "late contents";
    } }), budget);
    try { await expect(exec.readFile("a")).rejects.toBeInstanceOf(DeadlineExceededError); }
    finally { budget.dispose(); }
  });
});
