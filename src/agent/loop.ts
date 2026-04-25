import type Anthropic from "@anthropic-ai/sdk";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type { GitHubClient } from "../adapters/github.ts";
import type { GLMClient } from "../adapters/glm.ts";
import type { LinearAdapter } from "../adapters/linear.ts";
import type { Executor } from "../executors/index.ts";
import { log } from "../logger.ts";
import { AllProvidersExhaustedError } from "../providers.ts";
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
  /** Total input tokens used (sum across turns) — excludes cached reads. */
  inputTokens: number;
  /** Total output tokens used (sum across turns). */
  outputTokens: number;
  /** Tokens written to the prompt cache across turns (~1.25× billable). */
  cacheCreationTokens: number;
  /** Tokens read from the prompt cache across turns (~0.10× billable). */
  cacheReadTokens: number;
  /** Phase the loop ended in (or "single" when no phases were configured). */
  phase: string;
}

/**
 * One stage of a phased agent loop. Phases let us (a) restrict tools to a
 * read-only subset early on so the model investigates before writing, and
 * (b) inject a forcing nudge near the iteration cap so a stuck model
 * commits partial progress instead of being killed mid-stream.
 *
 * Phases run sequentially. A phase ends when the model produces a turn
 * with `stop_reason !== "tool_use"` (voluntary) or the per-phase iteration
 * cap is hit (forced). The next phase, if any, opens with `entryMessage`
 * appended to the conversation. The final phase resolves to `finished` /
 * `no_finish` / `iteration_cap` as in the legacy loop.
 */
export interface PhaseSpec {
  name: string;
  maxIter: number;
  /**
   * If set, only tool definitions whose `name` appears here are advertised
   * to the model AND only those names are dispatched on tool_use. A call to
   * a name not in the set returns a phase-aware error string. Undefined =
   * no restriction.
   */
  allowedTools?: ReadonlySet<string>;
  /**
   * User message appended at the start of the phase (skipped on phase 0
   * since the original task message serves that role). Used to coach the
   * model through the transition — e.g. "now write your plan and
   * implement it."
   */
  entryMessage?: string;
  /**
   * User message appended once at iter `floor(maxIter * 0.8)` to nudge a
   * stuck model toward wrapping up. Skipped if undefined.
   */
  nudgeMessage?: string;
}

export interface AgentLoopArgs {
  glm: GLMClient;
  executor: Executor;
  systemPrompt: string;
  task: string;
  /**
   * Iteration cap when `phases` is not provided. Ignored when `phases` is
   * set — each phase has its own `maxIter`. Kept for backwards-compat with
   * non-code handlers.
   */
  maxIterations: number;
  timeoutMs: number;
  /**
   * Optional sequence of phases. When omitted, the loop runs as a single
   * phase using `maxIterations` and the default global nudge. Provided by
   * the code handler to enforce investigate → implement.
   */
  phases?: readonly PhaseSpec[];
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
  /** If provided (with defaultRepo), the toolset includes `get_pr`. */
  github?: GitHubClient;
  /** Default "owner/repo" for `get_pr` when called without a repo arg. */
  defaultRepo?: string;
  /**
   * If set, `finish` is rejected until this exact command runs via run_bash
   * with exit 0 at least once. Used by the code handler to enforce that
   * the model verifies its work before claiming done.
   */
  finishGateCommand?: string;
}

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 8192;

const DEFAULT_NUDGE =
  "you're approaching the iteration cap. wrap up: commit what you have, then call finish() with a brief summary (or a partial-progress note if you're stuck).";

/** Append `text` as a user message, merging into the last user message if
 * the conversation already ends in one (Anthropic disallows consecutive
 * same-role turns). */
function appendUserText(
  messages: Anthropic.MessageParam[],
  text: string,
): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) {
    last.content.push({ type: "text", text });
    return;
  }
  if (last && last.role === "user" && typeof last.content === "string") {
    messages[messages.length - 1] = {
      role: "user",
      content: `${last.content}\n\n${text}`,
    };
    return;
  }
  messages.push({ role: "user", content: text });
}

/**
 * Drives a tool-calling conversation with GLM through one or more phases
 * until the model calls finish, we hit the iteration cap of the final
 * phase, or the wall-clock timeout fires.
 *
 * Phases are optional. Without `phases`, the loop runs as a single phase
 * using `maxIterations` (legacy behavior) with a default cap nudge fired
 * at 80%. With `phases`, each phase has its own iteration cap, optional
 * tool restriction, and optional nudge — and a non-final phase ends by
 * voluntary stop or cap and rolls forward into the next phase with its
 * `entryMessage` injected into the conversation.
 */
