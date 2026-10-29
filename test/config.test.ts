import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { log } from "../src/logger.ts";
import type { ProviderConfig } from "../src/providers.ts";
import { PAID_ROUTE } from "../src/model-route.ts";
import {
  loadProviderConfigs,
  loadReviewConfig,
  parseRepoMap,
  validateProviderRoute,
} from "../src/config.ts";

describe("parseRepoMap", () => {
  it("parses a single entry", () => {
    const map = parseRepoMap("ERT:707-Labs/ertai");
    expect(map.size).toBe(1);
    expect(map.get("ERT")).toBe("707-Labs/ertai");
  });

  it("parses multiple comma-separated entries", () => {
    const map = parseRepoMap(
      "ERT:707-Labs/ertai,GREEN:707-Labs/green-ledger,BIRD:707-Labs/birdup",
    );
    expect(map.size).toBe(3);
    expect(map.get("ERT")).toBe("707-Labs/ertai");
    expect(map.get("GREEN")).toBe("707-Labs/green-ledger");
    expect(map.get("BIRD")).toBe("707-Labs/birdup");
  });

  it("trims whitespace around entries and components", () => {
    const map = parseRepoMap(" ERT : 707-Labs/ertai , GREEN : 707-Labs/green-ledger ");
    expect(map.get("ERT")).toBe("707-Labs/ertai");
    expect(map.get("GREEN")).toBe("707-Labs/green-ledger");
  });

  it("returns an empty map for an empty string", () => {
    expect(parseRepoMap("").size).toBe(0);
  });

  it("returns an empty map for whitespace-only input", () => {
    expect(parseRepoMap("   ").size).toBe(0);
    expect(parseRepoMap("\n\t  ").size).toBe(0);
  });

  it("ignores empty segments from leading/trailing/consecutive commas", () => {
    const map = parseRepoMap(",ERT:707-Labs/ertai,,GREEN:707-Labs/green-ledger,");
    expect(map.size).toBe(2);
    expect(map.get("ERT")).toBe("707-Labs/ertai");
    expect(map.get("GREEN")).toBe("707-Labs/green-ledger");
  });

  it("rejects duplicate team keys", () => {
    expect(() =>
      parseRepoMap("ERT:707-Labs/ertai,ERT:707-Labs/other"),
    ).toThrow(/duplicate team key/i);
  });

  it("rejects malformed entries missing the colon", () => {
    expect(() => parseRepoMap("707-Labs/ertai")).toThrow(/expected/i);
  });

  it("rejects entries with empty team key", () => {
    expect(() => parseRepoMap(":707-Labs/ertai")).toThrow();
  });

  it("rejects entries with empty repo", () => {
    expect(() => parseRepoMap("ERT:")).toThrow();
  });

  it("rejects entries with bad repo shape", () => {
    expect(() => parseRepoMap("ERT:not-a-repo")).toThrow(/owner\/repo/i);
  });
});

describe("loadReviewConfig", () => {
  const originals: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in originals)) originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.keys(originals).forEach((k) => delete originals[k]);
  });

  it("returns defaults when no env vars are set", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", undefined);
    setEnv("GARY_REVIEW_MAX_ROUNDS", undefined);
    setEnv("GARY_REVIEW_ITERATION_CAP", undefined);
    setEnv("GARY_REVIEW_TIMEOUT_MS", undefined);
    const cfg = loadReviewConfig();
    expect(cfg.providerOrder).toEqual(["openrouter", "z.ai", "kimi"]);
    expect(cfg.maxRounds).toBe(3);
    expect(cfg.iterationCap).toBe(15);
    expect(cfg.timeoutMs).toBe(300_000);
  });

  it("respects GARY_REVIEWER_PROVIDER_ORDER", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "kimi,openrouter");
    const cfg = loadReviewConfig();
    expect(cfg.providerOrder).toEqual(["kimi", "openrouter"]);
  });

  it("fails loudly on unknown provider names, including the retired direct deepseek route", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "deepseek,gpt5,kimi");
    expect(() => loadReviewConfig()).toThrow(/GARY_REVIEWER_PROVIDER_ORDER.*deepseek, gpt5/);
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "deepseek");
    expect(() => loadReviewConfig()).toThrow(/GARY_REVIEWER_PROVIDER_ORDER/);
  });

  it("respects integer overrides", () => {
    setEnv("GARY_REVIEW_MAX_ROUNDS", "2");
    setEnv("GARY_REVIEW_ITERATION_CAP", "10");
    setEnv("GARY_REVIEW_TIMEOUT_MS", "180000");
    const cfg = loadReviewConfig();
    expect(cfg.maxRounds).toBe(2);
    expect(cfg.iterationCap).toBe(10);
    expect(cfg.timeoutMs).toBe(180_000);
  });

  it("throws on non-integer values", () => {
    setEnv("GARY_REVIEW_MAX_ROUNDS", "two");
    expect(() => loadReviewConfig()).toThrow(/integer/);
  });
});

