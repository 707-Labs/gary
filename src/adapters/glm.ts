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
    return await this.runWithFallback((provider) =>
      provider.client.messages.create({
        ...args,
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
