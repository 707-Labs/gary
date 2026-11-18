import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { log } from "../src/logger.ts";
import type { ProviderConfig, ProviderName } from "../src/providers.ts";
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
    expect(cfg.providerOrder).toEqual(["openrouter"]);
    expect(cfg.maxRounds).toBe(3);
    expect(cfg.iterationCap).toBe(15);
    expect(cfg.timeoutMs).toBe(300_000);
  });

  it("respects GARY_REVIEWER_PROVIDER_ORDER", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "openrouter");
    expect(loadReviewConfig().providerOrder).toEqual(["openrouter"]);
  });

  it("drops the retired z.ai and kimi routes from GARY_REVIEWER_PROVIDER_ORDER with one warning", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "openrouter,z.ai,kimi");
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(loadReviewConfig().providerOrder).toEqual(["openrouter"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toEqual({ providers: ["z.ai", "kimi"] });
    } finally { warn.mockRestore(); }
  });

  it("falls back to openrouter when only retired routes are listed", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "z.ai,kimi");
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try { expect(loadReviewConfig().providerOrder).toEqual(["openrouter"]); } finally { warn.mockRestore(); }
  });

  it("does not warn when the default order is used", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", undefined);
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try { expect(loadReviewConfig().providerOrder).toEqual(["openrouter"]); expect(warn).not.toHaveBeenCalled(); } finally { warn.mockRestore(); }
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
  it("accepts Gary's direct, bounded model route", () => {
    expect(() =>
      validateProviderRoute(
        "openrouter",
        "https://openrouter.ai/api",
        "deepseek/deepseek-v4.1-flash",
      ),
    ).not.toThrow();
  });

  it("rejects the retired z.ai and kimi subscription routes (no approved route remains)", () => {
    expect(() =>
      validateProviderRoute("z.ai" as unknown as ProviderName, "https://api.z.ai/api/anthropic", "glm-5.3"),
    ).toThrow(/Unapproved provider/);
    expect(() =>
      validateProviderRoute("kimi" as unknown as ProviderName, "https://api.kimi.com/coding", "k3"),
    ).toThrow(/Unapproved provider/);
  });

  it("rejects proxy endpoints outside the approved host", () => {
    expect(() =>
      validateProviderRoute("openrouter", "https://api.deepseek.com/anthropic", "deepseek/deepseek-v4.1-flash"),
    ).toThrow(/disallowed.*host/i);
    expect(() =>
      validateProviderRoute("openrouter", "https://api.z.ai/api/anthropic", "deepseek/deepseek-v4.1-flash"),
    ).toThrow(/disallowed.*host/i);
    expect(() =>
      validateProviderRoute("openrouter", "http://openrouter.ai/api", "deepseek/deepseek-v4.1-flash"),
    ).toThrow(/https/i);
  });

  it("rejects unreviewed model overrides", () => {
    for (const model of ["glm-5.3", "deepseek-v4-pro", "deepseek/deepseek-v4-pro", "openrouter/auto"]) {
      expect(() =>
        validateProviderRoute("openrouter", "https://openrouter.ai/api", model),
      ).toThrow(/disallowed.*model/i);
    }
  });
});

describe("loadProviderConfigs", () => {
  const keys = ["Z_AI_API_KEY", "Z_AI_BASE_URL", "Z_AI_MODEL", "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL",
    "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"];
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
    env({ OPENROUTER_API_KEY: "fake-openrouter" });
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    let providers: readonly ProviderConfig[];
    try { providers = loadProviderConfigs(); expect(warn).not.toHaveBeenCalled(); } finally { warn.mockRestore(); }
    expect(providers.map((p) => p.name)).toEqual(["openrouter"]);
    expect(providers[0]).toMatchObject({ apiKey: "fake-openrouter", baseUrl: PAID_ROUTE.baseUrl, model: PAID_ROUTE.model });
  });

  it("throws naming OPENROUTER_API_KEY when it is missing, even if Z_AI_API_KEY is set", () => {
    env({ Z_AI_API_KEY: "fake-zai" });
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(() => loadProviderConfigs()).toThrow("Missing required env var: OPENROUTER_API_KEY");
    } finally { warn.mockRestore(); }
  });

  it("ignores leftover Z_AI_*/KIMI_* variables with one warning that names them, never their values", () => {
    env({ OPENROUTER_API_KEY: "fake-openrouter", Z_AI_API_KEY: "secret-zai-value", Z_AI_MODEL: "glm-5.3",
      Z_AI_BASE_URL: "https://api.z.ai/api/anthropic", KIMI_API_KEY: "secret-kimi-value", KIMI_MODEL: "k3" });
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    let providers: readonly ProviderConfig[];
    try {
      providers = loadProviderConfigs();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toEqual({ variables: ["KIMI_API_KEY", "KIMI_MODEL", "Z_AI_API_KEY", "Z_AI_BASE_URL", "Z_AI_MODEL"] });
      const logged = JSON.stringify(warn.mock.calls);
      for (const value of ["secret-zai-value", "secret-kimi-value", "fake-openrouter", "api.z.ai", "glm-5.3", "k3"]) {
        expect(logged).not.toContain(value);
      }
    } finally { warn.mockRestore(); }
    expect(providers.map((p) => p.name)).toEqual(["openrouter"]);
    expect(providers.some((p) => p.apiKey.startsWith("secret-") || p.baseUrl.includes("z.ai") || p.baseUrl.includes("kimi"))).toBe(false);
  });

  it("ignores a leftover DEEPSEEK_API_KEY with a warning and never builds a direct DeepSeek provider", () => {
    env({ OPENROUTER_API_KEY: "fake-openrouter", DEEPSEEK_API_KEY: "fake-deepseek",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic", DEEPSEEK_MODEL: "deepseek-v4-pro" });
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    let providers: readonly ProviderConfig[];
    try { providers = loadProviderConfigs(); expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toEqual({ variables: ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"] });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("fake-deepseek");
    } finally { warn.mockRestore(); }
    expect(providers.map((p) => p.name)).toEqual(["openrouter"]);
    expect(providers.some((p) => p.apiKey === "fake-deepseek" || p.baseUrl.includes("deepseek.com"))).toBe(false);
  });

  it("rejects an OPENROUTER_MODEL override off the approved route", () => {
    env({ OPENROUTER_API_KEY: "fake-openrouter", OPENROUTER_MODEL: "deepseek-v4-pro" });
    expect(() => loadProviderConfigs()).toThrow(/disallowed.*model/i);
  });
});
