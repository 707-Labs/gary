import { describe, expect, it } from "bun:test";
import {
  analyzeMentions,
  looksLikeMention,
  looksLikePickup,
  type MentionableComment,
} from "../src/mention.ts";

describe("looksLikePickup", () => {
  it.each([
    "@gary take this",
    "@gary, take this",
    "@gary take it",
    "@gary pick this up",
    "@gary, pick it up",
    "@gary handle this",
    "@gary handle it",
    "@gary grab this",
    "@gary grab it",
    "Hey @gary take this and run with it",
    "@Gary TAKE THIS",
  ])("matches %s", (body) => {
    expect(looksLikePickup(body)).toBe(true);
  });

  it.each([
    "thanks @gary",
    "@gary what do you think?",
    "@gary please look at this",
    "take this",
    "pick this up",
    "@gary's idea was good",
    "@gary",
  ])("does not match %s", (body) => {
    expect(looksLikePickup(body)).toBe(false);
  });
});

describe("looksLikeMention", () => {
  it("matches @gary in any context", () => {
    expect(looksLikeMention("hey @gary, thoughts?")).toBe(true);
    expect(looksLikeMention("@Gary please")).toBe(true);
  });

  it("does not match other words", () => {
    expect(looksLikeMention("garyis tired")).toBe(false);
    expect(looksLikeMention("the @garys would")).toBe(false);
  });
});

const garyId = "u-gary";

function comment(
  partial: Partial<MentionableComment> & { id: string; createdAt: string },
): MentionableComment {
  return { body: "", userId: null, ...partial };
}

describe("analyzeMentions", () => {
  it("returns none when allowlist is empty", () => {
    expect(
      analyzeMentions({
        comments: [
          comment({
            id: "c1",
            userId: "u-tanner",
            body: "@gary take this",
            createdAt: "2026-04-24T00:00:00Z",
          }),
        ],
        garyUserId: garyId,
        allowlistedUserIds: [],
      }),
    ).toEqual({ kind: "none" });
  });

  it("ignores comments from non-allowlisted users", () => {
    expect(
      analyzeMentions({
        comments: [
          comment({
            id: "c1",
            userId: "u-stranger",
            body: "@gary take this",
            createdAt: "2026-04-24T00:00:00Z",
          }),
        ],
        garyUserId: garyId,
        allowlistedUserIds: ["u-tanner"],
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns pickup when allowlisted user issues a pickup phrase", () => {
    const result = analyzeMentions({
      comments: [
        comment({
          id: "c1",
          userId: "u-tanner",
          body: "@gary take this please",
          createdAt: "2026-04-24T00:00:00Z",
        }),
      ],
      garyUserId: garyId,
      allowlistedUserIds: ["u-tanner"],
    });
    expect(result.kind).toBe("pickup");
  });

  it("returns mention when allowlisted user @gary's without pickup phrase", () => {
    const result = analyzeMentions({
      comments: [
        comment({
          id: "c1",
          userId: "u-tanner",
          body: "@gary what do you think about this?",
          createdAt: "2026-04-24T00:00:00Z",
        }),
      ],
      garyUserId: garyId,
      allowlistedUserIds: ["u-tanner"],
    });
    expect(result.kind).toBe("mention");
  });

  it("uses the most recent allowlisted comment when both kinds exist", () => {
    const result = analyzeMentions({
      comments: [
        comment({
          id: "c1",
          userId: "u-tanner",
          body: "@gary thoughts?",
          createdAt: "2026-04-24T00:00:00Z",
        }),
        comment({
          id: "c2",
          userId: "u-tanner",
          body: "@gary take this",
          createdAt: "2026-04-24T01:00:00Z",
        }),
      ],
      garyUserId: garyId,
      allowlistedUserIds: ["u-tanner"],
    });
    expect(result.kind).toBe("pickup");
    if (result.kind === "pickup") {
      expect(result.comment.id).toBe("c2");
    }
  });

  it("ignores Gary's own comments", () => {
    const result = analyzeMentions({
      comments: [
        comment({
          id: "c1",
          userId: garyId,
          body: "@gary take this (Gary echoing himself)",
          createdAt: "2026-04-24T00:00:00Z",
        }),
      ],
      garyUserId: garyId,
      allowlistedUserIds: [garyId],
    });
    expect(result).toEqual({ kind: "none" });
  });
});
