import { describe, expect, it } from "bun:test";
import type { AssignedIssue } from "../src/adapters/linear.ts";
import {
  pickActionForMention,
  pickActionForTicket,
  pickHighestPriority,
} from "../src/priority.ts";
import type { DerivedState } from "../src/state-fingerprint.ts";

const issue: AssignedIssue = {
  id: "i-1",
  identifier: "ERT-1",
  title: "Add /api/health",
  description: "x",
  url: "https://example.linear.app/ERT-1",
  stateName: "Triage",
  stateType: "triage",
  createdAt: "2026-04-24T00:00:00Z",
  updatedAt: "2026-04-24T00:00:00Z",
  creatorId: "u-1",
  creatorName: "Tanner",
  teamId: "t",
  teamKey: "ERT",
  blockedBy: [],
};

const baseState: DerivedState = {
  issueId: issue.id,
  issueIdentifier: issue.identifier,
  issueUpdatedAt: issue.updatedAt,
  humanInputSignature: "sig-0",
  classification: null,
  pr: null,
};

describe("pickActionForTicket", () => {
  it("picks classify when no classification yet", () => {
    const action = pickActionForTicket({ issue, state: baseState });
    expect(action?.type).toBe("classify");
  });

  it("picks start_coding for CODE classification with no PR", () => {
    const action = pickActionForTicket({
      issue,
      state: { ...baseState, classification: { classification: "CODE" } },
    });
    expect(action?.type).toBe("start_coding");
  });

  it("picks write_answer for ANSWER classification", () => {
    const action = pickActionForTicket({
      issue,
      state: { ...baseState, classification: { classification: "ANSWER" } },
    });
    expect(action?.type).toBe("write_answer");
  });

  it("picks bounce for BOUNCE classification", () => {
    const action = pickActionForTicket({
      issue,
      state: { ...baseState, classification: { classification: "BOUNCE" } },
    });
    expect(action?.type).toBe("bounce");
  });

  it("prioritizes CI failure above classify even when classification is missing", () => {
    const action = pickActionForTicket({
      issue,
      state: {
        ...baseState,
        pr: {
          number: 5,
          state: "open",
          merged: false,
          isDraft: false,
          headSha: "x",
          ciStatus: "red",
          prCommentSignature: "empty",
          openedAt: "2099-01-01T00:00:00Z",
        },
      },
    });
    expect(action?.type).toBe("fix_ci_failure");
    expect(action?.priority).toBe(1);
  });

  it("picks respond_to_pr_review when there's a pending PR comment and CI is green", () => {
    const action = pickActionForTicket({
      issue,
      state: {
        ...baseState,
        classification: { classification: "CODE" },
        pr: {
          number: 5,
          state: "open",
          merged: false,
          isDraft: false,
          headSha: "x",
          ciStatus: "green",
          prCommentSignature: "abc123",
          openedAt: "2099-01-01T00:00:00Z",
        },
      },
    });
    expect(action?.type).toBe("respond_to_pr_review");
    expect(action?.priority).toBe(2);
  });

  it("prioritizes CI failure above PR review when both are present", () => {
    const action = pickActionForTicket({
      issue,
      state: {
        ...baseState,
        classification: { classification: "CODE" },
        pr: {
          number: 5,
          state: "open",
          merged: false,
          isDraft: false,
          headSha: "x",
          ciStatus: "red",
          prCommentSignature: "abc123",
          openedAt: "2099-01-01T00:00:00Z",
        },
      },
    });
    expect(action?.type).toBe("fix_ci_failure");
  });

  it("does NOT pick respond_to_pr_review when signature is the empty token", () => {
    const action = pickActionForTicket({
      issue,
      state: {
        ...baseState,
        classification: { classification: "CODE" },
        pr: {
          number: 5,
          state: "open",
          merged: false,
          isDraft: false,
          headSha: "x",
          ciStatus: "green",
          prCommentSignature: "empty",
          openedAt: "2099-01-01T00:00:00Z",
        },
      },
    });
    expect(action).toBeNull();
  });

  describe("revisit_code", () => {
    const codeWithPr: DerivedState = {
      ...baseState,
      humanInputSignature: "sig-current",
      classification: { classification: "CODE" },
      pr: {
        number: 5,
        state: "open",
        merged: false,
        isDraft: false,
        headSha: "x",
        ciStatus: "green",
        prCommentSignature: "empty",
        openedAt: "2099-01-01T00:00:00Z",
      },
    };

    it("picks revisit_code when signature differs from the mark", () => {
      const action = pickActionForTicket({
        issue,
        state: codeWithPr,
        lastRespondedHumanSignature: "sig-old",
      });
      expect(action?.type).toBe("revisit_code");
      expect(action?.priority).toBe(2.5);
    });

    it("does NOT pick revisit_code when signature equals the mark", () => {
      const action = pickActionForTicket({
        issue,
        state: codeWithPr,
        lastRespondedHumanSignature: "sig-current",
      });
      expect(action).toBeNull();
    });

    it("does NOT pick revisit_code when no mark exists yet (dormant for pre-feature tickets)", () => {
      const action = pickActionForTicket({
        issue,
        state: codeWithPr,
        lastRespondedHumanSignature: null,
      });
      expect(action).toBeNull();
    });

    it("yields to fix_ci_failure when both apply", () => {
      const action = pickActionForTicket({
        issue,
        state: { ...codeWithPr, pr: { ...codeWithPr.pr!, ciStatus: "red" } },
        lastRespondedHumanSignature: "sig-old",
      });
      expect(action?.type).toBe("fix_ci_failure");
    });

    it("yields to respond_to_pr_review when both apply", () => {
      const action = pickActionForTicket({
        issue,
        state: {
          ...codeWithPr,
          pr: { ...codeWithPr.pr!, prCommentSignature: "abc" },
        },
        lastRespondedHumanSignature: "sig-old",
      });
      expect(action?.type).toBe("respond_to_pr_review");
    });
  });

  describe("wait_for_blocker", () => {
    const openBlocker = {
      id: "b-1",
      identifier: "ERT-2353",
      stateName: "In Progress",
      stateType: "started",
      isOpen: true,
    };
    const doneBlocker = {
      id: "b-2",
      identifier: "ERT-2000",
      stateName: "Done",
      stateType: "completed",
      isOpen: false,
    };

    it("holds a CODE ticket with an open blocker instead of start_coding", () => {
      const action = pickActionForTicket({
        issue: { ...issue, blockedBy: [openBlocker] },
        state: { ...baseState, classification: { classification: "CODE" } },
      });
      expect(action?.type).toBe("wait_for_blocker");
      expect(action?.priority).toBe(4);
    });

    it("starts coding when every blocker is completed/canceled", () => {
      const action = pickActionForTicket({
        issue: { ...issue, blockedBy: [doneBlocker] },
        state: { ...baseState, classification: { classification: "CODE" } },
      });
      expect(action?.type).toBe("start_coding");
    });

    it("holds when any one of several blockers is still open", () => {
      const action = pickActionForTicket({
        issue: { ...issue, blockedBy: [doneBlocker, openBlocker] },
        state: { ...baseState, classification: { classification: "CODE" } },
      });
      expect(action?.type).toBe("wait_for_blocker");
    });

    it("still classifies an unclassified blocked ticket (blockers only gate coding)", () => {
      const action = pickActionForTicket({
        issue: { ...issue, blockedBy: [openBlocker] },
        state: baseState,
      });
      expect(action?.type).toBe("classify");
    });

    it("does not gate ANSWER tickets", () => {
      const action = pickActionForTicket({
        issue: { ...issue, blockedBy: [openBlocker] },
        state: { ...baseState, classification: { classification: "ANSWER" } },
      });
      expect(action?.type).toBe("write_answer");
    });

    it("does not gate work on an existing PR (fix_ci_failure proceeds)", () => {
      const action = pickActionForTicket({
        issue: { ...issue, blockedBy: [openBlocker] },
        state: {
          ...baseState,
          classification: { classification: "CODE" },
          pr: {
            number: 5,
            state: "open",
            merged: false,
            isDraft: false,
            headSha: "x",
            ciStatus: "red",
            prCommentSignature: "empty",
            openedAt: "2099-01-01T00:00:00Z",
          },
        },
      });
      expect(action?.type).toBe("fix_ci_failure");
    });
  });

  it("returns null for CODE classification once a PR exists and CI is green", () => {
    const action = pickActionForTicket({
      issue,
      state: {
        ...baseState,
        classification: { classification: "CODE" },
        pr: {
          number: 5,
          state: "open",
          merged: false,
          isDraft: false,
          headSha: "x",
          ciStatus: "green",
          prCommentSignature: "empty",
          openedAt: "2099-01-01T00:00:00Z",
        },
      },
    });
    expect(action).toBeNull();
  });

  describe("nudge_reviewer", () => {
    const NOW = Date.parse("2026-04-25T12:00:00Z");
    const STALE_MS = 72 * 60 * 60 * 1000;

    function stalePr(overrides: Partial<NonNullable<DerivedState["pr"]>> = {}) {
      return {
        ...baseState,
        classification: { classification: "CODE" as const },
        pr: {
          number: 5,
          state: "open" as const,
          merged: false,
          isDraft: false,
          headSha: "x",
          ciStatus: "green" as const,
          prCommentSignature: "empty",
          openedAt: "2026-04-22T00:00:00Z", // 84 hours before NOW
          ...overrides,
        },
      };
    }

    it("fires when CI green, no pending comments, and idle longer than the threshold", () => {
      const action = pickActionForTicket({
        issue,
        state: stalePr(),
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action?.type).toBe("nudge_reviewer");
      expect(action?.priority).toBe(7);
    });

    it("does not fire when the PR is fresh", () => {
      const action = pickActionForTicket({
        issue,
        state: stalePr({ openedAt: "2026-04-25T06:00:00Z" }),
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action).toBeNull();
    });

    it("does not fire when the PR is exactly at the threshold (must be strictly greater)", () => {
      const action = pickActionForTicket({
        issue,
        state: stalePr({ openedAt: "2026-04-22T12:00:00Z" }),
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action).toBeNull();
    });

    it("does not fire when the PR is a draft", () => {
      const action = pickActionForTicket({
        issue,
        state: stalePr({ isDraft: true }),
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action).toBeNull();
    });

    it("does not fire when CI is red (yields to fix_ci_failure)", () => {
      const action = pickActionForTicket({
        issue,
        state: stalePr({ ciStatus: "red" }),
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action?.type).toBe("fix_ci_failure");
    });

    it("does not fire when there are pending review comments (yields to respond_to_pr_review)", () => {
      const action = pickActionForTicket({
        issue,
        state: stalePr({ prCommentSignature: "abc123" }),
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action?.type).toBe("respond_to_pr_review");
    });

    it("does not fire when classification is null (yields to classify)", () => {
      const action = pickActionForTicket({
        issue,
        state: { ...stalePr(), classification: null },
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action?.type).toBe("classify");
    });

    it("does not fire for ANSWER classification", () => {
      const action = pickActionForTicket({
        issue,
        state: { ...stalePr(), classification: { classification: "ANSWER" } },
        now: NOW,
        staleAfterMs: STALE_MS,
      });
      expect(action?.type).toBe("write_answer");
    });
  });
});

describe("pickActionForMention", () => {
  const mentionComment = {
    id: "c1",
    body: "@gary thoughts?",
    createdAt: "2026-04-24T00:00:00Z",
    userId: "u-tanner",
  };

  it("returns pickup_ticket for a pickup analysis", () => {
    const action = pickActionForMention({
      issue,
      state: baseState,
      mention: { kind: "pickup", comment: mentionComment },
    });
    expect(action?.type).toBe("pickup_ticket");
    expect(action?.priority).toBe(1.5);
  });

  it("returns answer_mention for a generic mention", () => {
    const action = pickActionForMention({
      issue,
      state: baseState,
      mention: { kind: "mention", comment: mentionComment },
    });
    expect(action?.type).toBe("answer_mention");
    expect(action?.priority).toBe(2.5);
  });

  it("returns null when no mention applies", () => {
    expect(
      pickActionForMention({
        issue,
        state: baseState,
        mention: { kind: "none" },
      }),
    ).toBeNull();
  });
});

describe("pickHighestPriority", () => {
  it("returns null on empty list", () => {
    expect(pickHighestPriority([])).toBeNull();
  });

  it("picks the lowest-numbered priority", () => {
    const a = pickActionForTicket({ issue, state: baseState })!;
    const b = pickActionForTicket({
      issue: { ...issue, id: "i-2" },
      state: {
        ...baseState,
        issueId: "i-2",
        pr: {
          number: 9,
          state: "open",
          merged: false,
          isDraft: false,
          headSha: "y",
          ciStatus: "red",
          prCommentSignature: "empty",
          openedAt: "2099-01-01T00:00:00Z",
        },
      },
    })!;
    expect(pickHighestPriority([a, b])?.type).toBe("fix_ci_failure");
  });
});
