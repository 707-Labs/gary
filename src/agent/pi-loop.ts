import { spawn } from "node:child_process";
import { writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentLoopResult, RunLogEntry } from "./loop.ts";

/**
 * Alternative coding engine: delegate the implementation step to the `pi`
 * harness (frontier model + plan/scout/impl/validate subagents) instead of
 * Gary's in-process GLM loop. Motivation: `iteration_cap` is 81% of Gary's
 * escalations and only 1/35 cap-hit tickets ever completed — a weak-model-in-
 * a-flat-loop failure. pi one-shot ERT-1574 (Gary capped it twice). See
 * docs/pi-integration-plan.md.
 *
 * This is a drop-in for `runAgentLoop`: same result contract. pi manages its
 * own iteration, tools, and verification inside the worktree, so Gary's
 * `phases`/`executor`/tool wiring are intentionally NOT reused here.
 */

const PI_BIN = process.env.GARY_PI_BIN ?? "pi";
const PI_AUTH = resolve(homedir(), ".pi/agent/auth.json");

export interface PiLoopArgs {
  /** Absolute path to the ticket worktree pi runs inside. */
  worktreePath: string;
  /** "provider/model[:thinking]" pattern, e.g. openai-codex/gpt-5.6-sol. */
  model: string;
  /** System prompt appended to pi's own coding base prompt. */
  systemPrompt: string;
  /** The task/ticket instruction. */
  task: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * If set, pi is told this command MUST pass (exit 0) before it finishes —
   * the equivalent of runAgentLoop's finishGateCommand. pi self-verifies.
   */
  finishGateCommand?: string;
}

/**
 * Preflight: pi must be runnable and authenticated, else the caller should
 * fall back to the GLM loop. A pi outage must degrade Gary, not halt it.
 */
export async function piAvailable(): Promise<boolean> {
  try {
    await access(PI_AUTH);
  } catch {
    return false;
  }
  return new Promise((res) => {
    const child = spawn(PI_BIN, ["--version"], { stdio: "ignore" });
    child.on("error", () => res(false));
    child.on("exit", (code) => res(code === 0));
  });
}

function buildPrompt(args: PiLoopArgs): string {
  const gate = args.finishGateCommand
    ? `\n\n## Verification gate\nBefore you finish, you MUST run \`${args.finishGateCommand}\` and it must exit 0. Do not claim completion otherwise.`
    : "";
  return `${args.task}${gate}\n\nDo not commit, push, open a PR, or deploy. Leave changes in the working tree.`;
}

/**
 * Parse pi's `--mode json` output. It is JSONL (one event per line):
 * session → agent_start → turn_start → message_* → turn_end → agent_end →
 * agent_settled. We capture the final assistant text, sum token usage per
 * turn_end, extract bash tool calls for runLog, and read willRetry.
 */
export interface ParsedRun {
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Count of assistant model turns (each `turn_end` with an assistant msg). */
  turns: number;
  runLog: RunLogEntry[];
  settled: boolean;
  willRetry: boolean;
}

/**
 * Parse pi's `--mode json` JSONL. Event shapes verified against a real
 * `--approve` run (2026-07-23):
 * - bash command:  `tool_execution_start` { toolCallId, toolName:"bash", args:{command} }
 * - bash result:   `tool_execution_end`   { toolCallId, isError }   (no exit code)
 * - text + usage:  `turn_end`             { message:{ role, content:[{type:"text",text}], usage } }
 * - completion:    `agent_end` { willRetry }, then `agent_settled`
 * We ignore streaming `message_update` deltas and read only the settled events.
 */
export function parsePiJsonl(stdout: string): ParsedRun {
  const out: ParsedRun = {
    finalText: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    runLog: [],
    settled: false,
    willRetry: false,
  };
  // toolCallId -> command, populated on tool_execution_start, finalized on end.
  const pendingCmds = new Map<string, string>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // non-JSON noise; skip
    }

    switch (ev.type) {
      case "tool_execution_start": {
        if (ev.toolName === "bash") {
          const id = ev.toolCallId as string | undefined;
          const cmd = (ev.args as { command?: string } | undefined)?.command;
          if (id && cmd) pendingCmds.set(id, cmd);
        }
        break;
      }
      case "tool_execution_end": {
        const id = ev.toolCallId as string | undefined;
        const cmd = id ? pendingCmds.get(id) : undefined;
        if (cmd !== undefined) {
          out.runLog.push({ cmd, exit: ev.isError === true ? 1 : 0, ts: Date.now() });
        }
        break;
      }
      case "turn_end": {
        const msg = ev.message as
          | {
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
              usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
            }
          | undefined;
        if (msg?.role !== "assistant") break; // toolResult turns carry no usage
        out.turns += 1;
        const u = msg.usage;
        if (u) {
          out.inputTokens += u.input ?? 0;
          out.outputTokens += u.output ?? 0;
          out.cacheReadTokens += u.cacheRead ?? 0;
          out.cacheCreationTokens += u.cacheWrite ?? 0;
        }
        const text = (msg.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
        if (text) out.finalText = text; // last assistant text turn wins
        break;
      }
      case "agent_end":
        out.willRetry = ev.willRetry === true;
        break;
      case "agent_settled":
        out.settled = true;
        break;
    }
  }
  return out;
}

export async function runPiLoop(args: PiLoopArgs): Promise<AgentLoopResult> {
  const promptPath = resolve(args.worktreePath, ".gary-pi-task.md");
  await writeFile(promptPath, buildPrompt(args), "utf8");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), args.timeoutMs);
  args.signal?.addEventListener("abort", () => controller.abort("signal"));

  const piArgs = [
    "-p",
    "--mode",
    "json",
    "--model",
    args.model,
    "--approve",
    "--append-system-prompt",
    args.systemPrompt,
    `@${promptPath}`,
  ];

  return new Promise<AgentLoopResult>((res) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(PI_BIN, piArgs, {
      cwd: args.worktreePath,
      env: { ...process.env },
      signal: controller.signal,
      // stdin MUST be ignored: with node's default pipe, `pi -p` blocks on an
      // open stdin and emits nothing until the timeout aborts it (surfaced as
      // a ~15-min no-op stall on the daemon during the first supervised run).
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));

    const finish = (result: AgentLoopResult) => {
      clearTimeout(timer);
      res(result);
    };

    child.on("error", (err) => {
      finish({
        status: "error",
        summary: null,
        iterations: 0,
        errorMessage: `pi spawn failed: ${err.message}`,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        phase: "pi",
        runLog: [],
      });
    });

    child.on("exit", (code) => {
      const aborted = controller.signal.aborted;
      const parsed = parsePiJsonl(stdout);
      const base = {
        summary: parsed.finalText || null,
        iterations: parsed.turns,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        phase: "pi" as const,
        runLog: parsed.runLog,
      };
      if (aborted) {
        finish({ ...base, status: "timeout", errorMessage: String(controller.signal.reason) });
      } else if (code !== 0 || !parsed.settled) {
        finish({
          ...base,
          status: parsed.finalText ? "no_finish" : "error",
          errorMessage: code !== 0 ? `pi exited ${code}: ${stderr.slice(-500)}` : "pi did not settle",
        });
      } else {
        finish({ ...base, status: "finished" });
      }
    });
  });
}
