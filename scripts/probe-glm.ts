// Smoke test for the Z.ai (GLM) provider in isolation. Verifies that the
// Anthropic SDK pointed at Z.ai's endpoint can:
//   1. Complete a basic chat (text in / text out)
//   2. Use tools (the agent loop relies on this)
//
// Mirrors probe-kimi.ts and probe-deepseek.ts. Talks directly to the SDK
// rather than going through GLMClient/the chain so a Z.ai-specific failure
// doesn't get masked by fallback to another provider.
//
// Run with: bun run scripts/probe-glm.ts

import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.Z_AI_API_KEY;
if (!apiKey) {
  console.error("Z_AI_API_KEY not set");
  process.exit(1);
}

const baseURL = process.env.Z_AI_BASE_URL ?? "https://api.z.ai/api/anthropic";
const model = process.env.Z_AI_MODEL ?? "glm-4.6";

// Z.ai accepts both x-api-key and Authorization: Bearer; using authToken so
// the probe matches the production GLMClient header shape.
const client = new Anthropic({ authToken: apiKey, baseURL });

console.log(`baseURL: ${baseURL}`);
console.log(`model:   ${model}`);

console.log(`\n--- basic chat ---`);
const text = await client.messages.create({
  model,
  max_tokens: 64,
  temperature: 0,
  system: "You are a curt assistant. Answer in five words or fewer.",
  messages: [{ role: "user", content: "What is the capital of France?" }],
});
const textBlocks = text.content.filter(
  (b): b is Anthropic.TextBlock => b.type === "text",
);
console.log(`response: ${textBlocks.map((b) => b.text).join(" ")}`);

console.log(`\n--- tool use ---`);
const toolResult = await client.messages.create({
  model,
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
const toolText = toolResult.content.filter(
  (b): b is Anthropic.TextBlock => b.type === "text",
);

console.log(`stop_reason:    ${toolResult.stop_reason}`);
console.log(`text blocks:    ${toolText.length}`);
for (const b of toolText) console.log(`  ${b.text}`);
console.log(`tool_use calls: ${toolCalls.length}`);
for (const c of toolCalls) {
  console.log(`  ${c.name}(${JSON.stringify(c.input)})`);
}

if (toolCalls.length === 0) {
  console.error(
    "\n!! Z.ai did not emit a tool_use block. Tool support is required for the agent loop.",
  );
  process.exit(1);
}

console.log(`\nusage: input=${toolResult.usage.input_tokens} output=${toolResult.usage.output_tokens}`);
console.log(`\nprobe ok.`);
