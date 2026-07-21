import { describe, expect, it } from "bun:test";
import { mergeReviews, type RoleReview } from "../src/review/merge.ts";
import type { SubmittedReview } from "../src/review/tools.ts";

function approve(report = "checked the diff"): SubmittedReview {
  return {
    verdict: "approve",
    findings: [],
    advisoryNotes: [],
    verificationReport: report,
  };
}

function block(title: string, detail = "detail"): SubmittedReview {
  return {
    verdict: "changes_needed",
    findings: [{ title, detail, bugClass: "wrong_code_path" }],
    advisoryNotes: [],
    verificationReport: "found a bug",
  };
}

describe("mergeReviews", () => {
  describe("happy path", () => {
    it("approves when every role approves", () => {
      const merged = mergeReviews([
        { role: "correctness", review: approve() },
        { role: "adversarial", review: approve() },
      ]);
      expect(merged.review.verdict).toBe("approve");
    });

    it("reports both roles as succeeded", () => {
      const merged = mergeReviews([
        { role: "correctness", review: approve() },
        { role: "adversarial", review: approve() },
      ]);
      expect(merged.succeeded).toEqual(["correctness", "adversarial"]);
    });

    it("attributes each verification report to its role", () => {
      const merged = mergeReviews([
        { role: "correctness", review: approve("no logic bugs") },
        { role: "adversarial", review: approve("no blast radius") },
      ]);
      expect(merged.review.verificationReport).toContain("**correctness reviewer**");
      expect(merged.review.verificationReport).toContain("no blast radius");
    });
  });

  describe("verdict is pessimistic", () => {
    it("blocks when only the adversarial role blocks", () => {
      const merged = mergeReviews([
        { role: "correctness", review: approve() },
        { role: "adversarial", review: block("auth check skipped") },
      ]);
      expect(merged.review.verdict).toBe("changes_needed");
    });

    it("blocks when only the correctness role blocks", () => {
      const merged = mergeReviews([
        { role: "correctness", review: block("off-by-one") },
        { role: "adversarial", review: approve() },
      ]);
      expect(merged.review.verdict).toBe("changes_needed");
    });

    it("carries the blocking role's findings through", () => {
      const merged = mergeReviews([
        { role: "correctness", review: approve() },
        { role: "adversarial", review: block("auth check skipped") },
      ]);
      expect(merged.review.findings.map((f) => f.title)).toEqual(["auth check skipped"]);
    });
  });

  describe("dedupe", () => {
    it("collapses the same finding reported by both roles", () => {
      const merged = mergeReviews([
        { role: "correctness", review: block("SQL not parameterized") },
        { role: "adversarial", review: block("sql not parameterized!") },
      ]);
      expect(merged.review.findings).toHaveLength(1);
    });

    it("keeps genuinely distinct findings from both roles", () => {
      const merged = mergeReviews([
        { role: "correctness", review: block("off-by-one in loop") },
        { role: "adversarial", review: block("auth check skipped") },
      ]);
      expect(merged.review.findings).toHaveLength(2);
    });

    it("dedupes advisory notes across roles", () => {
      const a = { ...approve(), advisoryNotes: ["rename this", "extract helper"] };
      const b = { ...approve(), advisoryNotes: ["rename this"] };
      const merged = mergeReviews([
        { role: "correctness", review: a },
        { role: "adversarial", review: b },
      ]);
      expect(merged.review.advisoryNotes).toEqual(["rename this", "extract helper"]);
    });
  });

  describe("partial failure", () => {
    it("returns the surviving role's verdict", () => {
      const merged = mergeReviews(
        [{ role: "correctness", review: block("off-by-one") }],
        [{ role: "adversarial", reason: "timeout" }],
      );
      expect(merged.review.verdict).toBe("changes_needed");
    });

    it("approves on a lone surviving approval rather than blocking", () => {
      const merged = mergeReviews(
        [{ role: "correctness", review: approve() }],
        [{ role: "adversarial", reason: "timeout" }],
      );
      expect(merged.review.verdict).toBe("approve");
    });

    it("records the failed role in the verification report", () => {
      const merged = mergeReviews(
        [{ role: "correctness", review: approve() }],
        [{ role: "adversarial", reason: "timeout" }],
      );
      expect(merged.review.verificationReport).toContain("**adversarial reviewer**");
      expect(merged.review.verificationReport).toContain("timeout");
    });

    it("exposes the failure list to the caller", () => {
      const merged = mergeReviews(
        [{ role: "correctness", review: approve() }],
        [{ role: "adversarial", reason: "providers_exhausted" }],
      );
      expect(merged.failed).toEqual([
        { role: "adversarial", reason: "providers_exhausted" },
      ]);
    });
  });

  describe("invariants", () => {
    it("never returns findings alongside an approve verdict", () => {
      const merged = mergeReviews([{ role: "correctness", review: approve() }]);
      expect(merged.review.findings).toEqual([]);
    });

    it("substitutes placeholder text for an empty report", () => {
      const merged = mergeReviews([{ role: "correctness", review: approve("   ") }]);
      expect(merged.review.verificationReport).toContain("approved without a written report");
    });
  });

  describe("error cases", () => {
    it("throws when no role produced a verdict", () => {
      const empty: readonly RoleReview[] = [];
      expect(() => mergeReviews(empty)).toThrow(/at least one successful role/);
    });
  });
});
