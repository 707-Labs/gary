import { afterEach, describe, expect, it } from "bun:test";
import {
  loadProviderRoutingConfig,
  loadReviewConfig,
  parseRepoMap,
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

describe("loadProviderRoutingConfig", () => {
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

  it("defaults main work to kimi-first and PR follow-ups to z.ai-first", () => {
    setEnv("GARY_MAIN_PROVIDER_ORDER", undefined);
    setEnv("GARY_PR_FOLLOWUP_PROVIDER_ORDER", undefined);
    const cfg = loadProviderRoutingConfig();
    expect(cfg.main).toEqual(["kimi", "z.ai", "deepseek"]);
    expect(cfg.prFollowup).toEqual(["z.ai", "kimi", "deepseek"]);
  });

  it("respects env overrides", () => {
    setEnv("GARY_MAIN_PROVIDER_ORDER", "deepseek,kimi");
    setEnv("GARY_PR_FOLLOWUP_PROVIDER_ORDER", "kimi");
    const cfg = loadProviderRoutingConfig();
    expect(cfg.main).toEqual(["deepseek", "kimi"]);
    expect(cfg.prFollowup).toEqual(["kimi"]);
  });

  it("drops unknown provider names instead of throwing", () => {
    setEnv("GARY_MAIN_PROVIDER_ORDER", "kimi,gpt5,z.ai");
    const cfg = loadProviderRoutingConfig();
    expect(cfg.main).toEqual(["kimi", "z.ai"]);
  });
});
