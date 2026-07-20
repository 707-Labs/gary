import type Anthropic from "@anthropic-ai/sdk";
import type { GLMClient } from "../adapters/glm.ts";
import type { Executor } from "../executors/index.ts";
import { log } from "../logger.ts";
import { AllProvidersExhaustedError } from "../providers.ts";
import {
  recordReviewPass,
  type ReviewVerdict as PersistedVerdict,
} from "../state/review-queries.ts";
import type { DB } from "../state/db.ts";
import type { RunLogEntry } from "../agent/loop.ts";
import type { RuleDoc } from "../skills.ts";
import type { PrecheckFinding } from "./precheck.ts";
import {
  composeReviewerSystemPrompt,
  renderReviewTask,
  type ReviewTaskTicket,
  type PreviousFinding,
} from "./prompts.ts";
import {
  makeReviewerToolset,
  type ReviewerTools,
  type SubmittedReview,
} from "./tools.ts";

export type ReviewerResult =
  | { kind: "verdict"; review: SubmittedReview }
  | { kind: "failed"; reason: string };

export interface RunReviewerArgs {
  db: DB;
  glm: GLMClient;
  executor: Executor;
  ticket: ReviewTaskTicket;
  issueLinearId: string;
  fingerprint: string;
  round: number;
  diff: string;
  runLog: readonly RunLogEntry[];
  precheckFindings: readonly PrecheckFinding[];
  previousFindings: readonly PreviousFinding[];
  worktreePath: string;
  ruleDocs?: readonly RuleDoc[];
  iterationCap: number;
  timeoutMs: number;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 8192;

export async function runReviewer(args: RunReviewerArgs): Promise<ReviewerResult> {
  const start = Date.now();
  const tools = makeReviewerToolset(args.executor);
  const system = composeReviewerSystemPrompt();
  const task = renderReviewTask({
    ticket: args.ticket,
    diff: args.diff,
    runLog: args.runLog,
    precheckFindings: args.precheckFindings,
    previousFindings: args.previousFindings,
    worktreePath: args.worktreePath,
    ...(args.ruleDocs ? { ruleDocs: args.ruleDocs } : {}),
  });

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const deadline = start + args.timeoutMs;
  let providerName: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let failureReason: string | null = null;
  // One-shot recovery: if the reviewer ends a turn without calling
  // submit_review (e.g. wrote a verdict in prose), nudge once and continue
  // before declaring no_submit_review. Avoids silently default-approving on
  // a recoverable miss.
  let promptedToSubmit = false;

  // Inject a forcing nudge near the iteration cap so a wandering reviewer
  // commits a verdict instead of running out of turns. Mirrors the primary
  // agent loop's nudge mechanic (DEFAULT_NUDGE in src/agent/loop.ts).
  const nudgeAt = Math.max(1, Math.floor(args.iterationCap * 0.8));
  let nudgeFired = false;

  let iteration = 0;
  while (iteration < args.iterationCap) {
    if (Date.now() > deadline) {
      failureReason = "timeout";
      break;
    }
    if (!nudgeFired && iteration + 1 === nudgeAt) {
      messages.push({
        role: "user",
        content: `you have ${args.iterationCap - iteration} turns left. call submit_review on your next turn. if you don't have a specific, defensible blocking bug, approve — false positives waste cycles. don't start new investigation lines.`,
      });
      nudgeFired = true;
      log.info("reviewer nudge", {
        ticket: args.ticket.identifier,
        round: args.round,
        iter: iteration + 1,
        cap: args.iterationCap,
      });
    }
    iteration++;
    let response: Anthropic.Message;
    const remainingMs = deadline - Date.now();
    const timeoutSentinel = Symbol("timeout");
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) =>
      setTimeout(() => resolve(timeoutSentinel), remainingMs),
    );
    try {
      const raceResult = await Promise.race([
        args.glm.createMessage({
          max_tokens: DEFAULT_MAX_TOKENS,
          temperature: DEFAULT_TEMPERATURE,
          system,
          tools: tools.definitions,
          messages,
        }),
        timeoutPromise,
      ]);
      if (raceResult === timeoutSentinel) {
        failureReason = "timeout";
        break;
      }
      response = raceResult as Anthropic.Message;
    } catch (err) {
      if (err instanceof AllProvidersExhaustedError) {
        failureReason = "providers_exhausted";
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error("reviewer agent error", {
        ticket: args.ticket.identifier,
        round: args.round,
        iteration,
        error: msg,
      });
      failureReason = `agent_error: ${msg}`;
      break;
    }

    // Record the provider that actually served, not the chain's first
    // entry — fallback mid-review means those can differ. Last writer
    // wins; a mid-round fallback records the provider that finished.
    providerName = args.glm.lastProviderUsed() ?? providerName;
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason === "max_tokens") {
        failureReason = "max_tokens";
        break;
      }
      if (response.stop_reason === "end_turn" && !promptedToSubmit) {
        promptedToSubmit = true;
        log.warn("reviewer ended turn without submit_review; nudging", {
          ticket: args.ticket.identifier,
          round: args.round,
          iteration,
        });
        messages.push({
          role: "user",
          content:
            "you didn't call submit_review. you must call the submit_review tool with your verdict — do not respond in prose. if you don't have a specific, defensible blocking bug, approve.",
        });
        continue;
      }
      failureReason = `no_submit_review:${response.stop_reason ?? "null"}`;
      break;
    }

    const toolCalls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolCalls) {
      const handler = tools.handlers[call.name];
      if (!handler) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `error: unknown tool ${call.name}`,
          is_error: true,
        });
        continue;
      }
      try {
        const text = await handler.run(call.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: text,
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `error: ${m}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
    if (tools.review) break;
  }

  const durationMs = Date.now() - start;

  if (tools.review) {
    persist({
      db: args.db,
      args,
      tools,
      providerName,
      inputTokens,
      outputTokens,
      durationMs,
      verdict: tools.review.verdict,
      escalated: false,
    });
    return { kind: "verdict", review: tools.review };
  }

  const reason = failureReason ?? "iteration_cap";
  log.warn("reviewer pass did not complete", {
    ticket: args.ticket.identifier,
    round: args.round,
    reason,
  });
  persist({
    db: args.db,
    args,
    tools,
    providerName,
    inputTokens,
    outputTokens,
    durationMs,
    verdict: "failed",
    escalated: false,
  });
  return { kind: "failed", reason };
}

function persist(p: {
  db: DB;
  args: RunReviewerArgs;
  tools: ReviewerTools;
  providerName: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  verdict: PersistedVerdict;
  escalated: boolean;
}): void {
  recordReviewPass(p.db, {
    issueLinearId: p.args.issueLinearId,
    fingerprint: p.args.fingerprint,
    round: p.args.round,
    verdict: p.verdict,
    findingCount: p.tools.review?.findings.length ?? 0,
    advisoryCount: p.tools.review?.advisoryNotes.length ?? 0,
    providerUsed: p.providerName,
    inputTokens: p.inputTokens === 0 ? null : p.inputTokens,
    outputTokens: p.outputTokens === 0 ? null : p.outputTokens,
    durationMs: p.durationMs,
    escalated: p.escalated,
  });
}
