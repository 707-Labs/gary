import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  AssignedIssue,
  IssueComment,
  LinearAdapter,
} from "../src/adapters/linear.ts";
import { renderHoldComment, runWaitForBlocker } from "../src/handlers/blocked.ts";
import { closeDb, type DB, openDb } from "../src/state/db.ts";
import { upsertTicket } from "../src/state/queries.ts";

const GARY_ID = "u-gary";

const openBlocker = {
  id: "b-1",
  identifier: "ERT-2353",
  stateName: "In Progress",
  stateType: "started",
  isOpen: true,
};

function makeIssue(overrides: Partial<AssignedIssue> = {}): AssignedIssue {
  return {
    id: "i-1",
    identifier: "ERT-2354",
    title: "Deck restore stubs",
    description: "x",
    url: "https://example.linear.app/ERT-2354",
    stateName: "In Progress",
    stateType: "started",
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    creatorId: "u-1",
    creatorName: "Tanner",
    teamId: "t",
    teamKey: "ERT",
    blockedBy: [openBlocker],
    ...overrides,
  };
}

function makeLinear(existingComments: IssueComment[]) {
  const posted: string[] = [];
  const fake = {
    get linearUserId() {
      return GARY_ID;
    },
    async fetchComments() {
      return existingComments;
    },
    async postComment(_issueId: string, body: string) {
      posted.push(body);
      return "c-new";
    },
  };
  return { linear: fake as unknown as LinearAdapter, posted };
}

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "gary-blocked-"));
  db = openDb(resolve(dir, "gary.db"));
  upsertTicket(db, { linearId: "i-1", identifier: "ERT-2354" });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("renderHoldComment", () => {
  it("names the blocker and how to unblock", () => {
    const body = renderHoldComment([openBlocker]);
    expect(body).toContain("ERT-2353 (In Progress)");
    expect(body).toContain("hasn't shipped yet");
    expect(body).toContain("remove it in linear");
  });

  it("pluralizes for multiple blockers", () => {
    const body = renderHoldComment([
      openBlocker,
      { ...openBlocker, id: "b-2", identifier: "ERT-2360", stateName: "Todo" },
    ]);
    expect(body).toContain("ERT-2353 (In Progress) and ERT-2360 (Todo)");
    expect(body).toContain("haven't shipped yet");
    expect(body).toContain("once they land");
  });
});

describe("runWaitForBlocker", () => {
  it("posts a hold comment naming the open blocker", async () => {
    const { linear, posted } = makeLinear([]);
    const result = await runWaitForBlocker({ db, linear }, { issue: makeIssue() });
    expect(result).toEqual({ status: "waiting", commented: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("ERT-2353");
  });

  it("skips the comment when Gary already explained the same blocker set", async () => {
    const prior: IssueComment = {
      id: "c-1",
      body: renderHoldComment([openBlocker]),
      createdAt: "2026-08-15T00:00:00Z",
      userId: GARY_ID,
      userName: "Gary",
    };
    const { linear, posted } = makeLinear([prior]);
    const result = await runWaitForBlocker({ db, linear }, { issue: makeIssue() });
    expect(result.commented).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("re-posts when a NEW blocker appears that the old comment doesn't cover", async () => {
    const prior: IssueComment = {
      id: "c-1",
      body: renderHoldComment([openBlocker]),
      createdAt: "2026-08-15T00:00:00Z",
      userId: GARY_ID,
      userName: "Gary",
    };
    const { linear, posted } = makeLinear([prior]);
    const issue = makeIssue({
      blockedBy: [
        openBlocker,
        { ...openBlocker, id: "b-2", identifier: "ERT-2399" },
      ],
    });
    const result = await runWaitForBlocker({ db, linear }, { issue });
    expect(result.commented).toBe(true);
    expect(posted[0]).toContain("ERT-2399");
  });

  it("does not credit a HUMAN comment that mentions the blocker", async () => {
    const prior: IssueComment = {
      id: "c-1",
      body: `holding off on the code here — ERT-2353 first`,
      createdAt: "2026-08-15T00:00:00Z",
      userId: "u-human",
      userName: "Tanner",
    };
    const { linear, posted } = makeLinear([prior]);
    const result = await runWaitForBlocker({ db, linear }, { issue: makeIssue() });
    expect(result.commented).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it("no-ops when the blockers all closed between fetch and dispatch", async () => {
    const { linear, posted } = makeLinear([]);
    const issue = makeIssue({
      blockedBy: [{ ...openBlocker, stateType: "completed", isOpen: false }],
    });
    const result = await runWaitForBlocker({ db, linear }, { issue });
    expect(result.commented).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("still posts when the comment scan itself fails", async () => {
    const posted: string[] = [];
    const linear = {
      get linearUserId() {
        return GARY_ID;
      },
      async fetchComments() {
        throw new Error("linear 500");
      },
      async postComment(_issueId: string, body: string) {
        posted.push(body);
        return "c-new";
      },
    } as unknown as LinearAdapter;
    const result = await runWaitForBlocker({ db, linear }, { issue: makeIssue() });
    expect(result.commented).toBe(true);
    expect(posted).toHaveLength(1);
  });
});
