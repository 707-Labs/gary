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
  parseDeepSeek429,
  parseKimi429,
  parseZAi429,
} from "../src/providers.ts";
import { createRateLimitGate } from "../src/rate-limit.ts";

describe("parseZAi429", () => {
  it("parses the Z.ai 5-hour cap message", () => {
    const raw =
      '429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-04-25 15:43:26"},"request_id":"abc"}';
    expect(parseZAi429(raw)?.toISOString()).toBe("2026-04-25T15:43:26.000Z");
  });

  it("returns null on unrelated messages", () => {
    expect(parseZAi429("400 bad request")).toBeNull();
    expect(parseZAi429("429 Too Many Requests")).toBeNull();
    expect(parseZAi429("")).toBeNull();
  });
});

describe("parseKimi429", () => {
  it("parses a reset-style message", () => {
    expect(
      parseKimi429("Quota exceeded. Reset at 2026-04-25 12:00:00.")?.toISOString(),
    ).toBe("2026-04-25T12:00:00.000Z");
  });

  it("parses a bare ISO 8601 timestamp", () => {
    expect(
      parseKimi429("rate limit; retry after 2026-04-25T15:00:00Z")?.toISOString(),
    ).toBe("2026-04-25T15:00:00.000Z");
  });

  it("returns null when no timestamp is present", () => {
    expect(parseKimi429("429 Too Many Requests")).toBeNull();
  });
});

describe("parseDeepSeek429", () => {
  it("always returns null (no documented usage cap)", () => {
    expect(parseDeepSeek429("anything")).toBeNull();
  });
});

describe("createProvider", () => {
  it("attaches the right parser per provider name", () => {
    const zai = createProvider({
      name: "z.ai",
      apiKey: "x",
      baseUrl: "https://example",
      model: "m",
      defaultBackoffMs: 1000,
    });
    expect(zai.parse429("Usage limit reached. reset at 2026-04-25 15:43:26"))
      .not.toBeNull();
    const ds = createProvider({
      name: "deepseek",
      apiKey: "x",
      baseUrl: "https://example",
      model: "m",
      defaultBackoffMs: 1000,
    });
    expect(ds.parse429("any message")).toBeNull();
  });
});

describe("ProviderChain", () => {
  function fakeProvider(name: "z.ai" | "kimi" | "deepseek"): LLMProvider {
    return createProvider({
      name,
      apiKey: "x",
      baseUrl: "https://example",
      model: `${name}-model`,
      defaultBackoffMs: 1000,
    });
  }

  it("active() returns the first unarmed provider", () => {
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
    const c = fakeProvider("deepseek");
    const chain = createProviderChain([a, b, c]);
    expect(chain.active()?.name).toBe("z.ai");
    a.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.active()?.name).toBe("kimi");
    b.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.active()?.name).toBe("deepseek");
  });

  it("active() returns null when all providers are armed", () => {
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
    const chain = createProviderChain([a, b]);
    a.gate.armUntil(new Date(Date.now() + 60_000));
    b.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.active()).toBeNull();
    expect(chain.allArmed()).toBe(true);
  });

  it("earliestReset() returns null when any provider is unarmed", () => {
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
    const chain = createProviderChain([a, b]);
    a.gate.armUntil(new Date(Date.now() + 60_000));
    expect(chain.earliestReset()).toBeNull();
  });

  it("earliestReset() returns the soonest reset when all are armed", () => {
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
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
  function fakeProvider(name: "z.ai" | "kimi" | "deepseek"): LLMProvider {
    return createProvider({
      name,
      apiKey: "x",
      baseUrl: "https://example",
      model: `${name}-model`,
      defaultBackoffMs: 1000,
    });
  }

  it("rotates the canonical chain so primary leads", () => {
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
    const c = fakeProvider("deepseek");
    const canonical = createProviderChain([a, b, c]);
    const rotated = chainStartingWith(canonical, b);
    expect(rotated.providers.map((p) => p.name)).toEqual([
      "kimi",
      "z.ai",
      "deepseek",
    ]);
  });

  it("preserves canonical order for non-primary providers", () => {
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
    const c = fakeProvider("deepseek");
    const canonical = createProviderChain([a, b, c]);
    const rotated = chainStartingWith(canonical, c);
    expect(rotated.providers.map((p) => p.name)).toEqual([
      "deepseek",
      "z.ai",
      "kimi",
    ]);
  });

  it("shares gates with the canonical chain", () => {
    // Critical: arming a provider via one chain must reflect in another. All
    // slots see the same gates, so a 429 anywhere arms it everywhere.
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
    const canonical = createProviderChain([a, b]);
    const rotated = chainStartingWith(canonical, b);
    a.gate.armUntil(new Date(Date.now() + 60_000));
    expect(canonical.active()?.name).toBe("kimi");
    expect(rotated.active()?.name).toBe("kimi");
  });

  it("throws when the requested primary isn't in the canonical chain", () => {
    const a = fakeProvider("z.ai");
    const b = fakeProvider("kimi");
    const canonical = createProviderChain([a]);
    expect(() => chainStartingWith(canonical, b)).toThrow();
  });
});

describe("isRateLimitError", () => {
  it("matches an object with status: 429", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
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
    const p = createProvider({
      name: "z.ai",
      apiKey: "x",
      baseUrl: "https://e",
      model: "m",
      defaultBackoffMs: 60_000,
    });
    const reset = armOnRateLimit(
      p,
      "Usage limit reached. reset at 2026-04-25 15:43:26",
    );
    expect(reset.toISOString()).toBe("2026-04-25T15:43:26.000Z");
    expect(p.gate.armedUntil()?.toISOString()).toBe("2026-04-25T15:43:26.000Z");
  });

  it("falls back to defaultBackoffMs when no parse", () => {
    const p = createProvider({
      name: "deepseek",
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
  function fakeProvider(name: ProviderName): LLMProvider {
    return {
      name,
      model: name,
      client: {} as AnthropicClient,
      gate: createRateLimitGate(),
      defaultBackoffMs: 60_000,
      parse429: () => null,
    };
  }

  it("reorders providers to match the requested preference", () => {
    const zai = fakeProvider("z.ai");
    const kimi = fakeProvider("kimi");
    const deepseek = fakeProvider("deepseek");
    const canonical = createProviderChain([zai, kimi, deepseek]);
    const reordered = chainWithOrder(canonical, ["deepseek", "z.ai", "kimi"]);
    expect(reordered.providers.map((p) => p.name)).toEqual(["deepseek", "z.ai", "kimi"]);
  });

  it("ignores names not present in the canonical chain", () => {
    const zai = fakeProvider("z.ai");
    const deepseek = fakeProvider("deepseek");
    const canonical = createProviderChain([zai, deepseek]);
    const reordered = chainWithOrder(canonical, ["deepseek", "kimi", "z.ai"]);
    expect(reordered.providers.map((p) => p.name)).toEqual(["deepseek", "z.ai"]);
  });

  it("appends unrequested providers at the end in canonical order", () => {
    const zai = fakeProvider("z.ai");
    const kimi = fakeProvider("kimi");
    const deepseek = fakeProvider("deepseek");
    const canonical = createProviderChain([zai, kimi, deepseek]);
    const reordered = chainWithOrder(canonical, ["deepseek"]);
    expect(reordered.providers.map((p) => p.name)).toEqual(["deepseek", "z.ai", "kimi"]);
  });
});
