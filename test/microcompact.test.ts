import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  COMPACTABLE_TOOLS,
  TOOL_RESULT_CLEARED,
  microcompactMessages,
} from "../src/agent/microcompact.ts";

function asstToolUse(id: string, name: string): Anthropic.MessageParam {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id, name, input: {} },
    ],
  };
}

function userToolResult(id: string, content: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, content },
    ],
  };
}

describe("microcompactMessages", () => {
  it("returns input unchanged when there are no compactable tool_uses", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = microcompactMessages(messages);
    expect(result.cleared).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("keeps the most recent N compactable tool_results untouched", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(asstToolUse(`t${i}`, "read_file"));
      messages.push(userToolResult(`t${i}`, `contents of file ${i}`));
    }
    const result = microcompactMessages(messages, { keepRecent: 3 });
    expect(result.cleared).toBe(7);

    // First 7 should be cleared, last 3 should be intact
    const userMessages = result.messages.filter((m) => m.role === "user");
    const tr = (i: number) =>
      (userMessages[i]!.content as Anthropic.ToolResultBlockParam[])[0]!.content;
    expect(tr(0)).toBe(TOOL_RESULT_CLEARED);
    expect(tr(6)).toBe(TOOL_RESULT_CLEARED);
    expect(tr(7)).toBe("contents of file 7");
    expect(tr(9)).toBe("contents of file 9");
  });

  it("only clears tool_results from compactable tools", () => {
    const messages: Anthropic.MessageParam[] = [
      asstToolUse("a", "read_file"),
      userToolResult("a", "FILE"),
      asstToolUse("b", "write_file"),
      userToolResult("b", "WROTE"),
      asstToolUse("c", "read_file"),
      userToolResult("c", "FILE2"),
      asstToolUse("d", "read_file"),
      userToolResult("d", "FILE3"),
    ];
    const result = microcompactMessages(messages, { keepRecent: 1 });
    // Only 'a' and 'c' should be cleared; 'b' is non-compactable, 'd' is kept (most recent compactable).
    expect(result.cleared).toBe(2);
    const userMessages = result.messages.filter((m) => m.role === "user");
    const tr = (i: number) =>
      (userMessages[i]!.content as Anthropic.ToolResultBlockParam[])[0]!.content;
    expect(tr(0)).toBe(TOOL_RESULT_CLEARED); // a cleared
    expect(tr(1)).toBe("WROTE"); // b kept (not compactable)
    expect(tr(2)).toBe(TOOL_RESULT_CLEARED); // c cleared
    expect(tr(3)).toBe("FILE3"); // d kept (most recent)
  });

  it("is idempotent — second pass clears nothing more", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(asstToolUse(`t${i}`, "grep"));
      messages.push(userToolResult(`t${i}`, `result ${i}`));
    }
    const first = microcompactMessages(messages, { keepRecent: 3 });
    expect(first.cleared).toBe(5);
    const second = microcompactMessages(first.messages, { keepRecent: 3 });
    expect(second.cleared).toBe(0);
  });

  it("does not mutate the input array", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(asstToolUse(`t${i}`, "run_bash"));
      messages.push(userToolResult(`t${i}`, `result ${i}`));
    }
    const snapshot = JSON.stringify(messages);
    microcompactMessages(messages, { keepRecent: 2 });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("treats keepRecent < 1 as 1 (never clears everything)", () => {
    const messages: Anthropic.MessageParam[] = [
      asstToolUse("a", "read_file"),
      userToolResult("a", "FILE"),
      asstToolUse("b", "read_file"),
      userToolResult("b", "FILE2"),
    ];
    const result = microcompactMessages(messages, { keepRecent: 0 });
    expect(result.cleared).toBe(1);
    const last = result.messages[3]!;
    expect((last.content as Anthropic.ToolResultBlockParam[])[0]!.content).toBe(
      "FILE2",
    );
  });

  it("compactable set covers Gary's noisy tools but not safety-critical ones", () => {
    expect(COMPACTABLE_TOOLS.has("read_file")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("grep")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("run_bash")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("write_file")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("edit_file")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("commit")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("todo_write")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("finish")).toBe(false);
  });
});
