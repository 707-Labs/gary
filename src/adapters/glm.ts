import type Anthropic from "@anthropic-ai/sdk";
import { log } from "../logger.ts";
import {
  AllProvidersExhaustedError,
  armOnRateLimit,
  isRateLimitError,
  type LLMProvider,
  type ProviderChain,
} from "../providers.ts";
import { UsageLimitError } from "../rate-limit.ts";

const DEFAULT_MAX_TOKENS = 8192;

// SDK 0.32.1 doesn't carry `cache_control` in the GA Messages types — only
// in the beta namespace. The wire format is identical though, and Z.ai /
// Kimi / DeepSeek all honor it on their Anthropic-compatible endpoints
// (verified via scripts/probe-cache.ts). We cast at the boundary instead
// of pulling in a major SDK upgrade.
const EPHEMERAL = { type: "ephemeral" } as const;

type WithCacheControl<T> = T & { cache_control?: { type: "ephemeral" } };

/**
 * Inject cache_control breakpoints so providers cache the static prefix
 * across iterations. Breakpoints land on:
 *   1. End of the system prompt (most stable — voice + project preamble)
 *   2. End of the tool list (stable until phase transitions)
 *   3. End of the last message's last content block (caches the full
 *      conversation prefix — saves the most on long runs)
 *
 * Providers that ignore cache_control silently pay no penalty — the field
 * is treated as a no-op.
 *
 * Exported for tests; not part of the GLMClient surface.
 */
export function withCacheControl(
  args: Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "stream">,
): Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "stream"> {
  const out: Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "stream"> = {
    ...args,
    messages:
      args.messages.length > 0 ? withCacheOnLastMessage(args.messages) : args.messages,
  };

  if (typeof args.system === "string" && args.system.length > 0) {
    out.system = [
      { type: "text", text: args.system, cache_control: EPHEMERAL } as Anthropic.TextBlockParam,
    ];
  } else if (Array.isArray(args.system) && args.system.length > 0) {
    out.system = args.system.map((b, i, arr): Anthropic.TextBlockParam =>
      i === arr.length - 1
        ? ({ ...b, cache_control: EPHEMERAL } as Anthropic.TextBlockParam)
        : b,
    );
  }
  // else: leave args.system as-is (undefined or empty array passes through).

  if (args.tools && args.tools.length > 0) {
    out.tools = args.tools.map((t, i, arr): Anthropic.Tool =>
      i === arr.length - 1
        ? ({ ...t, cache_control: EPHEMERAL } as Anthropic.Tool)
        : t,
    );
  }

  return out;
}

function withCacheOnLastMessage(
  messages: readonly Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out = messages.slice();
  const i = out.length - 1;
  const last = out[i]!;
  if (typeof last.content === "string") {
    out[i] = {
      ...last,
      content: [
        {
          type: "text",
          text: last.content,
          cache_control: EPHEMERAL,
        } as Anthropic.TextBlockParam,
      ],
    };
    return out;
  }
  const blocks = [...last.content];
  const j = blocks.length - 1;
  if (j < 0) return out;
  const tail = blocks[j]!;
  // Cache_control attaches at the block level for any block variant
  // (TextBlock, ToolResultBlock, etc.). The SDK type for 0.32.1 doesn't
  // model it, so widen via `WithCacheControl` and cast back.
  const tagged: WithCacheControl<typeof tail> = { ...tail, cache_control: EPHEMERAL };
  blocks[j] = tagged as typeof tail;
  out[i] = { ...last, content: blocks };
  return out;
}

export interface CompleteArgs {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: readonly string[];
}

/**
 * Multi-provider client. Owns a `ProviderChain` and routes calls through
 * the highest-priority unarmed provider, falling through to the next on
 * 429. The class is still named `GLMClient` to minimize churn in handler
 * dependency types — internally it's no longer GLM-specific.
 *
 * On `RateLimitError`:
 *   - if the body parses to a reset timestamp (Z.ai's `code=1308` shape),
 *     the provider's gate arms until then
 *   - otherwise the gate arms for the provider's `defaultBackoffMs`
 *   - the next call automatically picks the next-priority unarmed provider
 *
 * If every provider is armed, throws `AllProvidersExhaustedError`. The
 * loop's tick-level rate-limit gate translates this into a `UsageLimitError`
 * so the existing skip logic still works.
 */
export class GLMClient {
  readonly chain: ProviderChain;

  constructor(chain: ProviderChain) {
    this.chain = chain;
  }

  /**
   * Active provider for "right now". Throws if every provider is armed.
   * Useful for logging which model authored a given response.
   */
  active(): LLMProvider {
    const p = this.chain.active();
    if (!p) {
      throw new AllProvidersExhaustedError(this.chain.earliestReset());
    }
    return p;
  }

  /**
   * Single-turn text completion (classifier, PR title/body, etc.).
   * Loops through providers on 429.
   */
  async complete(args: CompleteArgs): Promise<string> {
    const response = await this.runWithFallback((provider) =>
      provider.client.messages.create({
        model: provider.model,
        max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        system: args.system,
        messages: [{ role: "user", content: args.user }],
        ...(args.stopSequences ? { stop_sequences: [...args.stopSequences] } : {}),
      }),
    );
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  /**
   * Multi-turn message create — used by the agent loop's tool-calling
   * conversation. Same fallback semantics as `complete`. The active
   * provider's `model` is filled in automatically; callers must NOT pass
   * a model field.
   */
  async createMessage(
    args: Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "stream">,
  ): Promise<Anthropic.Message> {
    const cached = withCacheControl(args);
    return await this.runWithFallback((provider) =>
      provider.client.messages.create({
        ...cached,
        model: provider.model,
      }),
    );
  }

  /**
   * Try the call against successive providers, arming each gate on 429.
   * Throws `AllProvidersExhaustedError` if every provider is armed before
   * we can find one that succeeds.
   *
   * Non-429 errors propagate unchanged; we don't want to mask 5xx or
   * malformed-request errors as if they were caps.
   */
  private async runWithFallback<T>(
    call: (provider: LLMProvider) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    // Bound the loop by the number of providers — once each has had a turn,
    // the chain is exhausted regardless of arming state.
    const max = this.chain.providers.length;
    while (attempt++ < max) {
      const provider = this.chain.active();
      if (!provider) {
        throw new AllProvidersExhaustedError(this.chain.earliestReset());
      }
      try {
        const out = await call(provider);
        if (attempt > 1) {
          log.info("provider fallback succeeded", {
            provider: provider.name,
            attempt,
          });
        }
        return out;
      } catch (err) {
        if (!isRateLimitError(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        armOnRateLimit(provider, message);
        // Loop continues — next iteration picks the next-priority provider.
      }
    }
    throw new AllProvidersExhaustedError(this.chain.earliestReset());
  }
}
