import { afterEach, describe, expect, it } from "bun:test";
import {
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
    expect(cfg.providerOrder).toEqual(["deepseek", "z.ai", "kimi"]);
    expect(cfg.maxRounds).toBe(3);
    expect(cfg.iterationCap).toBe(15);
    expect(cfg.timeoutMs).toBe(300_000);
  });

  it("respects GARY_REVIEWER_PROVIDER_ORDER", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "kimi,deepseek");
    const cfg = loadReviewConfig();
    expect(cfg.providerOrder).toEqual(["kimi", "deepseek"]);
  });

  it("ignores unknown provider names", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "deepseek,gpt5,kimi");
    const cfg = loadReviewConfig();
    expect(cfg.providerOrder).toEqual(["deepseek", "kimi"]);
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
        "deepseek",
        "https://api.deepseek.com/anthropic",
        "deepseek-v4-pro",
      ),
    ).not.toThrow();
  });

  it("rejects OpenRouter and arbitrary proxy endpoints", () => {
    expect(() =>
      validateProviderRoute(
        "deepseek",
        "https://openrouter.ai/api/v1",
        "deepseek-v4-pro",
      ),
    ).toThrow(/disallowed.*host/i);
    expect(() =>
      validateProviderRoute("kimi", "http://api.kimi.com/coding", "k3"),
    ).toThrow(/https/i);
  });

  it("rejects unreviewed model overrides", () => {
    expect(() =>
      validateProviderRoute("z.ai", "https://api.z.ai/api/anthropic", "glm-premium"),
    ).toThrow(/disallowed.*model/i);
  });
});
