// Smoke test for the GLM adapter. Verifies that the Anthropic SDK pointed at
// Z.ai's endpoint can:
//   1. Complete a basic chat (text in / text out)
//   2. Use tools (the agent loop relies on this)
//
// Run with: bun run scripts/probe-glm.ts

import type Anthropic from "@anthropic-ai/sdk";
import { GLMClient } from "../src/adapters/glm.ts";
import { loadGLMConfig } from "../src/config.ts";

const cfg = loadGLMConfig();
const glm = new GLMClient(cfg);

console.log(`baseURL: ${cfg.baseUrl}`);
console.log(`model:   ${cfg.model}`);

console.log(`\n--- basic chat ---`);
const text = await glm.complete({
  system: "You are a curt assistant. Answer in five words or fewer.",
  user: "What is the capital of France?",
  temperature: 0,
  maxTokens: 64,
});
console.log(`response: ${text}`);

console.log(`\n--- tool use ---`);
const toolResult = await glm.client.messages.create({
  model: glm.model,
  max_tokens: 256,
  temperature: 0,
  system: "You are an assistant with a calculator tool. Use it.",
  tools: [
    {
      name: "add",
      description: "Add two numbers",
      input_schema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
    } satisfies Anthropic.Tool,
  ],
  messages: [{ role: "user", content: "What is 137 + 286? Use the tool." }],
});

const toolCalls = toolResult.content.filter(
  (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
);
const textBlocks = toolResult.content.filter(
  (b): b is Anthropic.TextBlock => b.type === "text",
);

console.log(`stop_reason:    ${toolResult.stop_reason}`);
console.log(`text blocks:    ${textBlocks.length}`);
for (const b of textBlocks) console.log(`  ${b.text}`);
console.log(`tool_use calls: ${toolCalls.length}`);
for (const c of toolCalls) {
  console.log(`  ${c.name}(${JSON.stringify(c.input)})`);
}

if (toolCalls.length === 0) {
  console.error(
    "\n!! GLM did not emit a tool_use block. Tool support is required for the agent loop.",
  );
  process.exit(1);
}

console.log(`\nusage: input=${toolResult.usage.input_tokens} output=${toolResult.usage.output_tokens}`);
console.log(`\nprobe ok.`);
