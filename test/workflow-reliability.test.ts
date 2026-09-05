import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LinearAdapter, type IssueComment } from "../src/adapters/linear.ts";
import { parseFollowupIntent, pendingLinearComments } from "../src/handlers/linear-followup.ts";
import { computeHumanInputSignature } from "../src/state-fingerprint.ts";
import { closeDb, openDb, type DB } from "../src/state/db.ts";
import { countCiAttemptsSince, countConsecutiveWorkFailures, recordActionEnd, recordActionStart, upsertTicket } from "../src/state/queries.ts";

let dir: string;
let db: DB;
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "gary-reliability-"));
  db = openDb(resolve(dir, "state.db"));
  upsertTicket(db, { linearId: "ticket", identifier: "TEST-1" });
});
afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

function action(type: string, success?: boolean, kind?: "work" | "quota" | "nonwork", fp = "input", error?: string) {
  const id = recordActionStart(db, { ticketLinearId: "ticket", actionType: type, stateFingerprint: fp });
  if (success !== undefined) recordActionEnd(db, { id, success, ...(kind ? { failureKind: kind } : {}), ...(error ? { errorMessage: error } : {}) });
  return id;
}
const failures = (fp = "input") => countConsecutiveWorkFailures(db, { ticketLinearId: "ticket", sinceHoursAgo: 6, stateFingerprint: fp });

describe("work failure accounting", () => {
  it("does not bounce healthy discussion or count quota/holds/in-flight work", () => {
    for (let i = 0; i < 6; i++) {
      action("classify", true); action("write_answer", true); action("revisit_code", true);
      action("wait_for_blocker", false); action("start_coding", false, "quota");
      action("revisit_code", false, "nonwork"); action("start_coding");
    }
    expect(failures()).toBe(0);
  });
  it("counts consecutive work failures and ignores intervening quota/nonwork", () => {
    action("start_coding", false, "work");
    action("start_coding", false, "quota"); action("revisit_code", false, "nonwork");
    action("fix_ci_failure", false, "work");
    expect(failures()).toBe(2);
  });
  it("resets on successful work, completed reply, or changed input/head", () => {
    action("start_coding", false, "work"); action("start_coding", true);
    expect(failures()).toBe(0);
    action("revisit_code", false, "work"); action("revisit_code", true);
    expect(failures()).toBe(0);
    action("start_coding", false, "work");
    expect(failures("new-input")).toBe(0);
    action("start_coding", false, "work", "new-input");
    expect(failures("new-input")).toBe(1);
  });
  it("recognizes historical quota rows and compares SQLite dates correctly", () => {
    action("start_coding", false, undefined, "input", "all providers armed; earliest reset unknown");
    const old = action("start_coding", false);
    db.query("UPDATE actions SET started_at=datetime('now', '-7 hours') WHERE id=?").run(old);
    action("start_coding", false);
    expect(failures()).toBe(1);
  });
  it("CI cap counts completed CI attempts only, never the current attempt", () => {
    action("classify", true); action("start_coding", true); action("fix_ci_failure");
    action("fix_ci_failure", false, "quota");
    action("fix_ci_failure", false, undefined, "input", "all providers armed; earliest reset unknown");
    action("fix_ci_failure", true); action("fix_ci_failure", false, "work");
    expect(countCiAttemptsSince(db, { ticketLinearId: "ticket", sinceHoursAgo: 24 })).toBe(2);
  });
  it("migrates an old actions table without dropping rows and reopens idempotently", () => {
    const path = resolve(dir, "old.db");
    const old = new Database(path);
    old.exec("CREATE TABLE actions (id INTEGER PRIMARY KEY, ticket_linear_id TEXT, action_type TEXT, state_fingerprint TEXT, started_at TEXT, completed_at TEXT, success INTEGER, error_message TEXT)");
    old.exec("INSERT INTO actions VALUES (1, 'ticket', 'start_coding', 'input', datetime('now'), datetime('now'), 0, 'timeout')");
    old.close();
    for (let i = 0; i < 2; i++) {
      const migrated = openDb(path);
      expect(countConsecutiveWorkFailures(migrated, { ticketLinearId: "ticket", sinceHoursAgo: 6, stateFingerprint: "input" })).toBe(1);
      expect(migrated.query("SELECT failure_kind FROM actions WHERE id=1").get()).toEqual({ failure_kind: null });
      migrated.close();
    }
  });
});

