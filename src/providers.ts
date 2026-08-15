import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";
import { type RateLimitGate, createRateLimitGate } from "./rate-limit.ts";

/**
 * Identifiers for the LLM providers Gary speaks to. The order in
 * `DEFAULT_CHAIN_ORDER` mirrors the fallback priority: Z.ai is the primary
 * (cheapest, default), Kimi Code is the first fallback (subscription cap),
 * DeepSeek is the final fallback (no usage cap as of 2026-04-25).
 */
export type ProviderName = "z.ai" | "kimi" | "deepseek";

export const DEFAULT_CHAIN_ORDER: readonly ProviderName[] = [
  "z.ai",
  "kimi",
  "deepseek",
];

export interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Default backoff applied when the provider 429s but `parse429` can't
   * extract a reset timestamp from the response body. Z.ai includes the
   * timestamp inline; Kimi/DeepSeek shapes are TBD.
   */
  defaultBackoffMs: number;
}

export type AnthropicClient = Anthropic;

export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  readonly client: AnthropicClient;
  readonly gate: RateLimitGate;
  /** Default backoff when the 429 body has no parseable reset timestamp. */
  readonly defaultBackoffMs: number;
  /** Returns reset Date if the message matches a known cap pattern, else null. */
  parse429(message: string): Date | null;
}

/**
 * Z.ai's 5-hour cap returns:
 *   429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-04-25 15:43:26"}}
 * The reset timestamp is server time. Z.ai's docs and observed behavior treat
 * it as UTC. If they're ever off by a timezone we wait too long (safe).
 */
