import { describe, expect, it } from "bun:test";
import type { ProviderName } from "../src/providers.ts";
import {
  ALL_REVIEW_ROLES,
  orderForRole,
  parseReviewRoles,
  rotateOrder,
  type ReviewRole,
} from "../src/review/roles.ts";

describe("parseReviewRoles", () => {
  describe("happy path", () => {
    it("defaults to every role when unset", () => {
      expect(parseReviewRoles(undefined)).toEqual(ALL_REVIEW_ROLES);
    });

    it("parses a single role", () => {
      expect(parseReviewRoles("correctness")).toEqual(["correctness"]);
    });

    it("preserves the configured order", () => {
      expect(parseReviewRoles("adversarial,correctness")).toEqual([
        "adversarial",
        "correctness",
      ]);
    });

    it("tolerates surrounding whitespace", () => {
      expect(parseReviewRoles(" correctness , adversarial ")).toEqual([
        "correctness",
        "adversarial",
      ]);
    });
  });

  describe("edge cases", () => {
    it("dedupes a repeated role", () => {
      expect(parseReviewRoles("correctness,correctness")).toEqual(["correctness"]);
    });

    it("drops unknown roles but keeps valid ones", () => {
      expect(parseReviewRoles("correctness,typo")).toEqual(["correctness"]);
    });
  });

  describe("error cases", () => {
    it("falls back to correctness rather than disabling review entirely", () => {
      expect(parseReviewRoles("nonsense")).toEqual(["correctness"]);
    });

    it("falls back to correctness on an empty string", () => {
      expect(parseReviewRoles("")).toEqual(["correctness"]);
    });
  });
});

describe("rotateOrder", () => {
  describe("happy path", () => {
    it("returns the order unchanged at offset 0", () => {
      expect(rotateOrder([1, 2, 3], 0)).toEqual([1, 2, 3]);
    });

    it("rotates left by one", () => {
      expect(rotateOrder([1, 2, 3], 1)).toEqual([2, 3, 1]);
    });
  });

  describe("edge cases", () => {
    it("wraps when the offset exceeds the length", () => {
      expect(rotateOrder([1, 2, 3], 4)).toEqual([2, 3, 1]);
    });

    it("returns an empty order untouched", () => {
      expect(rotateOrder([], 2)).toEqual([]);
    });

    it("is a no-op for a single-provider order", () => {
      expect(rotateOrder(["deepseek"], 1)).toEqual(["deepseek"]);
    });
  });
});

describe("orderForRole", () => {
  const base: readonly ProviderName[] = ["deepseek", "z.ai", "kimi"];
  const roles: readonly ReviewRole[] = ["correctness", "adversarial"];

  it("gives the first role the base order", () => {
    expect(orderForRole(base, "correctness", roles)).toEqual(["deepseek", "z.ai", "kimi"]);
  });

  it("gives the second role a different primary", () => {
    expect(orderForRole(base, "adversarial", roles)).toEqual(["z.ai", "kimi", "deepseek"]);
  });

  it("keeps the two roles off the same primary provider", () => {
    const a = orderForRole(base, "correctness", roles)[0];
    const b = orderForRole(base, "adversarial", roles)[0];
    expect(a).not.toBe(b);
  });

  it("degrades to the same order when only one provider is configured", () => {
    const single: readonly ProviderName[] = ["deepseek"];
    expect(orderForRole(single, "adversarial", roles)).toEqual(["deepseek"]);
  });

  it("falls back to the base order for a role not in the list", () => {
    expect(orderForRole(base, "adversarial", ["correctness"])).toEqual(base);
  });
});
