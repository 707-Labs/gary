import { describe, expect, it } from "bun:test";
import {
  computeHumanInputSignature,
  computePrCommentSignature,
  type DerivedState,
  fingerprintDerivedState,
  PR_COMMENT_SIGNATURE_EMPTY,
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
        prCommentSignature: "empty",
        openedAt: "2099-01-01T00:00:00Z",
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
        prCommentSignature: "empty",
        openedAt: "2099-01-01T00:00:00Z",
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

describe("computePrCommentSignature", () => {
  const human = (id: number, login = "tanner") => ({
    id,
    authorLogin: login,
    authorType: "User",
  });
  const bot = (id: number, login: string) => ({
    id,
    authorLogin: login,
    authorType: "Bot",
  });

  it("returns the empty token when no comments", () => {
    expect(
      computePrCommentSignature({ comments: [], alreadyRespondedIds: [] }),
    ).toBe(PR_COMMENT_SIGNATURE_EMPTY);
  });

  it("ignores all bot comments (Gary, linear[bot], dependabot, etc.)", () => {
    expect(
      computePrCommentSignature({
        comments: [
          bot(1, "gary-707-labs[bot]"),
          bot(2, "linear[bot]"),
          bot(3, "dependabot[bot]"),
        ],
        alreadyRespondedIds: [],
      }),
    ).toBe(PR_COMMENT_SIGNATURE_EMPTY);
  });

  it("treats gemini-code-assist[bot] as pending review feedback", () => {
    expect(
      computePrCommentSignature({
        comments: [bot(1, "gemini-code-assist[bot]")],
        alreadyRespondedIds: [],
      }),
    ).not.toBe(PR_COMMENT_SIGNATURE_EMPTY);
  });

  it("returns the empty token once gemini comments are responded", () => {
    expect(
      computePrCommentSignature({
        comments: [bot(1, "gemini-code-assist[bot]")],
        alreadyRespondedIds: [1],
      }),
    ).toBe(PR_COMMENT_SIGNATURE_EMPTY);
  });

  it("still filters Gary himself even alongside allowlisted bots", () => {
    const withGary = computePrCommentSignature({
      comments: [bot(1, "gemini-code-assist[bot]"), bot(2, "gary-707-labs[bot]")],
      alreadyRespondedIds: [],
    });
    const withoutGary = computePrCommentSignature({
      comments: [bot(1, "gemini-code-assist[bot]")],
      alreadyRespondedIds: [],
    });
    expect(withGary).toBe(withoutGary);
  });

  it("returns the empty token when all human comments are already responded", () => {
    expect(
      computePrCommentSignature({
        comments: [human(10)],
        alreadyRespondedIds: [10],
      }),
    ).toBe(PR_COMMENT_SIGNATURE_EMPTY);
  });

  it("returns a non-empty hash when there's a pending human comment", () => {
    const sig = computePrCommentSignature({
      comments: [human(11)],
      alreadyRespondedIds: [],
    });
    expect(sig).not.toBe(PR_COMMENT_SIGNATURE_EMPTY);
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a new pending comment arrives", () => {
    const a = computePrCommentSignature({
      comments: [human(1)],
      alreadyRespondedIds: [],
    });
    const b = computePrCommentSignature({
      comments: [human(1), human(2)],
      alreadyRespondedIds: [],
    });
    expect(a).not.toBe(b);
  });

  it("is stable across new bot comments (Gary's own responses, linkbacks, etc.)", () => {
    const before = computePrCommentSignature({
      comments: [human(1)],
      alreadyRespondedIds: [],
    });
    const after = computePrCommentSignature({
      comments: [
        human(1),
        bot(2, "gary-707-labs[bot]"),
        bot(3, "linear[bot]"),
      ],
      alreadyRespondedIds: [],
    });
    expect(before).toBe(after);
  });
});
