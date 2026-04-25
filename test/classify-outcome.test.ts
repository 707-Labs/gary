import { describe, expect, it } from "bun:test";
import {
  type Classification,
  decideClassifyOutcome,
} from "../src/handlers/classifier.ts";

const base: Classification = {
  classification: "CODE",
  confidence: 0.9,
  scope: "S",
  reasoning: "small change",
};

describe("decideClassifyOutcome", () => {
  it("proceeds for high-confidence CODE/S", () => {
    expect(decideClassifyOutcome(base).kind).toBe("proceed");
  });

  it("proceeds for high-confidence CODE/M", () => {
    expect(decideClassifyOutcome({ ...base, scope: "M" }).kind).toBe("proceed");
  });

  it("bounces low-confidence regardless of scope", () => {
    expect(
      decideClassifyOutcome({ ...base, confidence: 0.4, scope: "S" }).kind,
    ).toBe("low_confidence");
  });

  it("auto-bounces CODE/L even with high confidence", () => {
    expect(decideClassifyOutcome({ ...base, scope: "L" }).kind).toBe(
      "scope_too_big",
    );
  });

  it("does NOT auto-bounce ANSWER/L (the L heuristic is for code work)", () => {
    expect(
      decideClassifyOutcome({
        ...base,
        classification: "ANSWER",
        scope: "L",
      }).kind,
    ).toBe("proceed");
  });

  it("does NOT auto-bounce BOUNCE/L (the bounce path runs the bounce handler anyway)", () => {
    expect(
      decideClassifyOutcome({
        ...base,
        classification: "BOUNCE",
        scope: "L",
      }).kind,
    ).toBe("proceed");
  });

  it("low_confidence takes precedence over scope_too_big", () => {
    expect(
      decideClassifyOutcome({ ...base, confidence: 0.3, scope: "L" }).kind,
    ).toBe("low_confidence");
  });

  it("respects a custom confidenceFloor", () => {
    expect(
      decideClassifyOutcome(
        { ...base, confidence: 0.55 },
        { confidenceFloor: 0.7 },
      ).kind,
    ).toBe("low_confidence");
  });
});
