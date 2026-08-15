import { describe, expect, it } from "bun:test";
import type { AssignedIssue, IssueComment } from "../src/adapters/linear.ts";
import { renderQuestion } from "../src/handlers/answer.ts";

const issue: AssignedIssue = {
  id: "i-1",
  identifier: "ERT-99",
  title: "Why is /api/decks slow?",
  description: "Latency is 3s on cold start.",
  url: "https://example.linear.app/ERT-99",
  stateName: "Triage",
  stateType: "triage",
  createdAt: "2026-04-24T00:00:00Z",
  updatedAt: "2026-04-24T00:00:00Z",
  creatorId: "u-tanner",
  creatorName: "Tanner",
  teamId: "t-ert",
  teamKey: "ERT",
  blockedBy: [],
};

const garyId = "u-gary";

function comment(
  partial: Partial<IssueComment> & { id: string; createdAt: string },
): IssueComment {
  return {
    body: "",
    userId: null,
    userName: null,
    ...partial,
  };
}

describe("renderQuestion", () => {
  it("renders the description and ticket header", () => {
    const out = renderQuestion(issue, [], garyId);
    expect(out).toContain("Ticket: ERT-99 — Why is /api/decks slow?");
    expect(out).toContain("Latency is 3s on cold start.");
  });

  it("falls back when description is null", () => {
    const out = renderQuestion(
      { ...issue, description: null },
      [],
      garyId,
    );
    expect(out).toContain("(no description)");
  });

  it("highlights the latest non-Gary comment as the current question", () => {
    const comments: IssueComment[] = [
      comment({
        id: "c1",
        userId: "u-tanner",
        userName: "Tanner",
        body: "any progress?",
        createdAt: "2026-04-24T01:00:00Z",
      }),
      comment({
        id: "c2",
        userId: garyId,
        userName: "Gary",
        body: "looking at it now",
        createdAt: "2026-04-24T02:00:00Z",
      }),
      comment({
        id: "c3",
        userId: "u-tanner",
        userName: "Tanner",
        body: "still happening on prod",
        createdAt: "2026-04-24T03:00:00Z",
      }),
    ];
    const out = renderQuestion(issue, comments, garyId);
    // The "Latest" section quotes the most recent non-Gary comment.
    const latestIdx = out.indexOf("Latest from Tanner");
    expect(latestIdx).toBeGreaterThan(-1);
    expect(out.slice(latestIdx)).toContain("still happening on prod");
    // Earlier comments still appear in the chronological thread above.
    expect(out).toContain("any progress?");
    expect(out).toContain("looking at it now");
  });

  it("ignores Gary's own comments when finding the latest question", () => {
    const comments: IssueComment[] = [
      comment({
        id: "c1",
        userId: "u-tanner",
        userName: "Tanner",
        body: "the actual question",
        createdAt: "2026-04-24T01:00:00Z",
      }),
      comment({
        id: "c2",
        userId: garyId,
        userName: "Gary",
        body: "responding now",
        createdAt: "2026-04-24T02:00:00Z",
      }),
    ];
    const out = renderQuestion(issue, comments, garyId);
    expect(out).toContain("Latest from Tanner");
    expect(out).toContain("the actual question");
  });

  it("omits the latest section when no non-Gary comments exist", () => {
    const out = renderQuestion(issue, [], garyId);
    expect(out).not.toContain("Latest from");
  });

  it("orders comments oldest-first regardless of input order", () => {
    const comments: IssueComment[] = [
      comment({
        id: "c2",
        userName: "Tanner",
        body: "second",
        createdAt: "2026-04-24T02:00:00Z",
      }),
      comment({
        id: "c1",
        userName: "Tanner",
        body: "first",
        createdAt: "2026-04-24T01:00:00Z",
      }),
    ];
    const out = renderQuestion(issue, comments, garyId);
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
  });
});
