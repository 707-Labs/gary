import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/state/db.ts";
import {
  countActionsSince,
  hasActedOn,
  recordActionEnd,
  recordActionStart,
  upsertTicket,
} from "../src/state/queries.ts";

const dirs: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gary-action-outcome-"));
  dirs.push(dir);
  return join(dir, "gary.db");
}

function trackedDb(path: string): Database {
  const db = openDb(path);
  databases.push(db);
  return db;
}

describe("action outcome migration", () => {
  it("backfills legacy rows as unknown without changing success or unrelated columns", () => {
    const path = dbPath();
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_linear_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        state_fingerprint TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        success INTEGER,
        error_message TEXT,
        legacy_note TEXT
      );
      INSERT INTO actions (ticket_linear_id, action_type, state_fingerprint, started_at, success, legacy_note)
      VALUES ('issue-1', 'start_coding', 'handled-fp', '2026-09-01 12:00:00', 1, 'preserve me'),
             ('issue-1', 'start_coding', 'failed-fp', '2026-09-02 12:00:00', 0, NULL),
             ('issue-1', 'start_coding', 'pending-fp', '2026-09-03 12:00:00', NULL, NULL);
    `);
    legacy.close();

    const db = trackedDb(path);
    expect(db.query("SELECT success, outcome, legacy_note FROM actions ORDER BY id").all()).toEqual([
      { success: 1, outcome: "unknown", legacy_note: "preserve me" },
      { success: 0, outcome: "unknown", legacy_note: null },
      { success: null, outcome: "unknown", legacy_note: null },
    ]);
    recordActionEnd(db, { id: 1, success: true, outcome: "blocked" });
    db.close();
    databases.pop();

    const reopened = trackedDb(path);
    expect(reopened.query("SELECT outcome FROM actions WHERE id = 1").get()).toEqual({ outcome: "blocked" });
    const columns = reopened.query<{ name: string }, []>("PRAGMA table_info(actions)").all();
    expect(columns.filter((column) => column.name === "outcome")).toHaveLength(1);
    expect(columns.map((column) => column.name)).toContain("legacy_note");
  });
});

describe("recordActionEnd outcomes", () => {
  it("preserves duplicate suppression and circuit-breaker semantics for a handled escalation", () => {
    const db = trackedDb(dbPath());
    upsertTicket(db, { linearId: "issue-1", identifier: "ERT-1" });
    const action = { ticketLinearId: "issue-1", stateFingerprint: "fp", actionType: "start_coding" };
    const id = recordActionStart(db, action);
    expect(db.query("SELECT success, outcome FROM actions WHERE id = ?").get(id)).toEqual({ success: null, outcome: "unknown" });

    recordActionEnd(db, { id, success: true, outcome: "check_failed" });
    expect(db.query("SELECT success, outcome FROM actions WHERE id = ?").get(id)).toEqual({ success: 1, outcome: "check_failed" });
    expect(hasActedOn(db, action)).toBe(true);
    expect(countActionsSince(db, { ticketLinearId: "issue-1", sinceHoursAgo: 6, failedOnly: true })).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM actions WHERE outcome = 'pr_opened'").get()?.n).toBe(0);
  });

  it("does not infer delivery from a legacy caller's success argument", () => {
    const db = trackedDb(dbPath());
    upsertTicket(db, { linearId: "issue-1", identifier: "ERT-1" });
    const id = recordActionStart(db, { ticketLinearId: "issue-1", stateFingerprint: "fp", actionType: "start_coding" });
    recordActionEnd(db, { id, success: true });
    expect(db.query("SELECT success, outcome FROM actions WHERE id = ?").get(id)).toEqual({ success: 1, outcome: "unknown" });
  });
});
