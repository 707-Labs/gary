import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { GLMClient } from "../src/adapters/glm.ts";
import type { DeadlineOptions } from "../src/deadline.ts";
import type { Executor } from "../src/executors/index.ts";
import { createProviderChain, type LLMProvider } from "../src/providers.ts";
import { createRateLimitGate } from "../src/rate-limit.ts";
import { runReviewer } from "../src/review/runner.ts";

function approve(): Anthropic.Message {
  return {
    id: "offline-approve", type: "message", role: "assistant", model: "offline-model",
    content: [{ type: "tool_use", id: "review", name: "submit_review", input: {
      verdict: "approve", findings: [], advisory_notes: [], verification_report: "Offline fixture only.",
    } }],
    stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}

function unusedExecutor(): Executor {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected executor call in model deadline test"); };
  return { workspaceRoot: "/offline-fixture", readFile: unexpected, writeFile: unexpected,
    listFiles: unexpected, grep: unexpected, run: unexpected };
}

describe("reviewer shared deadlines", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:", { create: true, strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../src/state/schema.sql", import.meta.url), "utf8"));
    db.query("INSERT INTO tickets (linear_id, identifier) VALUES ('offline-issue', 'TEST-1')").run();
  });
  afterEach(() => db.close());

  function args(glm: GLMClient) {
    return {
      db, glm, executor: unusedExecutor(),
      ticket: { identifier: "TEST-1", title: "offline fixture", description: null },
      issueLinearId: "offline-issue", fingerprint: "offline-fingerprint", round: 1,
      diff: "offline diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/offline-fixture", iterationCap: 3, timeoutMs: 1_000,
    };
  }

  function expectFailedRow() {
    const rows = db.query<{ verdict: string; finding_count: number; advisory_count: number }, []>(
      "SELECT verdict, finding_count, advisory_count FROM review_passes",
    ).all();
    expect(rows).toEqual([{ verdict: "failed", finding_count: 0, advisory_count: 0 }]);
  }

  it("propagates the shorter parent deadline to the SDK and settles the cancelled request before returning", async () => {
    let signal: AbortSignal | undefined;
    let onAbort: (() => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let aborted = false;
    let sdkCalls = 0;
    let maxRetries: number | undefined;
    const provider: LLMProvider = {
      name: "deepseek", model: "offline-model", gate: createRateLimitGate(),
      defaultBackoffMs: 1_000, parse429: () => null,
      client: { messages: { create: async (_body: unknown, options: { signal?: AbortSignal; maxRetries?: number }) => {
        sdkCalls++;
        signal = options.signal;
        maxRetries = options.maxRetries;
        pending = true;
        return new Promise<Anthropic.Message>((resolve, reject) => {
          const cleanup = () => {
            pending = false;
            if (watchdog !== undefined) clearTimeout(watchdog);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
          };
          onAbort = () => { aborted = true; cleanup(); reject(signal?.reason); };
          watchdog = setTimeout(() => { cleanup(); resolve(approve()); }, 500);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      } } } as unknown as Anthropic,
    };
    try {
      const result = await runReviewer({ ...args(new GLMClient(createProviderChain([provider]))), deadlineMs: Date.now() + 50 });
      expect(result).toEqual({ kind: "failed", reason: "timeout" });
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(aborted).toBe(true);
      expect(pending).toBe(false);
      expect(sdkCalls).toBe(1);
      expect(maxRetries).toBe(0);
      expectFailedRow();
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  });

  it("rejects a late approve from an adapter and persists failure instead of the verdict", async () => {
    let signal: AbortSignal | undefined;
    let onAbort: (() => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let deliveredApprove = false;
    const glm = {
      async createMessage(_body: unknown, options: DeadlineOptions): Promise<Anthropic.Message> {
        signal = options.signal;
        return new Promise((resolve) => {
          onAbort = () => {
            if (watchdog !== undefined) clearTimeout(watchdog);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
            // The adapter has stopped; a buffered response wins its abort
            // race. The reviewer must independently reject that late verdict.
            deliveredApprove = true;
            resolve(approve());
          };
          watchdog = setTimeout(onAbort, 500);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
      chain: { providers: [{ name: "deepseek", model: "offline-model" }] },
    } as unknown as GLMClient;
    try {
      const result = await runReviewer({ ...args(glm), timeoutMs: 50 });
      expect(deliveredApprove).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(result).toEqual({ kind: "failed", reason: "timeout" });
      expectFailedRow();
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  });

  it("persists an externally cancelled pending call as aborted", async () => {
    const parent = new AbortController();
    let pending = false;
    let signal: AbortSignal | undefined;
    let onAbort: (() => void) | undefined;
    const glm = {
      async createMessage(_body: unknown, options: DeadlineOptions): Promise<Anthropic.Message> {
        signal = options.signal;
        pending = true;
        return new Promise((_resolve, reject) => {
          onAbort = () => {
            pending = false;
            if (onAbort) signal?.removeEventListener("abort", onAbort);
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          queueMicrotask(() => parent.abort(new Error("offline caller cancelled")));
        });
      },
      chain: { providers: [{ name: "deepseek", model: "offline-model" }] },
    } as unknown as GLMClient;
    try {
      const result = await runReviewer({ ...args(glm), signal: parent.signal });
      expect(result).toEqual({ kind: "failed", reason: "aborted" });
      expect(signal?.aborted).toBe(true);
      expect(pending).toBe(false);
      expectFailedRow();
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  });
});
