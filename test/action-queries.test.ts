import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countActionsSince,
  markPrClosed,
  recordActionEnd,
  recordActionStart,
  recordPr,
  sqliteTimestamp,
} from "../src/state/queries.ts";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/state/schema.sql",
);

const TICKET = "issue-1";

function freshDb(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.query(
    "INSERT INTO tickets (linear_id, identifier) VALUES ('issue-1', 'ERT-1')",
  ).run();
  return db;
}

/** Insert an action whose started_at is `hoursAgo` in the past, in the
 *  same "YYYY-MM-DD HH:MM:SS" shape `datetime('now')` writes. */
function insertAt(
  db: Database,
  hoursAgo: number,
  opts: { actionType?: string; success?: boolean | null } = {},
): void {
  db.query(
    `INSERT INTO actions (ticket_linear_id, action_type, state_fingerprint, started_at, success)
     VALUES ($t, $a, 'fp', $s, $ok)`,
  ).run({
    t: TICKET,
    a: opts.actionType ?? "classify",
    s: sqliteTimestamp(new Date(Date.now() - hoursAgo * 3_600_000)),
    ok:
      opts.success === undefined || opts.success === null
        ? null
        : opts.success
          ? 1
          : 0,
  });
}

describe("sqliteTimestamp", () => {
  it("matches the shape datetime('now') writes", () => {
    expect(sqliteTimestamp(new Date("2026-08-31T13:00:00.000Z"))).toBe(
      "2026-08-31 13:00:00",
    );
  });
});

describe("countActionsSince", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("counts an action recorded moments ago (regression: ISO cutoff never matched same-day rows)", () => {
    const id = recordActionStart(db, {
      ticketLinearId: TICKET,
      stateFingerprint: "fp",
      actionType: "classify",
    });
    recordActionEnd(db, { id, success: false, errorMessage: "empty" });
    expect(countActionsSince(db, { ticketLinearId: TICKET, sinceHoursAgo: 6 })).toBe(1);
  });

  it("counts same-UTC-day rows deterministically (the ISO cutoff bug was invisible between 00:00 and 06:00 UTC)", () => {
    // Shape of the 2026-08-31 storm: rows at 15:01 UTC, breaker evaluated at 19:00 UTC.
    db.query(
      `INSERT INTO actions (ticket_linear_id, action_type, state_fingerprint, started_at, success)
       VALUES ('issue-1', 'classify', 'fp', '2026-08-31 15:01:16', 0)`,
    ).run();
    const now = new Date("2026-08-31T19:00:00.000Z");
    expect(countActionsSince(db, { ticketLinearId: TICKET, sinceHoursAgo: 6, now })).toBe(1);
    expect(countActionsSince(db, { ticketLinearId: TICKET, sinceHoursAgo: 3, now })).toBe(0);
  });

  it("includes rows inside the window and excludes older ones", () => {
    insertAt(db, 1);
    insertAt(db, 5);
    insertAt(db, 7);
    expect(countActionsSince(db, { ticketLinearId: TICKET, sinceHoursAgo: 6 })).toBe(2);
  });

  it("never counts wait_for_blocker", () => {
    insertAt(db, 1, { actionType: "wait_for_blocker" });
    insertAt(db, 1);
    expect(countActionsSince(db, { ticketLinearId: TICKET, sinceHoursAgo: 6 })).toBe(1);
  });

  it("failedOnly counts failed and never-completed attempts, not successes", () => {
    insertAt(db, 1, { success: true });
    insertAt(db, 1, { success: false });
    insertAt(db, 1, { success: null });
    expect(countActionsSince(db, { ticketLinearId: TICKET, sinceHoursAgo: 6 })).toBe(3);
    expect(
      countActionsSince(db, { ticketLinearId: TICKET, sinceHoursAgo: 6, failedOnly: true }),
    ).toBe(2);
  });

  it("actionType restricts the count to that type", () => {
    insertAt(db, 1, { actionType: "classify" });
    insertAt(db, 1, { actionType: "start_coding" });
    insertAt(db, 1, { actionType: "fix_ci_failure" });
    insertAt(db, 2, { actionType: "fix_ci_failure" });
    expect(
      countActionsSince(db, {
        ticketLinearId: TICKET,
        sinceHoursAgo: 24,
        actionType: "fix_ci_failure",
      }),
    ).toBe(2);
  });
});

describe("markPrClosed", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    recordPr(db, {
      githubId: 42,
      ticketLinearId: TICKET,
      repo: "acme/widgets",
      prNumber: 7,
      branch: "gary/ert-1",
    });
  });

  function row(): { closed_at: string | null; merged: number } {
    return db
      .query<{ closed_at: string | null; merged: number }, [number]>(
        "SELECT closed_at, merged FROM prs WHERE github_id = ?",
      )
      .get(42)!;
  }

  it("starts open and unmerged", () => {
    expect(row()).toEqual({ closed_at: null, merged: 0 });
  });

  it("records the close and merged flag", () => {
    markPrClosed(db, { githubId: 42, merged: true });
    const r = row();
    expect(r.merged).toBe(1);
    expect(r.closed_at).not.toBeNull();
  });

  it("keeps the first closed_at on repeat observations", () => {
    markPrClosed(db, { githubId: 42, merged: false });
    const first = row().closed_at;
    db.query("UPDATE prs SET closed_at = '2026-01-01 00:00:00' WHERE github_id = 42").run();
    markPrClosed(db, { githubId: 42, merged: true });
    expect(row()).toEqual({ closed_at: "2026-01-01 00:00:00", merged: 1 });
    expect(first).not.toBeNull();
  });
});