function comment(i: number, body = "question"): IssueComment {
  return { id: `c${i}`, body, createdAt: new Date(i * 1000).toISOString(), userId: "person", userName: "Person" };
}
const sig = (comments: readonly IssueComment[], description = "context") => computeHumanInputSignature({ comments, description, garyUserId: "worker" });

describe("Linear follow-up input boundaries", () => {
  it("retains all new requests, including a request arriving during prior work", () => {
    const old = [comment(1, "initial context")];
    const current = [...old, comment(2, "add a regression test"), comment(3, "also why does it retry?")];
    expect(pendingLinearComments({ comments: current, description: "context", garyUserId: "worker", previousSignature: sig(old) })).toEqual(current.slice(1));
  });
  it("does not replay an old command when only the description changes", () => {
    const comments = [comment(1, "please fix the typo")];
    expect(pendingLinearComments({ comments, description: "new context", garyUserId: "worker", previousSignature: sig(comments) })).toBeNull();
  });
  it("preserves pending comments beyond the old 20-comment window", () => {
    const old = Array.from({ length: 29 }, (_, i) => comment(i));
    const pending = comment(30, "please add this check");
    expect(pendingLinearComments({ comments: [...old, pending], description: "context", garyUserId: "worker", previousSignature: sig(old) })).toEqual([pending]);
  });
  it("fails closed on unknown history, and uncertain intent remains read-only", () => {
    expect(pendingLinearComments({ comments: [comment(1)], description: "context", garyUserId: "worker", previousSignature: "unknown" })).toBeNull();
    expect(parseFollowupIntent('{"mode":"change","confidence":0.79}')).toBe("answer");
    expect(parseFollowupIntent('{"mode":"change","confidence":0.9}')).toBe("change");
    expect(parseFollowupIntent('{"mode":"answer","confidence":1}')).toBe("answer");
    expect(() => parseFollowupIntent("sure, change it")).toThrow();
  });
});

describe("complete comment snapshots", () => {
  function adapter(pages: (cursor: string | null) => unknown) {
    const instance = Object.create(LinearAdapter.prototype) as LinearAdapter;
    Object.defineProperty(instance, "client", { value: { client: { request: async (_query: string, variables: { after: string | null }) => pages(variables.after) } } });
    return instance;
  }
  it("metadata and bodies paginate the same complete set", async () => {
    const nodes = Array.from({ length: 75 }, (_, i) => ({ id: `c${i}`, body: "test", createdAt: new Date(i * 1000).toISOString(), user: { id: "person", name: "Person" } }));
    const client = adapter(cursor => ({ issue: { comments: { nodes: cursor ? nodes.slice(50) : nodes.slice(0, 50), pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "next" } } } }));
    expect((await client.fetchComments("ticket")).map(c => c.id)).toEqual((await client.fetchCommentMeta("ticket")).map(c => c.id));
    expect(await client.fetchComments("ticket")).toHaveLength(75);
  });
  it("refuses incomplete or repeated pages rather than acknowledging partial history", async () => {
    const missing = adapter(() => ({ issue: { comments: { nodes: [] } } }));
    await expect(missing.fetchComments("ticket")).rejects.toThrow("complete");
    let n = 0;
    const repeated = adapter(() => ({ issue: { comments: { nodes: [{ id: "same", body: "x", createdAt: "now", user: null }], pageInfo: { hasNextPage: true, endCursor: String(n++) } } } }));
    await expect(repeated.fetchComments("ticket")).rejects.toThrow("changed during pagination");
  });
});
