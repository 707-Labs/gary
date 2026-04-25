import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { GLMClient } from "../src/adapters/glm.ts";
import { type PhaseSpec, runAgentLoop } from "../src/agent/loop.ts";
import type { Executor, ExecResult, GrepMatch } from "../src/executors/index.ts";

/** Minimal fake GLM that hands back scripted message responses turn by turn. */
function fakeGlm(
  responses: Array<(messages: readonly Anthropic.MessageParam[], tools: readonly Anthropic.Tool[]) => Anthropic.Message>,
): GLMClient & { calls: number; lastTools: readonly Anthropic.Tool[]; lastMessages: readonly Anthropic.MessageParam[] } {
  let calls = 0;
  let lastTools: readonly Anthropic.Tool[] = [];
  let lastMessages: readonly Anthropic.MessageParam[] = [];
  const glm = {
    async createMessage(args: {
      tools?: readonly Anthropic.Tool[];
      messages: readonly Anthropic.MessageParam[];
    }): Promise<Anthropic.Message> {
      const i = calls++;
      lastTools = args.tools ?? [];
      lastMessages = args.messages;
      const make = responses[i];
      if (!make) throw new Error(`no scripted response for call ${i}`);
      return make(args.messages, args.tools ?? []);
    },
    get calls() {
      return calls;
    },
    get lastTools() {
      return lastTools;
    },
    get lastMessages() {
      return lastMessages;
    },
  } as unknown as GLMClient & {
    calls: number;
    lastTools: readonly Anthropic.Tool[];
    lastMessages: readonly Anthropic.MessageParam[];
  };
  return glm;
}

function fakeExecutor(): Executor {
  return {
    workspaceRoot: "/tmp/fake",
    async readFile() {
      return "fake file contents";
    },
    async writeFile() {},
    async listFiles(): Promise<string[]> {
      return [];
    },
    async grep(): Promise<GrepMatch[]> {
      return [];
    },
    async run(): Promise<ExecResult> {
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  };
}

// SDK's Usage type shape varies across minor versions (cache fields come
// and go); cast around the literal to avoid a brittle compile-time check.
const STANDARD_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
} as unknown as Anthropic.Usage;

function turnWithToolUse(
  toolName: string,
  input: Record<string, unknown>,
): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "fake",
    content: [
      {
        type: "tool_use",
        id: `tu_${Math.random().toString(36).slice(2)}`,
        name: toolName,
        input,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: STANDARD_USAGE,
  } as Anthropic.Message;
}

function turnWithEndTurn(text: string): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "fake",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: STANDARD_USAGE,
  } as Anthropic.Message;
}