describe("validateProviderRoute", () => {
  it("accepts Gary's direct, bounded model routes", () => {
    expect(() =>
      validateProviderRoute("z.ai", "https://api.z.ai/api/anthropic", "glm-5.3"),
    ).not.toThrow();
    expect(() =>
      validateProviderRoute("kimi", "https://api.kimi.com/coding", "k3"),
    ).not.toThrow();
    expect(() =>
      validateProviderRoute(
        "openrouter",
        "https://openrouter.ai/api",
        "deepseek/deepseek-v4.1-flash",
      ),
    ).not.toThrow();
  });

  it("rejects proxy endpoints outside each provider's approved host", () => {
    expect(() =>
      validateProviderRoute("kimi", "https://openrouter.ai/api", "k3"),
    ).toThrow(/disallowed.*host/i);
    expect(() =>
      validateProviderRoute("openrouter", "https://api.deepseek.com/anthropic", "deepseek/deepseek-v4.1-flash"),
    ).toThrow(/disallowed.*host/i);
    expect(() =>
      validateProviderRoute("kimi", "http://api.kimi.com/coding", "k3"),
    ).toThrow(/https/i);
  });

  it("rejects unreviewed model overrides", () => {
    expect(() =>
      validateProviderRoute("z.ai", "https://api.z.ai/api/anthropic", "glm-premium"),
    ).toThrow(/disallowed.*model/i);
    for (const model of ["deepseek-v4-pro", "deepseek/deepseek-v4-pro", "openrouter/auto"]) {
      expect(() =>
        validateProviderRoute("openrouter", "https://openrouter.ai/api", model),
      ).toThrow(/disallowed.*model/i);
    }
  });
});

describe("loadProviderConfigs without DEEPSEEK_API_KEY", () => {
  const keys = ["Z_AI_API_KEY", "KIMI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY",
    "OPENROUTER_BASE_URL", "OPENROUTER_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"];
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const env = (values: Record<string, string>) => {
    for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; }
    Object.assign(process.env, values);
  };

  it("boots the paid route from OPENROUTER_API_KEY alone, without warnings", () => {
    env({ Z_AI_API_KEY: "fake-zai", OPENROUTER_API_KEY: "fake-openrouter" });
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try { loadProviderConfigs(); expect(warn).not.toHaveBeenCalled(); } finally { warn.mockRestore(); }
    const providers = loadProviderConfigs();
    expect(providers.map((p) => p.name)).toEqual(["z.ai", "openrouter"]);
    expect(providers[1]).toMatchObject({ apiKey: "fake-openrouter", baseUrl: PAID_ROUTE.baseUrl, model: PAID_ROUTE.model });
  });

  it("ignores a leftover DEEPSEEK_API_KEY with a warning and never builds a direct DeepSeek provider", () => {
    env({ Z_AI_API_KEY: "fake-zai", OPENROUTER_API_KEY: "fake-openrouter", DEEPSEEK_API_KEY: "fake-deepseek",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic", DEEPSEEK_MODEL: "deepseek-v4-pro" });
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    let providers: readonly ProviderConfig[];
    try { providers = loadProviderConfigs(); expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toEqual({ variables: ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"] });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("fake-deepseek");
    } finally { warn.mockRestore(); }
    expect(providers.map((p) => p.name)).toEqual(["z.ai", "openrouter"]);
    expect(providers.some((p) => p.apiKey === "fake-deepseek" || p.baseUrl.includes("deepseek.com"))).toBe(false);
  });

  it("rejects an OPENROUTER_MODEL override off the approved route", () => {
    env({ Z_AI_API_KEY: "fake-zai", OPENROUTER_API_KEY: "fake-openrouter", OPENROUTER_MODEL: "deepseek-v4-pro" });
    expect(() => loadProviderConfigs()).toThrow(/disallowed.*model/i);
  });
});
