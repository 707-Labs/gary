import { describe, expect, it } from "bun:test";
import { mergePrComments } from "../src/adapters/github.ts";

const tanner = { login: "vrennat", type: "User" };
const gary = { login: "gary-707-labs[bot]", type: "Bot" };

describe("mergePrComments — review bodies", () => {
  it("includes a CHANGES_REQUESTED review body as a review_body comment", async () => {
    const out = mergePrComments({
      issueComments: [],
      reviewComments: [],
      reviews: [
        {
          id: 100,
          user: tanner,
          state: "CHANGES_REQUESTED",
          body: "## Request changes\n\nServer-side has issues that need fixing.",
          submitted_at: "2026-04-25T20:32:41Z",
          html_url: "https://github.com/x/y/pull/1#pullrequestreview-100",
        },
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("review_body");
    expect(out[0]!.id).toBe(100);
    expect(out[0]!.authorType).toBe("User");
    expect(out[0]!.body).toContain("need fixing");
  });

  it("includes a COMMENTED review body", async () => {
    const out = mergePrComments({
      issueComments: [],
      reviewComments: [],
      reviews: [
        {
          id: 101,
          user: tanner,
          state: "COMMENTED",
          body: "Two questions before I approve",
          submitted_at: "2026-04-25T20:00:00Z",
          html_url: "https://github.com/x/y/pull/1#pullrequestreview-101",
        },
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("review_body");
  });

  it("excludes APPROVED review bodies even when non-empty", async () => {
    const out = mergePrComments({
      issueComments: [],
      reviewComments: [],
      reviews: [
        {
          id: 102,
          user: tanner,
          state: "APPROVED",
          body: "## Approve\n\nLooks good, ship it.",
          submitted_at: "2026-04-25T20:00:00Z",
          html_url: "https://github.com/x/y/pull/1#pullrequestreview-102",
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it("excludes DISMISSED review bodies", async () => {
    const out = mergePrComments({
      issueComments: [],
      reviewComments: [],
      reviews: [
        {
          id: 103,
          user: tanner,
          state: "DISMISSED",
          body: "Dismissed by author",
          submitted_at: "2026-04-25T20:00:00Z",
          html_url: "x",
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it("excludes CHANGES_REQUESTED reviews with empty/whitespace body", async () => {
    const out = mergePrComments({
      issueComments: [],
      reviewComments: [],
      reviews: [
        { id: 104, user: tanner, state: "CHANGES_REQUESTED", body: "", submitted_at: "2026-04-25T20:00:00Z", html_url: "x" },
        { id: 105, user: tanner, state: "CHANGES_REQUESTED", body: "   \n  ", submitted_at: "2026-04-25T20:00:00Z", html_url: "x" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("preserves authorType=Bot so the User-only filter still excludes Gary's own reviews", async () => {
    const out = mergePrComments({
      issueComments: [],
      reviewComments: [],
      reviews: [
        {
          id: 106,
          user: gary,
          state: "CHANGES_REQUESTED",
          body: "self-review (shouldn't happen but just in case)",
          submitted_at: "2026-04-25T20:00:00Z",
          html_url: "x",
        },
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.authorType).toBe("Bot");
  });

  it("orders the merged stream by createdAt, mixing all three sources", async () => {
    const out = mergePrComments({
      issueComments: [
        { id: 1, user: tanner, body: "issue comment", created_at: "2026-04-25T20:00:00Z", html_url: "x" },
      ],
      reviewComments: [
        { id: 2, user: tanner, body: "inline", created_at: "2026-04-25T20:32:00Z", html_url: "x", path: "f.ts", line: 10 },
      ],
      reviews: [
        { id: 3, user: tanner, state: "CHANGES_REQUESTED", body: "review body", submitted_at: "2026-04-25T20:32:30Z", html_url: "x" },
      ],
    });
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(out.map((c) => c.kind)).toEqual(["issue", "review", "review_body"]);
  });
});
