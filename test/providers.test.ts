import { describe, expect, it } from "bun:test";
import {
  AllProvidersExhaustedError,
  armOnRateLimit,
  chainStartingWith,
  chainWithOrder,
  createProvider,
  createProviderChain,
  isRateLimitError,
  type AnthropicClient,
  type LLMProvider,
  type ProviderName,
  parseOpenRouter429,
} from "../src/providers.ts";
import { createRateLimitGate } from "../src/rate-limit.ts";

/**
 * The chain machinery is generic over provider names. ProviderName is now just
 * "openrouter", so these tests use distinct fake names (cast) to exercise
 * ordering, gates and rotation across more than one provider.
 */
function namedProvider(name: string, parse429: (m: string) => Date | null = () => null): LLMProvider {
  return {
    name: name as ProviderName,
    model: `${name}-model`,
    client: {} as AnthropicClient,
    gate: createRateLimitGate(),
    defaultBackoffMs: 60_000,
    parse429,
  };
}

describe("parseOpenRouter429", () => {
  it("always returns null (no documented usage cap)", () => {
    expect(parseOpenRouter429("anything")).toBeNull();
  });
});

describe("createProvider", () => {
  it("attaches the OpenRouter parser", () => {
    const ds = createProvider({
      name: "openrouter",
      apiKey: "x",
      baseUrl: "https://example",
      model: "m",
      defaultBackoffMs: 1000,
    });
    expect(ds.parse429("any message")).toBeNull();
  });
});

describe("ProviderChain", () => {
  it("active() returns the first unarmed provider", () => {
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const c = namedProvider("openrouter");
    const chain = createProviderChain([a, b, c]);
    expect(chain.active()?.name as string).toBe("primary");
    a.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.active()?.name as string).toBe("secondary");
    b.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.active()?.name as string).toBe("openrouter");
  });

  it("active() returns null when all providers are armed", () => {
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const chain = createProviderChain([a, b]);
    a.gate.armUntil(new Date(Date.now() + 60_000));
    b.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.active()).toBeNull();
    expect(chain.allArmed()).toBe(true);
  });

  it("earliestReset() returns null when any provider is unarmed", () => {
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const chain = createProviderChain([a, b]);
    a.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.earliestReset()).toBeNull();
  });

  it("earliestReset() returns the soonest reset when all are armed", () => {
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const chain = createProviderChain([a, b]);
    const sooner = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 600_000);
    a.gate.armUntil(later);
    b.gate.armUntil(sooner);
    expect(chain.earliestReset()?.getTime()).toBe(sooner.getTime());
  });

  it("requires at least one provider", () => {
    expect(() => createProviderChain([])).toThrow();
  });
});

describe("chainStartingWith", () => {
  it("rotates the canonical chain so primary leads", () => {
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const c = namedProvider("openrouter");
    const canonical = createProviderChain([a, b, c]);
    const rotated = chainStartingWith(canonical, b);
    expect(rotated.providers.map((p) => p.name as string)).toEqual([
      "secondary",
      "primary",
      "openrouter",
    ]);
  });

  it("preserves canonical order for non-primary providers", () => {
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const c = namedProvider("openrouter");
    const canonical = createProviderChain([a, b, c]);
    const rotated = chainStartingWith(canonical, c);
    expect(rotated.providers.map((p) => p.name as string)).toEqual([
      "openrouter",
      "primary",
      "secondary",
    ]);
  });

  it("shares gates with the canonical chain", () => {
    // Critical: arming a provider via one chain must reflect in another. All
    // slots see the same gates, so a 429 anywhere arms it everywhere.
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const canonical = createProviderChain([a, b]);
    const rotated = chainStartingWith(canonical, b);
    a.gate.armUntil(new Date(Date.now() + 60_000));
    expect(canonical.active()?.name as string).toBe("secondary");
    expect(rotated.active()?.name as string).toBe("secondary");
  });

  it("throws when the requested primary isn't in the canonical chain", () => {
    const a = namedProvider("primary");
    const b = namedProvider("secondary");
    const canonical = createProviderChain([a]);
    expect(() => chainStartingWith(canonical, b)).toThrow();
  });
});

