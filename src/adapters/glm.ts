import Anthropic from "@anthropic-ai/sdk";
import type { GLMConfig } from "../config.ts";

export type AnthropicClient = Anthropic;

const DEFAULT_MAX_TOKENS = 8192;

export interface CompleteArgs {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: readonly string[];
}

/**
 * Thin wrapper around the Anthropic SDK pointed at Z.ai. Owns model defaults
 * and exposes the underlying client so the agent loop can drive multi-turn
 * tool-use messages without re-implementing the SDK.
 */
export class GLMClient {
  readonly client: AnthropicClient;
  readonly model: string;

  constructor(cfg: GLMConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
    });
    this.model = cfg.model;
  }

  /** Single-turn text completion. Classifier uses this. */
  async complete(args: CompleteArgs): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      ...(args.stopSequences ? { stop_sequences: [...args.stopSequences] } : {}),
    });

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
}
