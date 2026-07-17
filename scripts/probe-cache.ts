// Verify whether each provider in the production chain honors Anthropic-style
// prompt caching. We send the same large system prompt twice — if the
// provider supports caching, the second call should report nonzero
// `cache_read_input_tokens` (and a much smaller `input_tokens`).
//
// Run on the mini (where all three API keys live):
//   ssh mini 'cd ~/Developer/gary && bun run scripts/probe-cache.ts'

import Anthropic from "@anthropic-ai/sdk";

interface ProbeTarget {
  name: string;
  baseURL: string;
  model: string;
  apiKeyEnv: string;
}

const targets: ProbeTarget[] = [
  {
    name: "z.ai",
    baseURL: "https://api.z.ai/api/anthropic",
    model: "glm-5.2",
    apiKeyEnv: "Z_AI_API_KEY",
  },
  {
    name: "kimi",
    baseURL: "https://api.kimi.com/coding",
    model: "kimi-for-coding",
    apiKeyEnv: "KIMI_API_KEY",
  },
  {
    name: "deepseek",
    baseURL: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
];

// Anthropic's caching minimum is ~1024 tokens; we go well above that to
// give every provider a real chance to cache. Repeating filler text is fine
// — token count is what matters for the threshold.
const FILLER_LINE =
  "This is contextual information meant to push the system prompt above the prompt-cache threshold. The static prefix should be reused on the second call.";
const STATIC_SYSTEM_TEXT =
  "You are a precise assistant.\n\n" + Array(60).fill(FILLER_LINE).join("\n");
// Confirm the prefix is large enough to bother caching. ~80 chars/line × 60 ≈ 4800 chars ≈ ~1200 tokens.

interface UsageWithCache {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

async function probeOne(t: ProbeTarget): Promise<void> {
  const key = process.env[t.apiKeyEnv];
  console.log(`\n=== ${t.name} (${t.model}) ===`);
  if (!key) {
    console.log(`  SKIP — ${t.apiKeyEnv} not set`);
    return;
  }
  const client = new Anthropic({ authToken: key, baseURL: t.baseURL });

  // Use the array-form `system` so we can attach a cache_control breakpoint
  // to the static prefix block. Anthropic-compatible providers that support
  // caching honor this; ones that don't will silently ignore the field.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: STATIC_SYSTEM_TEXT,
      // SDK 0.32.1 lacks cache_control in the GA types; cast around it.
      cache_control: { type: "ephemeral" },
    } as Anthropic.TextBlockParam,
    { type: "text", text: "Answer in under 10 words." },
  ];

  for (const i of [1, 2]) {
    const t0 = Date.now();
    try {
      const resp = await client.messages.create({
        model: t.model,
        max_tokens: 32,
        temperature: 0,
        system,
        messages: [{ role: "user", content: "What is 2+2?" }],
      });
      const u = resp.usage as unknown as UsageWithCache;
      console.log(
        `  call ${i}: ${Date.now() - t0}ms  input=${u.input_tokens}  output=${u.output_tokens}  cache_create=${u.cache_creation_input_tokens ?? "—"}  cache_read=${u.cache_read_input_tokens ?? "—"}`,
      );
    } catch (err) {
      console.log(
        `  call ${i}: ERROR — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

for (const t of targets) {
  await probeOne(t);
}

console.log(
  "\nlooking for: cache_read > 0 on call 2 indicates the provider honored the cache_control breakpoint.",
);
