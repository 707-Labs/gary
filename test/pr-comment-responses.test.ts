import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { closeDb, type DB, openDb } from "../src/state/db.ts";
import {
  getRespondedPrCommentIds,
  markPrCommentsResponded,
} from "../src/state/queries.ts";

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "gary-prc-"));
  db = openDb(resolve(dir, "gary.db"));
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("pr_comment_responses", () => {
  it("returns [] when nothing has been recorded", () => {
    expect(getRespondedPrCommentIds(db, 12345)).toEqual([]);
  });

  it("records and reads back ids", () => {
    markPrCommentsResponded(db, 12345, [1, 2, 3]);
    const ids = [...getRespondedPrCommentIds(db, 12345)].sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("is idempotent on duplicate inserts", () => {
    markPrCommentsResponded(db, 12345, [1, 2]);
    markPrCommentsResponded(db, 12345, [2, 3]);
    const ids = [...getRespondedPrCommentIds(db, 12345)].sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("is scoped per PR", () => {
    markPrCommentsResponded(db, 100, [1]);
    markPrCommentsResponded(db, 200, [99]);
    expect(getRespondedPrCommentIds(db, 100)).toEqual([1]);
    expect(getRespondedPrCommentIds(db, 200)).toEqual([99]);
  });

  it("ignores empty input", () => {
    markPrCommentsResponded(db, 100, []);
    expect(getRespondedPrCommentIds(db, 100)).toEqual([]);
  });
});
