import { describe, expect, it } from "bun:test";
import type { AssignedIssue } from "../src/adapters/linear.ts";
import {
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
};

const baseState: DerivedState = {
  issueId: issue.id,
  issueIdentifier: issue.identifier,
  issueUpdatedAt: issue.updatedAt,
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
        },
      },
    });
    expect(action?.type).toBe("fix_ci_failure");
    expect(action?.priority).toBe(1);
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
        },
      },
    });
    expect(action).toBeNull();
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
        },
      },
    })!;
    expect(pickHighestPriority([a, b])?.type).toBe("fix_ci_failure");
  });
});
