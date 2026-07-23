import { spawn } from "node:child_process";
import { writeFile, access, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
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
/**
 * Allowlist of pi tools for a Gary coding run: the read/write/exec primitives
 * plus the read-only search helpers (off by default, so named explicitly).
 * Deliberately excludes extension tools like `workflow` (nested agent fleets)
 * and `ask_question` (blocks a headless run). Override via GARY_PI_TOOLS.
 */
const PI_CODING_TOOLS = process.env.GARY_PI_TOOLS ?? "read,bash,edit,write,grep,find,ls";

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
 * Incremental JSONL parser for pi's `--mode json` stream. Event shapes verified
 * against a real `--approve` run (2026-07-23):
 * - bash command:  `tool_execution_start` { toolCallId, toolName:"bash", args:{command} }
 * - bash result:   `tool_execution_end`   { toolCallId, isError }   (no exit code)
 * - text + usage:  `turn_end`             { message:{ role, content:[{type:"text",text}], usage } }
 * - completion:    `agent_end` { willRetry }, then `agent_settled`
 *
 * CRITICAL: a real multi-turn run on a heavy-reasoning model emits tens of MB
 * *per turn* of streaming `thinking`/`message_update`/`toolcall_delta` events —
 * ~99.9% of the stream — none of which this parser needs. So we MUST parse
 * incrementally and retain only the settled accumulator, never buffer the raw
 * stdout. Buffering the whole stream into one growing string is O(n^2) and
 * eventually exceeds V8's ~512MB max string length, throwing `RangeError`
 * mid-run (observed as `status=error iter=0` on the daemon). Feed chunks via
 * `push()`; call `finish()` to flush the trailing partial line.
 */
export interface PiParser {
  push(chunk: string): void;
  finish(): ParsedRun;
}

export function createPiParser(): PiParser {
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
  // Buffer only the current incomplete line; complete lines are parsed and
  // discarded so memory stays O(retained events), not O(total output).
  let buf = "";

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return; // non-JSON noise; skip
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
          if (id) pendingCmds.delete(id); // don't retain finished calls
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
  };

  return {
    push(chunk: string): void {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        processLine(line);
        idx = buf.indexOf("\n");
      }
    },
    finish(): ParsedRun {
      if (buf) {
        processLine(buf);
        buf = "";
      }
      return out;
    },
  };
}

/** Convenience wrapper: parse a complete JSONL string in one shot. */
export function parsePiJsonl(stdout: string): ParsedRun {
  const parser = createPiParser();
  parser.push(stdout);
  return parser.finish();
}

export async function runPiLoop(args: PiLoopArgs): Promise<AgentLoopResult> {
  // Write the prompt OUTSIDE the worktree: a file inside it shows up in
  // `git status`, trips `bun run ci` (Prettier), and would be swept into the
  // PR by Gary's `git add -A` commit step. pi reads it by absolute `@path`.
  const promptPath = resolve(
    tmpdir(),
    `gary-pi-task-${basename(args.worktreePath)}-${process.pid}.md`,
  );
  await writeFile(promptPath, buildPrompt(args), "utf8");
  const cleanupPrompt = () => {
    void rm(promptPath, { force: true }).catch(() => {});
  };

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
    // Restrict pi to core coding primitives. Left unrestricted, gpt-5.6-sol on
    // a real ticket escalates to its `workflow` extension tool — spawning a
    // nested multi-agent fleet that never returns inside Gary's time budget
    // (observed: one workflow tool call ran the full timeout, 0 turns settled).
    // Gary wants pi to code directly in-worktree, not orchestrate a sub-fleet,
    // and this also excludes input-blocking tools (ask_question) that would
    // hang a headless run. grep/find/ls are off-by-default, so name them.
    "--tools",
    PI_CODING_TOOLS,
    "--append-system-prompt",
    args.systemPrompt,
    `@${promptPath}`,
  ];

  // When set, tee raw pi stdout/stderr to files so a zero-output/error run can
  // be diagnosed after the fact (the parsed result discards everything pi did
  // not emit as clean JSONL). Best-effort; never let logging break the run.
  const debugDir = process.env.GARY_PI_DEBUG_DIR;
  const debugStamp = process.env.GARY_PI_DEBUG_STAMP ?? "run";
  const teeRaw = (stream: "stdout" | "stderr", chunk: string) => {
    if (!debugDir) return;
    try {
      appendFileSync(resolve(debugDir, `pi-${debugStamp}.${stream}`), chunk);
    } catch {
      /* diagnostic only */
    }
  };

  return new Promise<AgentLoopResult>((res) => {
    // Stream-parse stdout: retain only the settled accumulator, never the raw
    // stream (a real run emits tens of MB/turn of deltas this parser discards).
    const parser = createPiParser();
    // Bounded stderr tail for error messages — cap so a chatty run can't OOM.
    let stderrTail = "";
    const STDERR_CAP = 8192;
    if (debugDir) {
      try {
        appendFileSync(
          resolve(debugDir, `pi-${debugStamp}.argv`),
          JSON.stringify({ bin: PI_BIN, args: piArgs, cwd: args.worktreePath }, null, 2),
        );
      } catch {
        /* diagnostic only */
      }
    }
    const child = spawn(PI_BIN, piArgs, {
      cwd: args.worktreePath,
      env: { ...process.env },
      signal: controller.signal,
      // stdin MUST be ignored: with node's default pipe, `pi -p` blocks on an
      // open stdin and emits nothing until the timeout aborts it (surfaced as
      // a ~15-min no-op stall on the daemon during the first supervised run).
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c) => {
      const s = c.toString();
      parser.push(s);
      teeRaw("stdout", s);
    });
    child.stderr.on("data", (c) => {
      const s = c.toString();
      stderrTail = (stderrTail + s).slice(-STDERR_CAP);
      teeRaw("stderr", s);
    });

    // Both "error" and "exit" can fire for one run (aborting a spawned child
    // emits an AbortError *and* then exits); resolve exactly once.
    let done = false;
    const finish = (result: AgentLoopResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanupPrompt();
      res(result);
    };

    child.on("error", (err) => {
      // An abort (timeout / caller signal) surfaces here as an AbortError, but
      // that's not a spawn failure — the process ran and was killed. Let the
      // "exit" handler map it to status:"timeout" with the parsed partials.
      // Only a genuine pre-run spawn error (e.g. ENOENT) has no matching exit.
      if (controller.signal.aborted) return;
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
      const parsed = parser.finish();
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
          errorMessage: code !== 0 ? `pi exited ${code}: ${stderrTail.slice(-500)}` : "pi did not settle",
        });
      } else {
        finish({ ...base, status: "finished" });
      }
    });
  });
}
