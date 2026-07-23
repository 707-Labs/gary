import { describe, expect, it } from "bun:test";
import { createPiParser, parsePiJsonl } from "./pi-loop.ts";

// Fixture distilled from a real `pi -p --mode json --approve` run (2026-07-23):
// one bash tool call (echo) followed by a final "done" text turn.
const REAL_RUN = [
  { type: "session", id: "x", cwd: "/tmp" },
  { type: "agent_start" },
  {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "echo hello-from-pi-probe" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    isError: false,
  },
  {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hello-from-pi-probe" } }],
      usage: { input: 12616, output: 24, cacheRead: 0, cacheWrite: 0 },
    },
    toolResults: [{ role: "toolResult", toolCallId: "call_1", isError: false }],
  },
  {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 882, output: 5, cacheRead: 11776, cacheWrite: 0 },
    },
    toolResults: [],
  },
  { type: "agent_end", willRetry: false },
  { type: "agent_settled" },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("parsePiJsonl", () => {
  it("extracts the final assistant text (last text turn wins)", () => {
    expect(parsePiJsonl(REAL_RUN).finalText).toBe("done");
  });

  it("records bash tool calls in runLog with exit derived from isError", () => {
    const { runLog } = parsePiJsonl(REAL_RUN);
    expect(runLog).toHaveLength(1);
    expect(runLog[0]?.cmd).toBe("echo hello-from-pi-probe");
    expect(runLog[0]?.exit).toBe(0);
  });

  it("maps a failed tool result to a non-zero exit", () => {
    const failed = [
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "false" } },
      { type: "tool_execution_end", toolCallId: "c", toolName: "bash", isError: true },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parsePiJsonl(failed).runLog[0]?.exit).toBe(1);
  });

  it("sums token usage across assistant turns only", () => {
    const p = parsePiJsonl(REAL_RUN);
    expect(p.inputTokens).toBe(12616 + 882);
    expect(p.outputTokens).toBe(24 + 5);
    expect(p.cacheReadTokens).toBe(11776);
    expect(p.turns).toBe(2);
  });

  it("reports settled + willRetry from terminal events", () => {
    const p = parsePiJsonl(REAL_RUN);
    expect(p.settled).toBe(true);
    expect(p.willRetry).toBe(false);
  });

  it("tolerates non-JSON noise lines", () => {
    expect(parsePiJsonl("not json\n" + REAL_RUN).finalText).toBe("done");
  });
});

describe("createPiParser (incremental streaming)", () => {
  it("parses identically when the stream is split at arbitrary chunk boundaries", () => {
    const parser = createPiParser();
    // Feed one char at a time — splits every line mid-way — to prove the
    // partial-line buffer reassembles events across chunk boundaries.
    for (const ch of REAL_RUN) parser.push(ch);
    const p = parser.finish();
    expect(p.finalText).toBe("done");
    expect(p.turns).toBe(2);
    expect(p.settled).toBe(true);
    expect(p.runLog).toHaveLength(1);
  });

  it("discards high-volume delta noise without retaining it (the OOM regression)", () => {
    // A real heavy-reasoning run emits tens of MB of thinking/message_update/
    // toolcall_delta events per turn that the parser must drop. Interleave a
    // large burst of them and confirm only the settled events survive.
    const noise = Array.from({ length: 20000 }, (_, i) =>
      JSON.stringify({ type: "thinking", text: `t${i}`.repeat(20) }),
    ).join("\n");
    const parser = createPiParser();
    parser.push(noise + "\n");
    parser.push(REAL_RUN);
    const p = parser.finish();
    expect(p.finalText).toBe("done");
    expect(p.turns).toBe(2);
    expect(p.runLog).toHaveLength(1);
  });

  it("flushes a trailing line with no terminating newline", () => {
    const parser = createPiParser();
    const noNewline = REAL_RUN; // REAL_RUN has no trailing "\n"
    parser.push(noNewline);
    expect(parser.finish().settled).toBe(true);
  });
});
