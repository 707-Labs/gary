import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { withCacheControl } from "../src/adapters/glm.ts";

// The GA SDK types in 0.32.1 don't carry cache_control; the wrapper casts at
// the boundary. Tests use loose typing on the way out so the property is
// observable.
type AnyBlock = { type: string; cache_control?: { type: "ephemeral" } } & Record<
  string,
  unknown
>;

describe("withCacheControl", () => {
  it("converts a string system prompt to array form with cache_control", () => {
    const result = withCacheControl({
      max_tokens: 100,
      system: "you are an assistant",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(Array.isArray(result.system)).toBe(true);
    const blocks = result.system as unknown as AnyBlock[];
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0]?.text).toBe("you are an assistant");
  });

  it("attaches cache_control to the LAST block of an array system", () => {
    const result = withCacheControl({
      max_tokens: 100,
      system: [
        { type: "text", text: "block 1" },
        { type: "text", text: "block 2" },
      ] as Anthropic.TextBlockParam[],
      messages: [{ role: "user", content: "hi" }],
    });
    const blocks = result.system as unknown as AnyBlock[];
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves an empty/undefined system alone", () => {
    const r1 = withCacheControl({
      max_tokens: 100,
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r1.system).toBe("");
    const r2 = withCacheControl({
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r2.system).toBeUndefined();
  });

  it("attaches cache_control to the LAST tool definition", () => {
    const result = withCacheControl({
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "a", description: "", input_schema: { type: "object" } },
        { name: "b", description: "", input_schema: { type: "object" } },
        { name: "c", description: "", input_schema: { type: "object" } },
      ] as Anthropic.Tool[],
    });
    const tools = result.tools as unknown as AnyBlock[];
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toBeUndefined();
    expect(tools[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("upgrades a string-content user message and tags its single text block", () => {
    const result = withCacheControl({
      max_tokens: 100,
      messages: [{ role: "user", content: "the task" }],
    });
    const last = result.messages[0]!;
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as unknown as AnyBlock[];
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toBe("the task");
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("tags the last block of an array-content message and leaves earlier blocks alone", () => {
    const result = withCacheControl({
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ] as Anthropic.TextBlockParam[],
        },
      ],
    });
    const blocks = result.messages[0]!.content as unknown as AnyBlock[];
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("only tags the FINAL message (mid-conversation messages stay untagged)", () => {
    const result = withCacheControl({
      max_tokens: 100,
      messages: [
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "follow-up" },
      ] as Anthropic.MessageParam[],
    });
    const m0 = result.messages[0]!;
    const m1 = result.messages[1]!;
    const m2 = result.messages[2]!;
    // m0 was a string; left untouched.
    expect(typeof m0.content).toBe("string");
    // m1 is mid-conversation, no cache_control on its block.
    expect((m1.content as unknown as AnyBlock[])[0]?.cache_control).toBeUndefined();
    // m2 is the last message; its block is tagged.
    const lastBlocks = m2.content as unknown as AnyBlock[];
    expect(lastBlocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not mutate the input args", () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];
    const tools: Anthropic.Tool[] = [
      { name: "t", description: "", input_schema: { type: "object" } },
    ];
    const args = { max_tokens: 100, system: "s", tools, messages };
    const result = withCacheControl(args);
    // Inputs untouched
    expect(args.system).toBe("s");
    expect(args.tools).toBe(tools);
    expect(args.messages).toBe(messages);
    expect(args.messages[0]!.content).toBe("x");
    // Outputs are new structures
    expect(result.tools).not.toBe(tools);
    expect(result.messages).not.toBe(messages);
  });
});
