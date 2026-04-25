import { describe, expect, it } from "bun:test";
import {
  computeHumanInputSignature,
  type DerivedState,
  fingerprintDerivedState,
} from "../src/state-fingerprint.ts";

const baseState: DerivedState = {
  issueId: "i-1",
  issueIdentifier: "ERT-1",
  issueUpdatedAt: "2026-04-24T00:00:00Z",
  humanInputSignature: "sig-0",
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

  it("does NOT change when only issueUpdatedAt advances (Gary's own writes bump it)", () => {
    const a = fingerprintDerivedState(baseState);
    const b = fingerprintDerivedState({
      ...baseState,
      issueUpdatedAt: "2026-04-25T00:00:00Z",
    });
    expect(a).toBe(b);
  });

  it("changes when human input signature advances", () => {
    const a = fingerprintDerivedState(baseState);
    const b = fingerprintDerivedState({
      ...baseState,
      humanInputSignature: "sig-1",
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

describe("computeHumanInputSignature", () => {
  const garyId = "gary-user-id";

  it("returns 16 hex chars", () => {
    expect(
      computeHumanInputSignature({
        description: "x",
        comments: [],
        garyUserId: garyId,
      }),
    ).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across Gary's own comments", () => {
    const before = computeHumanInputSignature({
      description: "do the thing",
      comments: [
        { id: "c1", userId: "tanner", createdAt: "2026-04-24T00:00:00Z" },
      ],
      garyUserId: garyId,
    });
    const after = computeHumanInputSignature({
      description: "do the thing",
      comments: [
        { id: "c1", userId: "tanner", createdAt: "2026-04-24T00:00:00Z" },
        { id: "c2", userId: garyId, createdAt: "2026-04-24T00:01:00Z" },
        { id: "c3", userId: garyId, createdAt: "2026-04-24T00:02:00Z" },
      ],
      garyUserId: garyId,
    });
    expect(before).toBe(after);
  });

  it("changes when a non-Gary comment is added", () => {
    const before = computeHumanInputSignature({
      description: "do the thing",
      comments: [
        { id: "c1", userId: "tanner", createdAt: "2026-04-24T00:00:00Z" },
        { id: "c2", userId: garyId, createdAt: "2026-04-24T00:01:00Z" },
      ],
      garyUserId: garyId,
    });
    const after = computeHumanInputSignature({
      description: "do the thing",
      comments: [
        { id: "c1", userId: "tanner", createdAt: "2026-04-24T00:00:00Z" },
        { id: "c2", userId: garyId, createdAt: "2026-04-24T00:01:00Z" },
        { id: "c3", userId: "tanner", createdAt: "2026-04-24T00:02:00Z" },
      ],
      garyUserId: garyId,
    });
    expect(before).not.toBe(after);
  });

  it("changes when description changes", () => {
    const before = computeHumanInputSignature({
      description: "v1",
      comments: [],
      garyUserId: garyId,
    });
    const after = computeHumanInputSignature({
      description: "v2",
      comments: [],
      garyUserId: garyId,
    });
    expect(before).not.toBe(after);
  });

  it("treats null userId as non-Gary (don't accidentally exclude)", () => {
    const sig = computeHumanInputSignature({
      description: null,
      comments: [
        { id: "c1", userId: null, createdAt: "2026-04-24T00:00:00Z" },
      ],
      garyUserId: garyId,
    });
    const empty = computeHumanInputSignature({
      description: null,
      comments: [],
      garyUserId: garyId,
    });
    expect(sig).not.toBe(empty);
  });

  it("is order-independent for the input list (sorts internally)", () => {
    const a = computeHumanInputSignature({
      description: null,
      comments: [
        { id: "c1", userId: "tanner", createdAt: "2026-04-24T00:00:00Z" },
        { id: "c2", userId: "tanner", createdAt: "2026-04-24T00:01:00Z" },
      ],
      garyUserId: garyId,
    });
    const b = computeHumanInputSignature({
      description: null,
      comments: [
        { id: "c2", userId: "tanner", createdAt: "2026-04-24T00:01:00Z" },
        { id: "c1", userId: "tanner", createdAt: "2026-04-24T00:00:00Z" },
      ],
      garyUserId: garyId,
    });
    expect(a).toBe(b);
  });
});