describe("runAgentLoop — phased mode", () => {
  it("filters tools advertised to the model in the investigate phase", async () => {
    const phases: PhaseSpec[] = [
      {
        name: "investigate",
        maxIter: 5,
        allowedTools: new Set(["read_file", "grep", "list_files"]),
      },
      { name: "implement", maxIter: 5 },
    ];
    // Investigate: model reads a file once then ends its turn (voluntary
    // transition). Implement: model calls finish().
    const glm = fakeGlm([
      () => turnWithToolUse("read_file", { path: "x.ts" }),
      () => turnWithEndTurn("done exploring"),
      (_msgs, _tools) =>
        turnWithToolUse("finish", { summary: "shipped" }),
    ]);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "",
      task: "do the thing",
      maxIterations: 100,
      timeoutMs: 60_000,
      phases,
    });
    expect(result.status).toBe("finished");
    expect(result.summary).toBe("shipped");
    expect(result.phase).toBe("implement");
    // The toolset advertised on the FINAL call (implement phase, finish turn)
    // must include `finish`; investigate's earlier calls must not.
    expect(glm.lastTools.map((t) => t.name)).toContain("finish");
  });

  it("rejects a write_file call attempted in the investigate phase", async () => {
    const phases: PhaseSpec[] = [
      {
        name: "investigate",
        maxIter: 5,
        allowedTools: new Set(["read_file"]),
      },
      { name: "implement", maxIter: 5 },
    ];
    // Model misbehaves: tries write_file in investigate. The dispatch
    // should return an is_error tool result (model sees the error and
    // adapts on the next turn → here it ends).
    const glm = fakeGlm([
      () =>
        turnWithToolUse("write_file", { path: "x.ts", content: "..." }),
      () => turnWithEndTurn("ok, exploring instead"),
      () => turnWithToolUse("finish", { summary: "done" }),
    ]);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "",
      task: "task",
      maxIterations: 100,
      timeoutMs: 60_000,
      phases,
    });
    expect(result.status).toBe("finished");
    // Look for the rejection text in the messages we captured. The third
    // call's messages include the tool_result the model received from the
    // rejected write_file call.
    const seen = JSON.stringify(glm.lastMessages);
    expect(seen).toMatch(/not available in the 'investigate' phase/);
  });

  it("injects the entryMessage when transitioning to a non-first phase", async () => {
    const phases: PhaseSpec[] = [
      {
        name: "investigate",
        maxIter: 5,
        allowedTools: new Set(["read_file"]),
      },
      {
        name: "implement",
        maxIter: 5,
        entryMessage: "ENTRY-MARKER-XYZ",
      },
    ];
    let secondCallSawEntry = false;
    const glm = fakeGlm([
      () => turnWithEndTurn("done exploring early"),
      (msgs) => {
        secondCallSawEntry = JSON.stringify(msgs).includes("ENTRY-MARKER-XYZ");
        return turnWithToolUse("finish", { summary: "done" });
      },
    ]);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "",
      task: "task",
      maxIterations: 100,
      timeoutMs: 60_000,
      phases,
    });
    expect(result.status).toBe("finished");
    expect(secondCallSawEntry).toBe(true);
  });

  it("fires the cap nudge at floor(maxIter * 0.8)", async () => {
    // maxIter=5, nudge at iter 4. We need 4 turns before the nudge fires;
    // the nudge is appended to the conversation BEFORE turn 4 is sent. So
    // the 4th request is the first one that should see the nudge text.
    let turn4SawNudge = false;
    const responses = [
      () => turnWithToolUse("read_file", { path: "1.ts" }),
      () => turnWithToolUse("read_file", { path: "2.ts" }),
      () => turnWithToolUse("read_file", { path: "3.ts" }),
      (msgs: readonly Anthropic.MessageParam[]) => {
        turn4SawNudge = JSON.stringify(msgs).includes("WRAP-UP-NUDGE");
        return turnWithToolUse("finish", { summary: "done" });
      },
    ];
    const glm = fakeGlm(responses);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "",
      task: "task",
      maxIterations: 5,
      timeoutMs: 60_000,
      phases: [
        {
          name: "single",
          maxIter: 5,
          nudgeMessage: "WRAP-UP-NUDGE",
        },
      ],
    });
    expect(result.status).toBe("finished");
    expect(turn4SawNudge).toBe(true);
  });

  it("rolls forward to the next phase when investigate hits its iter cap", async () => {
    const phases: PhaseSpec[] = [
      {
        name: "investigate",
        maxIter: 2,
        allowedTools: new Set(["read_file"]),
      },
      {
        name: "implement",
        maxIter: 5,
        entryMessage: "TRANSITION-MARKER",
      },
    ];
    let implementSawTransition = false;
    const glm = fakeGlm([
      () => turnWithToolUse("read_file", { path: "1.ts" }),
      () => turnWithToolUse("read_file", { path: "2.ts" }),
      (msgs) => {
        implementSawTransition = JSON.stringify(msgs).includes(
          "TRANSITION-MARKER",
        );
        return turnWithToolUse("finish", { summary: "done" });
      },
    ]);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "",
      task: "task",
      maxIterations: 100,
      timeoutMs: 60_000,
      phases,
    });
    expect(result.status).toBe("finished");
    expect(implementSawTransition).toBe(true);
    expect(result.iterations).toBe(3);
  });

  it("returns iteration_cap when the LAST phase exhausts", async () => {
    const phases: PhaseSpec[] = [
      { name: "implement", maxIter: 2 },
    ];
    const glm = fakeGlm([
      () => turnWithToolUse("read_file", { path: "1.ts" }),
      () => turnWithToolUse("read_file", { path: "2.ts" }),
    ]);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "",
      task: "task",
      maxIterations: 100,
      timeoutMs: 60_000,
      phases,
    });
    expect(result.status).toBe("iteration_cap");
    expect(result.phase).toBe("implement");
    expect(result.iterations).toBe(2);
  });
});

describe("runAgentLoop — legacy single-phase mode", () => {
  it("runs without phases and reports phase='single'", async () => {
    const glm = fakeGlm([
      () => turnWithToolUse("finish", { summary: "ok" }),
    ]);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "",
      task: "task",
      maxIterations: 5,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe("finished");
    expect(result.phase).toBe("single");
  });
});
