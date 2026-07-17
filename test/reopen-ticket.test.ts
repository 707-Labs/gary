import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { closeDb, type DB, openDb } from "../src/state/db.ts";
import {
  clearClassification,
  clearTerminalState,
  getLastActionStartedAt,
  getTicket,
  recordActionStart,
  setClassification,
  setTerminalState,
  sqliteTimestampToDate,
  upsertTicket,
} from "../src/state/queries.ts";

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "gary-reopen-"));
  db = openDb(resolve(dir, "gary.db"));
  upsertTicket(db, { linearId: "ticket-1", identifier: "ERT-1" });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("clearTerminalState", () => {
  it("nulls out terminal_state on a previously concluded ticket", () => {
    setTerminalState(db, "ticket-1", "escalated");
    expect(getTicket(db, "ticket-1")?.terminal_state).toBe("escalated");

    clearTerminalState(db, "ticket-1");
    expect(getTicket(db, "ticket-1")?.terminal_state).toBeNull();
  });

  it("is a no-op when terminal_state is already null", () => {
    expect(getTicket(db, "ticket-1")?.terminal_state).toBeNull();
    clearTerminalState(db, "ticket-1");
    expect(getTicket(db, "ticket-1")?.terminal_state).toBeNull();
  });

  it("doesn't touch other columns", () => {
    setClassification(db, {
      linearId: "ticket-1",
      classification: "CODE",
      confidence: 0.9,
      scope: "M",
    });
    setTerminalState(db, "ticket-1", "bounced");

    clearTerminalState(db, "ticket-1");
    const row = getTicket(db, "ticket-1");
    expect(row?.terminal_state).toBeNull();
    expect(row?.classification).toBe("CODE");
    expect(row?.classification_scope).toBe("M");
  });
});

describe("clearClassification", () => {
  it("nulls out all four classification fields", () => {
    setClassification(db, {
      linearId: "ticket-1",
      classification: "BOUNCE",
      confidence: 0.7,
      scope: "L",
    });
    let row = getTicket(db, "ticket-1");
    expect(row?.classification).toBe("BOUNCE");
    expect(row?.classification_confidence).toBe(0.7);
    expect(row?.classification_scope).toBe("L");
    expect(row?.classified_at).not.toBeNull();

    clearClassification(db, "ticket-1");
    row = getTicket(db, "ticket-1");
    expect(row?.classification).toBeNull();
    expect(row?.classification_confidence).toBeNull();
    expect(row?.classification_scope).toBeNull();
    expect(row?.classified_at).toBeNull();
  });

  it("doesn't touch terminal_state", () => {
    setClassification(db, {
      linearId: "ticket-1",
      classification: "BOUNCE",
      confidence: 0.7,
      scope: "L",
    });
    setTerminalState(db, "ticket-1", "bounced");

    clearClassification(db, "ticket-1");
    const row = getTicket(db, "ticket-1");
    expect(row?.classification).toBeNull();
    expect(row?.terminal_state).toBe("bounced");
  });
});

describe("getLastActionStartedAt", () => {
  it("returns null for a ticket with no actions", () => {
    expect(getLastActionStartedAt(db, "ticket-1")).toBeNull();
  });

  it("returns the newest started_at across all actions", () => {
    recordActionStart(db, {
      ticketLinearId: "ticket-1",
      stateFingerprint: "fp-1",
      actionType: "classify",
    });
    const ts = getLastActionStartedAt(db, "ticket-1");
    expect(ts).not.toBeNull();
    // datetime('now') is UTC; the round-trip should land within the last minute.
    const age = Date.now() - sqliteTimestampToDate(ts!).getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);
  });
});

describe("sqliteTimestampToDate", () => {
  it("interprets a SQLite UTC timestamp as UTC, not local time", () => {
    expect(sqliteTimestampToDate("2026-07-17 02:48:35").toISOString()).toBe(
      "2026-07-17T02:48:35.000Z",
    );
  });

  it("passes ISO strings through", () => {
    expect(
      sqliteTimestampToDate("2026-04-25T17:36:22.038Z").toISOString(),
    ).toBe("2026-04-25T17:36:22.038Z");
  });

  it("orders correctly against ISO comment timestamps", () => {
    const action = sqliteTimestampToDate("2026-07-17 02:48:35").getTime();
    const staleComment = new Date("2026-04-25T17:36:22.038Z").getTime();
    const freshComment = new Date("2026-07-17T09:00:00.000Z").getTime();
    expect(staleComment).toBeLessThan(action);
    expect(freshComment).toBeGreaterThan(action);
  });
});

describe("reopen workflow (composed helpers)", () => {
  it("escalated ticket: clearing terminal_state preserves the prior classification", () => {
    // Gary classified this as CODE, started coding, hit an error → escalated.
    setClassification(db, {
      linearId: "ticket-1",
      classification: "CODE",
      confidence: 0.9,
      scope: "M",
    });
    setTerminalState(db, "ticket-1", "escalated");

    // Human reassigns → reopen drops only terminal_state.
    clearTerminalState(db, "ticket-1");

    const row = getTicket(db, "ticket-1");
    expect(row?.terminal_state).toBeNull();
    // Classification kept so Gary picks up where he left off (start_coding).
    expect(row?.classification).toBe("CODE");
  });

  it("bounced ticket: clearing both lets the classifier re-route", () => {
    // Gary bounced this — wrong fit at the time, but human adds clarification.
    setClassification(db, {
      linearId: "ticket-1",
      classification: "BOUNCE",
      confidence: 0.6,
      scope: "S",
    });
    setTerminalState(db, "ticket-1", "bounced");

    clearTerminalState(db, "ticket-1");
    clearClassification(db, "ticket-1");

    const row = getTicket(db, "ticket-1");
    expect(row?.terminal_state).toBeNull();
    expect(row?.classification).toBeNull();
    // The classifier will re-run on the next tick since classification IS NULL.
  });
});
