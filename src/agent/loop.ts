import type Anthropic from "@anthropic-ai/sdk";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type { GLMClient } from "../adapters/glm.ts";
import type { LinearAdapter } from "../adapters/linear.ts";
import type { Executor } from "../executors/index.ts";
import { log } from "../logger.ts";
import { type AgentTools, type ToolsetOptions, makeToolset } from "./tools.ts";

export type AgentLoopStatus =
  | "finished"
  | "iteration_cap"
  | "timeout"
  | "no_finish"
  | "error";

export interface AgentLoopResult {
  status: AgentLoopStatus;
  summary: string | null;
  iterations: number;
  errorMessage?: string;
  /** Total input tokens used (sum across turns). */
  inputTokens: number;
  /** Total output tokens used (sum across turns). */
  outputTokens: number;
}

export interface AgentLoopArgs {
  glm: GLMClient;
  executor: Executor;
  systemPrompt: string;
  task: string;
  maxIterations: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Per-turn temperature. Spec defaults to 0.3 for coding. */
  temperature?: number;
  /** Per-turn max_tokens. Spec defaults to 8192. */
  maxTokensPerTurn?: number;
  /**
   * If provided, the toolset includes Cloudflare Workers Observability tools
   * (`query_cloudflare_logs`, `list_cloudflare_invocations`).
   */
  cloudflare?: CloudflareClient;
  /** If provided, the toolset includes `get_linear_issue`. */
  linear?: LinearAdapter;
}

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Drives a tool-calling conversation with GLM until the model calls finish,
 * we hit the iteration cap, or the wall-clock timeout fires.
 *
 * The CODE handler constructs an Executor (LocalExecutor for Weekend 1,
 * DockerExecutor later), wires the toolset against it, and calls this.
 */
export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const toolsetOpts: ToolsetOptions = {};
  if (args.cloudflare) toolsetOpts.cloudflare = args.cloudflare;
  if (args.linear) toolsetOpts.linear = args.linear;
  const tools = makeToolset(args.executor, toolsetOpts);
  const start = Date.now();
  const deadline = start + args.timeoutMs;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.task },
  ];

  let iterations = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  while (iterations < args.maxIterations) {
    if (args.signal?.aborted) {
      return done("error", null, iterations, inputTokens, outputTokens, "aborted");
    }
    if (Date.now() > deadline) {
      return done("timeout", null, iterations, inputTokens, outputTokens);
    }
    iterations++;

    let response: Anthropic.Message;
    try {
      response = await args.glm.client.messages.create({
        model: args.glm.model,
        max_tokens: args.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS,
        temperature: args.temperature ?? DEFAULT_TEMPERATURE,
        system: args.systemPrompt,
        tools: tools.definitions,
        messages,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("agent loop API error", { iteration: iterations, error: message });
      return done("error", null, iterations, inputTokens, outputTokens, message);
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    log.debug("agent turn", {
      iteration: iterations,
      stopReason: response.stop_reason,
      blocks: response.content.length,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      // Model ended without calling finish. Treat as failure unless finish
      // was somehow set (won't happen unless the model both finished and
      // emitted a closing turn, which is fine).
      if (tools.finishSummary !== null) {
        return done(
          "finished",
          tools.finishSummary,
          iterations,
          inputTokens,
          outputTokens,
        );
      }
      return done("no_finish", null, iterations, inputTokens, outputTokens);
    }

    const toolCalls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolCalls.length === 0) {
      // Defensive: shouldn't happen given stop_reason === "tool_use".
      return done("no_finish", null, iterations, inputTokens, outputTokens);
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolCalls) {
      toolResults.push(await executTool(tools, call));
    }
    messages.push({ role: "user", content: toolResults });

    if (tools.finishSummary !== null) {
      return done(
        "finished",
        tools.finishSummary,
        iterations,
        inputTokens,
        outputTokens,
      );
    }
  }

  return done("iteration_cap", null, iterations, inputTokens, outputTokens);
}

async function executTool(
  tools: AgentTools,
  call: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  const handler = tools.handlers[call.name];
  if (!handler) {
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `error: unknown tool ${call.name}`,
      is_error: true,
    };
  }
  try {
    const text = await handler.run(call.input);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: text,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `error: ${msg}`,
      is_error: true,
    };
  }
}

function done(
  status: AgentLoopStatus,
  summary: string | null,
  iterations: number,
  inputTokens: number,
  outputTokens: number,
  errorMessage?: string,
): AgentLoopResult {
  return errorMessage !== undefined
    ? { status, summary, iterations, inputTokens, outputTokens, errorMessage }
    : { status, summary, iterations, inputTokens, outputTokens };
}
