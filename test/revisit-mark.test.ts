import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { closeDb, type DB, openDb } from "../src/state/db.ts";
import { getRevisitMark, setRevisitMark } from "../src/state/queries.ts";

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "gary-revisit-"));
  db = openDb(resolve(dir, "gary.db"));
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("ticket_revisit_marks", () => {
  it("returns null when no mark exists", () => {
    expect(getRevisitMark(db, "ticket-1")).toBeNull();
  });

  it("stores and reads back a signature", () => {
    setRevisitMark(db, "ticket-1", "sig-abc");
    expect(getRevisitMark(db, "ticket-1")).toBe("sig-abc");
  });

  it("upserts on conflict (overwrites the prior signature)", () => {
    setRevisitMark(db, "ticket-1", "sig-old");
    setRevisitMark(db, "ticket-1", "sig-new");
    expect(getRevisitMark(db, "ticket-1")).toBe("sig-new");
  });

  it("is scoped per ticket", () => {
    setRevisitMark(db, "ticket-1", "sig-1");
    setRevisitMark(db, "ticket-2", "sig-2");
    expect(getRevisitMark(db, "ticket-1")).toBe("sig-1");
    expect(getRevisitMark(db, "ticket-2")).toBe("sig-2");
  });
});
