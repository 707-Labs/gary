import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordReviewPass, type ReviewPassInput } from "../src/state/review-queries.ts";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/state/schema.sql",
);

function freshDb(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.query(
    "INSERT INTO tickets (linear_id, identifier) VALUES ('issue-1', 'ERT-1')",
  ).run();
  return db;
}

describe("recordReviewPass", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts a row with the expected fields", () => {
    const input: ReviewPassInput = {
      issueLinearId: "issue-1",
      fingerprint: "fp-abc",
      round: 1,
      verdict: "approve",
      findingCount: 0,
      advisoryCount: 2,
      providerUsed: "deepseek",
      inputTokens: 12_000,
      outputTokens: 800,
      durationMs: 4_500,
      escalated: false,
    };
    recordReviewPass(db, input);
    const row = db
      .query<{
        issue_id: string;
        verdict: string;
        provider_used: string | null;
        duration_ms: number;
        escalated: number;
      }, []>("SELECT * FROM review_passes ORDER BY id DESC LIMIT 1")
      .get();
    expect(row!.issue_id).toBe("issue-1");
    expect(row!.verdict).toBe("approve");
    expect(row!.provider_used).toBe("deepseek");
    expect(row!.duration_ms).toBe(4_500);
    expect(row!.escalated).toBe(0);
  });

  it("accepts null providerUsed for failed reviews", () => {
    recordReviewPass(db, {
      issueLinearId: "issue-1",
      fingerprint: "fp-fail",
      round: 1,
      verdict: "failed",
      findingCount: 0,
      advisoryCount: 0,
      providerUsed: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: 100,
      escalated: false,
    });
    const row = db
      .query<{ provider_used: string | null }, []>(
        "SELECT provider_used FROM review_passes ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row!.provider_used).toBeNull();
  });
});
