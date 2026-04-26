import { describe, expect, it } from "bun:test";
import { parseRepoMap } from "../src/config.ts";

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