export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const toolsetOpts: ToolsetOptions = {};
  if (args.cloudflare) toolsetOpts.cloudflare = args.cloudflare;
  if (args.linear) toolsetOpts.linear = args.linear;
  if (args.github) toolsetOpts.github = args.github;
  if (args.defaultRepo) toolsetOpts.defaultRepo = args.defaultRepo;
  if (args.finishGateCommand) toolsetOpts.finishGateCommand = args.finishGateCommand;
  const tools = makeToolset(args.executor, toolsetOpts);
  const start = Date.now();
  const deadline = start + args.timeoutMs;

  const phases: readonly PhaseSpec[] = args.phases ?? [
    {
      name: "single",
      maxIter: args.maxIterations,
      nudgeMessage: DEFAULT_NUDGE,
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.task },
  ];

  let totalIterations = 0;
  const usage = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  };
  let lastPhaseName = phases[0]?.name ?? "single";

  const done = (
    status: AgentLoopStatus,
    summary: string | null,
    phase: string,
    errorMessage?: string,
  ): AgentLoopResult => {
    const base: AgentLoopResult = {
      status,
      summary,
      iterations: totalIterations,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheCreationTokens: usage.cacheCreation,
      cacheReadTokens: usage.cacheRead,
      phase,
    };
    return errorMessage !== undefined ? { ...base, errorMessage } : base;
  };

  for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
    const phase = phases[phaseIdx]!;
    const isLastPhase = phaseIdx === phases.length - 1;
    lastPhaseName = phase.name;

    if (phase.entryMessage && phaseIdx > 0) {
      appendUserText(messages, phase.entryMessage);
    }

    const phaseDefs = phase.allowedTools
      ? tools.definitions.filter((d) => phase.allowedTools!.has(d.name))
      : tools.definitions;
    const nudgeAt = phase.nudgeMessage
      ? Math.max(1, Math.floor(phase.maxIter * 0.8))
      : -1;

    let phaseIter = 0;
    let nudgeFired = false;
    let phaseEndedVoluntarily = false;

    while (phaseIter < phase.maxIter) {
      if (args.signal?.aborted) {
        return done("error", null, phase.name, "aborted");
      }
      if (Date.now() > deadline) {
        return done("timeout", null, phase.name);
      }

      if (!nudgeFired && phaseIter + 1 === nudgeAt && phase.nudgeMessage) {
        appendUserText(messages, phase.nudgeMessage);
        nudgeFired = true;
        log.info("agent loop nudge", {
          phase: phase.name,
          iter: phaseIter + 1,
          maxIter: phase.maxIter,
        });
      }

      phaseIter++;
      totalIterations++;

      let response: Anthropic.Message;
      try {
        response = await args.glm.createMessage({
          max_tokens: args.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS,
          temperature: args.temperature ?? DEFAULT_TEMPERATURE,
          system: args.systemPrompt,
          tools: phaseDefs,
          messages,
        });
      } catch (err) {
        // Per-provider 429s are handled inside `glm.createMessage` (it falls
        // through to the next provider). The only rate-limit case that
        // reaches here is "every provider is armed" — propagate so the tick
        // can record the skip without bouncing the ticket.
        if (err instanceof AllProvidersExhaustedError) {
          log.warn("agent loop: all providers armed; will back off", {
            phase: phase.name,
            iteration: totalIterations,
            earliestReset: err.earliestReset?.toISOString() ?? null,
          });
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error("agent loop API error", {
          phase: phase.name,
          iteration: totalIterations,
          error: message,
        });
        return done("error", null, phase.name, message);
      }

      // SDK 0.32.1 doesn't model the cache fields on Usage; they ship in the
      // wire format and our providers populate them. Widen via cast.
      const u = response.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      usage.input += u.input_tokens;
      usage.output += u.output_tokens;
      usage.cacheCreation += u.cache_creation_input_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;

      log.debug("agent turn", {
        phase: phase.name,
        iteration: totalIterations,
        stopReason: response.stop_reason,
        blocks: response.content.length,
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        if (tools.finishSummary !== null) {
          return done("finished", tools.finishSummary, phase.name);
        }
        // Voluntary phase exit. If there's a next phase, transition; if
        // this was the last phase, the model wrapped up without calling
        // finish — that's no_finish (existing behavior).
        if (isLastPhase) {
          return done("no_finish", null, phase.name);
        }
        phaseEndedVoluntarily = true;
        break;
      }

      const toolCalls = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (toolCalls.length === 0) {
        // Defensive: shouldn't happen given stop_reason === "tool_use".
        return done("no_finish", null, phase.name);
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolCalls) {
        toolResults.push(await executTool(tools, call, phase));
      }
      messages.push({ role: "user", content: toolResults });

      if (tools.finishSummary !== null) {
        return done("finished", tools.finishSummary, phase.name);
      }
    }

    if (phaseEndedVoluntarily) {
      log.info("phase complete (voluntary)", {
        phase: phase.name,
        iter: phaseIter,
      });
      continue;
    }

    // Hit phase cap. If this is the last phase, that's iteration_cap.
    // Otherwise log and roll into the next phase — the entry message is
    // injected at the top of the next iteration.
    if (isLastPhase) {
      return done("iteration_cap", null, phase.name);
    }
    log.info("phase complete (cap reached)", {
      phase: phase.name,
      iter: phaseIter,
      maxIter: phase.maxIter,
    });
  }

  // All phases exhausted without a return path — should be unreachable
  // since the final phase always returns. Defensive default.
  return done("no_finish", null, lastPhaseName);
}

async function executTool(
  tools: AgentTools,
  call: Anthropic.ToolUseBlock,
  phase: PhaseSpec,
): Promise<Anthropic.ToolResultBlockParam> {
  // Phase-aware rejection: even if the model hallucinates a tool not
  // advertised this phase, refuse it with an instructive error so the
  // model can adapt instead of getting an opaque "unknown tool".
  if (phase.allowedTools && !phase.allowedTools.has(call.name)) {
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `error: tool '${call.name}' is not available in the '${phase.name}' phase. ${
        phase.name === "investigate"
          ? "use read-only tools (read_file, grep, list_files, fetch_url, get_linear_issue, get_pr) to explore. when you're ready to plan and write code, end your turn without tool calls and you'll move to the implement phase."
          : "use only the advertised tools."
      }`,
      is_error: true,
    };
  }
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