describe("isRateLimitError", () => {
  it("matches an object with status: 429", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });

  it("matches 402 insufficient balance", () => {
    expect(isRateLimitError({ status: 402 })).toBe(true);
  });

  it("matches 403 with quota/usage-limit message", () => {
    expect(
      isRateLimitError({
        status: 403,
        message:
          '403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle."}}',
      }),
    ).toBe(true);
  });

  it("doesn't match 403 without quota message", () => {
    expect(isRateLimitError({ status: 403, message: "forbidden" })).toBe(false);
  });

  it("doesn't match other status codes", () => {
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError({ status: 400 })).toBe(false);
  });

  it("doesn't match non-objects", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError("429")).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe("armOnRateLimit", () => {
  it("uses the parsed reset when available", () => {
    const parsed = new Date("2026-04-25T15:43:26Z");
    const p = namedProvider("primary", () => parsed);
    const reset = armOnRateLimit(p, "rate limited, resets later");
    expect(reset.toISOString()).toBe("2026-04-25T15:43:26.000Z");
    expect(p.gate.armedUntil()?.toISOString()).toBe("2026-04-25T15:43:26.000Z");
  });

  it("falls back to defaultBackoffMs when no parse", () => {
    const p = createProvider({
      name: "openrouter",
      apiKey: "x",
      baseUrl: "https://e",
      model: "m",
      defaultBackoffMs: 30_000,
    });
    const before = Date.now();
    const reset = armOnRateLimit(p, "no timestamp here");
    const after = Date.now();
    const elapsed = reset.getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(30_000);
    expect(reset.getTime()).toBeLessThanOrEqual(after + 30_000 + 100);
  });
});

describe("AllProvidersExhaustedError", () => {
  it("includes earliestReset in the message when present", () => {
    const reset = new Date("2026-04-25T15:43:26Z");
    const err = new AllProvidersExhaustedError(reset);
    expect(err.earliestReset).toBe(reset);
    expect(err.message).toContain("2026-04-25T15:43:26");
  });

  it("handles null earliestReset", () => {
    const err = new AllProvidersExhaustedError(null);
    expect(err.earliestReset).toBeNull();
    expect(err.message).toContain("rate-limited");
  });
});

describe("chainWithOrder", () => {
  it("reorders providers to match the requested preference", () => {
    const zai = namedProvider("primary");
    const kimi = namedProvider("secondary");
    const deepseek = namedProvider("openrouter");
    const canonical = createProviderChain([zai, kimi, deepseek]);
    const reordered = chainWithOrder(canonical, ["openrouter", "primary", "secondary"] as ProviderName[]);
    expect(reordered.providers.map((p) => p.name as string)).toEqual(["openrouter", "primary", "secondary"]);
  });

  it("ignores names not present in the canonical chain", () => {
    const zai = namedProvider("primary");
    const deepseek = namedProvider("openrouter");
    const canonical = createProviderChain([zai, deepseek]);
    const reordered = chainWithOrder(canonical, ["openrouter", "secondary", "primary"] as ProviderName[]);
    expect(reordered.providers.map((p) => p.name as string)).toEqual(["openrouter", "primary"]);
  });

  it("appends unrequested providers at the end in canonical order", () => {
    const zai = namedProvider("primary");
    const kimi = namedProvider("secondary");
    const deepseek = namedProvider("openrouter");
    const canonical = createProviderChain([zai, kimi, deepseek]);
    const reordered = chainWithOrder(canonical, ["openrouter"] as ProviderName[]);
    expect(reordered.providers.map((p) => p.name as string)).toEqual(["openrouter", "primary", "secondary"]);
  });
});
