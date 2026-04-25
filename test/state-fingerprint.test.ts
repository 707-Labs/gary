import { describe, expect, it } from "bun:test";
import {
  type DerivedState,
  fingerprintDerivedState,
} from "../src/state-fingerprint.ts";

const baseState: DerivedState = {
  issueId: "i-1",
  issueIdentifier: "ERT-1",
  issueUpdatedAt: "2026-04-24T00:00:00Z",
  classification: null,
  pr: null,
};

describe("fingerprintDerivedState", () => {
  it("is deterministic for identical input", () => {
    expect(fingerprintDerivedState(baseState)).toBe(
      fingerprintDerivedState(baseState),
    );
  });

  it("changes when classification is set", () => {
    const a = fingerprintDerivedState(baseState);
    const b = fingerprintDerivedState({
      ...baseState,
      classification: { classification: "CODE" },
    });
    expect(a).not.toBe(b);
  });

  it("changes when issue updatedAt advances", () => {
    const a = fingerprintDerivedState(baseState);
    const b = fingerprintDerivedState({
      ...baseState,
      issueUpdatedAt: "2026-04-25T00:00:00Z",
    });
    expect(a).not.toBe(b);
  });

  it("changes when PR head SHA advances", () => {
    const stateWithPr: DerivedState = {
      ...baseState,
      pr: {
        number: 7,
        state: "open",
        merged: false,
        isDraft: false,
        headSha: "aaa",
        ciStatus: "green",
      },
    };
    const a = fingerprintDerivedState(stateWithPr);
    const b = fingerprintDerivedState({
      ...stateWithPr,
      pr: { ...stateWithPr.pr!, headSha: "bbb" },
    });
    expect(a).not.toBe(b);
  });

  it("changes when CI flips red", () => {
    const open: DerivedState = {
      ...baseState,
      pr: {
        number: 7,
        state: "open",
        merged: false,
        isDraft: false,
        headSha: "aaa",
        ciStatus: "green",
      },
    };
    expect(fingerprintDerivedState(open)).not.toBe(
      fingerprintDerivedState({
        ...open,
        pr: { ...open.pr!, ciStatus: "red" },
      }),
    );
  });

  it("returns 16 hex chars", () => {
    expect(fingerprintDerivedState(baseState)).toMatch(/^[0-9a-f]{16}$/);
  });
});
