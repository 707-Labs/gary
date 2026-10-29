/**
 * The single paid inference route for new requests: DeepSeek V4.1 Flash served
 * through OpenRouter's Anthropic Messages endpoint. Every host pin (provider
 * config, spend policy, Hermes capabilities, startup checks) reads this.
 */
export const PAID_ROUTE = Object.freeze({
  provider: "openrouter",
  model: "deepseek/deepseek-v4.1-flash",
  /** Anthropic SDK base URL; the SDK appends /v1/messages. */
  baseUrl: "https://openrouter.ai/api",
  url: "https://openrouter.ai/api/v1/messages",
  host: "openrouter.ai",
  apiKeyEnv: "OPENROUTER_API_KEY",
} as const);
export type PaidRouteProvider = typeof PAID_ROUTE.provider;
export type PaidRouteModel = typeof PAID_ROUTE.model;

/**
 * The retired direct DeepSeek route. Only used to recognise settled historical
 * ledger rows, actions and receipts written before the OpenRouter cutover
 * (2026-10-28). No new reservation or request may use it: spend.ts has no
 * price for it, so the guard rejects it as an unpriced provider.
 */
export const LEGACY_DEEPSEEK_ROUTE = Object.freeze({
  provider: "deepseek",
  model: "deepseek-v4-pro",
} as const);
