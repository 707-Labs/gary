import { describe, expect, it } from "bun:test";
import { redactGitHubTokens, redactValue } from "../src/redact.ts";

describe("redactGitHubTokens", () => {
  it("redacts an installation token URL", () => {
    const input =
      "git push https://x-access-token:ghs_00000000000000000000000000000000FAKE@github.com/707-Labs/ertai.git ERT-1583";
    expect(redactGitHubTokens(input)).toBe(
      "git push https://x-access-token:[REDACTED]@github.com/707-Labs/ertai.git ERT-1583",
    );
  });

  it("redacts a PAT URL", () => {
    const input =
      "fetch https://x-access-token:ghp_AbCdEfGhIjKlMnOp@github.com/707-Labs/birdup.git";
    expect(redactGitHubTokens(input)).toBe(
      "fetch https://x-access-token:[REDACTED]@github.com/707-Labs/birdup.git",
    );
  });

  it("redacts multiple URLs in one string", () => {
    const input =
      "https://x-access-token:tok1@github.com/a/b.git → https://x-access-token:tok2@github.com/c/d.git";
    expect(redactGitHubTokens(input)).toBe(
      "https://x-access-token:[REDACTED]@github.com/a/b.git → https://x-access-token:[REDACTED]@github.com/c/d.git",
    );
  });

  it("leaves clean URLs alone", () => {
    const input = "git remote https://github.com/707-Labs/ertai.git";
    expect(redactGitHubTokens(input)).toBe(input);
  });

  it("does not match bare token-looking strings outside the URL prefix", () => {
    const input = "ghs_00000000000000000000000000000000FAKE is a token";
    expect(redactGitHubTokens(input)).toBe(input);
  });

  it("handles URLs with line breaks elsewhere in the string", () => {
    const input =
      "error from git:\nhttps://x-access-token:ghs_secret@github.com/a/b.git\nfailed";
    expect(redactGitHubTokens(input)).toBe(
      "error from git:\nhttps://x-access-token:[REDACTED]@github.com/a/b.git\nfailed",
    );
  });
});

describe("redactValue", () => {
  it("redacts strings", () => {
    expect(redactValue("https://x-access-token:abc@github.com/a/b.git")).toBe(
      "https://x-access-token:[REDACTED]@github.com/a/b.git",
    );
  });

  it("redacts inside arrays", () => {
    expect(
      redactValue(["clean", "https://x-access-token:abc@github.com/a/b.git"]),
    ).toEqual(["clean", "https://x-access-token:[REDACTED]@github.com/a/b.git"]);
  });

  it("redacts inside nested objects", () => {
    expect(
      redactValue({
        msg: "fail",
        error: "https://x-access-token:abc@github.com/a/b.git refused",
        meta: { details: "https://x-access-token:def@github.com/c/d.git" },
      }),
    ).toEqual({
      msg: "fail",
      error: "https://x-access-token:[REDACTED]@github.com/a/b.git refused",
      meta: { details: "https://x-access-token:[REDACTED]@github.com/c/d.git" },
    });
  });

  it("leaves numbers, booleans, and nulls alone", () => {
    expect(redactValue({ count: 5, ok: true, payload: null })).toEqual({
      count: 5,
      ok: true,
      payload: null,
    });
  });
});