const ZAI_USAGE_LIMIT_PATTERN =
  /Usage limit reached[^"]*?reset at\s+(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/i;

export function parseZAi429(message: string): Date | null {
  const m = message.match(ZAI_USAGE_LIMIT_PATTERN);
  if (!m || !m[1] || !m[2]) return null;
  const iso = `${m[1]}T${m[2]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Kimi Code 429 shape is undocumented as of 2026-04-25. Best-effort: try to
 * recognize a generic ISO-style timestamp in the body; otherwise return null
 * so the chain falls back to defaultBackoffMs.
 */
export function parseKimi429(message: string): Date | null {
  // Permissive: match either "reset at YYYY-MM-DD HH:MM:SS" or a bare ISO
  // 8601 timestamp, since we don't yet know Kimi Code's exact phrasing.
  const m =
    message.match(/reset(?:[^"\d]+)(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/i) ??
    message.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (!m) return null;
  const iso = m[2] ? `${m[1]}T${m[2]}Z` : m[1];
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** DeepSeek has no usage cap as of 2026-04-25 — only per-minute limits. */
export function parseDeepSeek429(_message: string): Date | null {
  return null;
}

const PARSERS: Record<ProviderName, (m: string) => Date | null> = {
  "z.ai": parseZAi429,
  kimi: parseKimi429,
  deepseek: parseDeepSeek429,
};

export interface CreateProviderOpts {
  /**
   * Optional fetch override. Useful for tests; the SDK uses the global fetch
   * when omitted.
   */
  fetch?: typeof fetch;
}

export function createProvider(
  cfg: ProviderConfig,
  opts: CreateProviderOpts = {},
): LLMProvider {
  // All three providers (Z.ai, Kimi Code, DeepSeek) want
  // `Authorization: Bearer <key>` rather than the SDK default `x-api-key`.
  // Using `authToken` flips the header.
  const client = new Anthropic({
    authToken: cfg.apiKey,
    baseURL: cfg.baseUrl,
    ...(opts.fetch ? { fetch: opts.fetch as unknown as typeof fetch } : {}),
  });
  return {
    name: cfg.name,
    model: cfg.model,
    client,
    gate: createRateLimitGate(),
    defaultBackoffMs: cfg.defaultBackoffMs,
    parse429: PARSERS[cfg.name],
  };
}

export interface ProviderChain {
  /** All configured providers, primary first. */
  readonly providers: readonly LLMProvider[];
  /** The highest-priority provider whose gate is currently unarmed, or null. */
  active(now?: Date): LLMProvider | null;
  /** True iff every provider is armed. */
  allArmed(now?: Date): boolean;
  /** Earliest reset across all armed providers, or null if any are unarmed. */
  earliestReset(now?: Date): Date | null;
}

export function createProviderChain(
  providers: readonly LLMProvider[],
): ProviderChain {
  if (providers.length === 0) {
    throw new Error("createProviderChain requires at least one provider");
  }
  return {
    providers,
    active(now = new Date()) {
      return providers.find((p) => !p.gate.isArmed(now)) ?? null;
    },
    allArmed(now = new Date()) {
      return providers.every((p) => p.gate.isArmed(now));
    },
    earliestReset(now = new Date()) {
      if (!providers.every((p) => p.gate.isArmed(now))) return null;
      const dates = providers
        .map((p) => p.gate.armedUntil())
        .filter((d): d is Date => d !== null);
      if (dates.length === 0) return null;
      return new Date(Math.min(...dates.map((d) => d.getTime())));
    },
  };
}

/**
 * Build a chain rooted at `primary`, with the rest of `canonical`'s
 * providers following in their original order. Used by the loop to dispatch
 * concurrent slots against different primaries — each slot gets its own
 * chain so one slot's 429 doesn't cascade into a primary swap that the
 * other slots are already using. All slots share the same provider objects
 * (and their gates), so a 429 on Z.ai arms it globally regardless of which
 * slot saw it.
 */
export function chainStartingWith(
  canonical: ProviderChain,
  primary: LLMProvider,
): ProviderChain {
  if (!canonical.providers.includes(primary)) {
    throw new Error(
      `chainStartingWith: provider ${primary.name} not in canonical chain`,
    );
  }
  const others = canonical.providers.filter((p) => p !== primary);
  return createProviderChain([primary, ...others]);
}

/**
 * Build a chain in `requested` order, with any canonical providers not
 * mentioned in `requested` appended at the end in their canonical order.
 * Names in `requested` that aren't in the canonical chain are silently
 * dropped — keeps reviewer config robust to typos in env vars (you'll
 * still get a working chain, just not the one you typed).
 *
 * Use this for the reviewer's chain so it prefers a different provider
 * than primary, giving uncorrelated blind spots.
 */
export function chainWithOrder(
  canonical: ProviderChain,
  requested: readonly ProviderName[],
): ProviderChain {
  const byName = new Map(canonical.providers.map((p) => [p.name, p]));
  const ordered: LLMProvider[] = [];
  const used = new Set<ProviderName>();
  for (const name of requested) {
    const p = byName.get(name);
    if (p && !used.has(name)) {
      ordered.push(p);
      used.add(name);
    }
  }
  for (const p of canonical.providers) {
    if (!used.has(p.name)) {
      ordered.push(p);
    }
  }
  return createProviderChain(ordered);
}

export class AllProvidersExhaustedError extends Error {
  readonly earliestReset: Date | null;
  constructor(earliestReset: Date | null) {
    super(
      earliestReset
        ? `all LLM providers rate-limited; earliest resets at ${earliestReset.toISOString()}`
        : "all LLM providers rate-limited",
    );
    this.name = "AllProvidersExhaustedError";
    this.earliestReset = earliestReset;
  }
}

/**
 * Detect a 429 response from an Anthropic SDK error. The SDK exposes a
 * RateLimitError class for status 429 — we rely on the `status` field
 * because instanceof checks across multiple imports of the SDK are
 * fragile.
 *
 * Some providers (e.g. Kimi) return 403 or 402 instead of 429 for
 * usage-limit / insufficient-balance errors. We treat those as rate limits
 * so the chain falls through to the next provider rather than crashing.
 */
export function isRateLimitError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: unknown }).status;
  if (status === 429) return true;
  if (status === 402) return true;
  if (status === 403) {
    const msg =
      typeof err === "object" && err !== null && "message" in err
        ? String((err as { message?: unknown }).message)
        : String(err);
    return /usage limit|quota|permission_error|billing cycle|insufficient balance/i.test(
      msg,
    );
  }
  return false;
}

/**
 * Arm the provider's gate following a 429. Uses the provider's parser if it
 * extracts a timestamp; otherwise uses defaultBackoffMs from now. Logs at
 * warn level so a sudden burst of cap activity is visible in stdout.
 */
export function armOnRateLimit(
  provider: LLMProvider,
  message: string,
): Date {
  const parsed = provider.parse429(message);
  const resetAt =
    parsed ?? new Date(Date.now() + provider.defaultBackoffMs);
  provider.gate.armUntil(resetAt);
  log.warn("provider rate-limited; gate armed", {
    provider: provider.name,
    resetAt: resetAt.toISOString(),
    parsed: parsed !== null,
  });
  return resetAt;
}
