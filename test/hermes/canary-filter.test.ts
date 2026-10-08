import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AssignedIssue, LinearAdapter } from "../../src/adapters/linear.ts";
import type { GitHubClient } from "../../src/adapters/github.ts";
import { GLMClient } from "../../src/adapters/glm.ts";
import * as classifier from "../../src/handlers/classifier.ts";
import * as codeHandler from "../../src/handlers/code.ts";
import * as answerHandler from "../../src/handlers/answer.ts";
import { runLoop, tick, type LoopDeps } from "../../src/loop.ts";
import { AllProvidersExhaustedError, createProvider, createProviderChain } from "../../src/providers.ts";
import { openDb, type DB } from "../../src/state/db.ts";
import { getTicket, recordPr, setClassification, setTerminalState, upsertTicket } from "../../src/state/queries.ts";
import { openSpendLedger, type SpendLedger } from "../../src/spend.ts";

const makeIssue = (id: string, identifier: string): AssignedIssue => ({
  id, identifier, title: "Offline intake fixture", description: "A scoped task.",
  url: `https://linear.invalid/${identifier}`, stateName: "Todo", stateType: "unstarted",
  createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
  creatorId: null, creatorName: null, teamId: "team-1", teamKey: "ERT", blockedBy: [],
});
const selected = makeIssue("11111111-1111-4111-8111-111111111111", "ERT-1");
const unrelated = makeIssue("22222222-2222-4222-8222-222222222222", "ERT-2");
let db: DB, deps: LoopDeps, ledger: SpendLedger | undefined;
let assigned: AssignedIssue[], mentioned: AssignedIssue[], metaReads: string[], commentReads: string[];
let posted: string[], pickedUp: string[], mentionBody: string, providerCalls: number;
let classify: ReturnType<typeof spyOn<typeof classifier, "classifyTicket">>;
let comment: ReturnType<typeof spyOn<typeof classifier, "generateClassificationComment">>;
let coding: ReturnType<typeof spyOn<typeof codeHandler, "runCodeHandler">>;
let answer: ReturnType<typeof spyOn<typeof answerHandler, "runAnswerHandler">>;

beforeEach(() => {
  db = openDb(":memory:"); assigned = []; mentioned = []; metaReads = []; commentReads = [];
  posted = []; pickedUp = []; providerCalls = 0; mentionBody = "@gary take this";
  const provider = createProvider({ name: "deepseek", model: "deepseek-v4-pro", apiKey: "offline-only",
    baseUrl: "https://provider.invalid", defaultBackoffMs: 1000 }, { fetch: (async () => {
    providerCalls++; throw new Error("Provider calls forbidden in intake tests");
  }) as unknown as typeof fetch });
  deps = { db, allowedIssueIds: new Set([selected.id]), linear: {
    linearUserId: "gary", fetchAssignedIssues: async () => assigned, fetchMentionedIssues: async () => mentioned,
    fetchCommentMeta: async (id: string) => { metaReads.push(id); return []; },
    fetchComments: async (id: string) => { commentReads.push(id); return [{ id: "comment-" + id,
      body: mentionBody, createdAt: "2026-10-08T00:00:00Z", userId: "human", userName: "Human" }]; },
    moveToInProgress: async () => {}, postComment: async (id: string) => { posted.push(id); },
    reassign: async (id: string) => { pickedUp.push(id); }, unassign: async () => {},
  } as unknown as LinearAdapter, github: {} as GitHubClient,
    glm: new GLMClient(createProviderChain([provider])), cloudflare: null,
    repoMap: new Map([["ERT", "fixture/repo"]]), allowlistedMentionUserIds: ["human"],
    reposDir: "/offline/repos", workspacesDir: "/offline/workspaces", agentLoopMaxIterations: 5,
    agentLoopTimeoutMs: 1000, maxCiAttempts: 3, maxAttemptsPerTicket: 5, circuitBreakerWindowHours: 6,
    stalePrAfterMs: 1000, review: { providerOrder: ["deepseek"], maxRounds: 1, iterationCap: 1, timeoutMs: 1000 } };
  classify = spyOn(classifier, "classifyTicket").mockResolvedValue({ classification: "CODE", confidence: 0.99, scope: "S", reasoning: "Offline fixture" });
  comment = spyOn(classifier, "generateClassificationComment").mockResolvedValue("Offline classification");
  coding = spyOn(codeHandler, "runCodeHandler").mockResolvedValue({ status: "no_changes", branch: "fixture", summary: "Offline fixture" });
  answer = spyOn(answerHandler, "runAnswerHandler").mockResolvedValue({ status: "answered", followup: "Offline answer" });
});
afterEach(() => {
  classify.mockRestore(); comment.mockRestore(); coding.mockRestore(); answer.mockRestore();
  ledger?.close(); ledger = undefined; db.close(); expect(providerCalls).toBe(0);
});
const actions = () => db.query<{ ticket_linear_id: string; action_type: string }, []>(
  "SELECT ticket_linear_id,action_type FROM actions ORDER BY id").all();
function seedCode(issue: AssignedIssue) {
  upsertTicket(db, { linearId: issue.id, identifier: issue.identifier });
  setClassification(db, { linearId: issue.id, classification: "CODE", confidence: 0.99, scope: "S" });
}

test("assigned filter excludes unrelated tickets before discovery, classification and state writes", async () => {
  assigned = [unrelated, selected];
  const result = await tick(deps);
  expect(result.actionsTaken).toEqual(["classify"]); expect(result.candidatesConsidered).toBe(1);
  expect(metaReads).toEqual([selected.id]); expect(commentReads).toEqual([selected.id]);
  expect(classify).toHaveBeenCalledTimes(1); expect(classify.mock.calls[0]![1].issue.id).toBe(selected.id);
  expect(comment).toHaveBeenCalledTimes(1); expect(posted).toEqual([selected.id]);
  expect(getTicket(db, unrelated.id)).toBeNull();
  expect(actions()).toEqual([{ ticket_linear_id: selected.id, action_type: "classify" }]);
});

test("excluded assignment cannot reopen a concluded ticket", async () => {
  assigned = [unrelated]; seedCode(unrelated); setTerminalState(db, unrelated.id, "escalated");
  const before = getTicket(db, unrelated.id);
  expect((await tick(deps)).actionsTaken).toEqual([]);
  expect(getTicket(db, unrelated.id)).toEqual(before); expect(metaReads).toEqual([]); expect(actions()).toEqual([]);
});

test("funded unrelated CODE ticket remains excluded before handler dispatch", async () => {
  assigned = [unrelated, selected]; seedCode(unrelated); seedCode(selected);
  ledger = openSpendLedger(":memory:"); ledger.createCampaign("offline", 10);
  for (const issue of assigned) ledger.enrollTicket("offline", issue.id, 3, { draftPr: true });
  deps.spend = ledger;
  expect((await tick(deps)).actionsTaken).toEqual(["start_coding"]);
  expect(coding).toHaveBeenCalledTimes(1); expect(coding.mock.calls[0]![1].issue.id).toBe(selected.id);
  expect(classify).not.toHaveBeenCalled(); expect(metaReads).toEqual([selected.id]);
  expect(ledger.status(unrelated.id)?.state).toBe("active"); expect(ledger.status(unrelated.id)?.attemptCount).toBe(0);
  expect(actions()).toEqual([{ ticket_linear_id: selected.id, action_type: "start_coding" }]);
});

test("mention filter excludes unrelated pickup before comments, assignment or acknowledgement", async () => {
  mentioned = [unrelated, selected];
  expect((await tick(deps)).actionsTaken).toEqual(["pickup_ticket"]);
  expect(commentReads).toEqual([selected.id]); expect(pickedUp).toEqual([selected.id]); expect(posted).toEqual([selected.id]);
  expect(getTicket(db, unrelated.id)).toBeNull(); expect(classify).not.toHaveBeenCalled();
  expect(actions()).toEqual([{ ticket_linear_id: selected.id, action_type: "pickup_ticket" }]);
});

test("general mentions are filtered before answer acknowledgement and handler execution", async () => {
  mentioned = [unrelated, selected]; mentionBody = "@gary why does this fail?";
  expect((await tick(deps)).actionsTaken).toEqual(["answer_mention"]);
  expect(commentReads).toEqual([selected.id, selected.id]); expect(posted).toEqual([selected.id]);
  expect(answer).toHaveBeenCalledTimes(1); expect(answer.mock.calls[0]![1].issue.id).toBe(selected.id);
  expect(pickedUp).toEqual([]); expect(getTicket(db, unrelated.id)).toBeNull();
});

for (const [label, value] of [
  ["empty", new Set()], ["null", null], ["array", [selected.id]], ["duck-typed has", { has: () => true }],
  ["blank member", new Set([selected.id, ""])], ["padded member", new Set([selected.id, " padded "])],
  ["non-string member", new Set([selected.id, 42])],
] as const) test(`${label} filter fails closed for assigned and mentioned intake`, async () => {
  deps.allowedIssueIds = value as unknown as ReadonlySet<string>;
  assigned = [selected]; mentioned = [unrelated];
  expect(await tick(deps)).toEqual({ candidatesConsidered: 0, actionsTaken: [] });
  expect(metaReads).toEqual([]); expect(commentReads).toEqual([]); expect(posted).toEqual([]); expect(pickedUp).toEqual([]);
  expect(classify).not.toHaveBeenCalled(); expect(coding).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
  expect(actions()).toEqual([]); expect(getTicket(db, selected.id)).toBeNull(); expect(getTicket(db, unrelated.id)).toBeNull();
});

test("filter matches exact issue UUID, not its display identifier", async () => {
  deps.allowedIssueIds = new Set([selected.identifier]); assigned = [selected]; mentioned = [selected];
  expect((await tick(deps)).actionsTaken).toEqual([]); expect(metaReads).toEqual([]); expect(commentReads).toEqual([]);
});

test("omitted filter preserves legacy assigned intake", async () => {
  delete deps.allowedIssueIds; assigned = [unrelated];
  expect((await tick(deps)).actionsTaken).toEqual(["classify"]);
  expect(classify.mock.calls[0]![1].issue.id).toBe(unrelated.id); expect(posted).toEqual([unrelated.id]);
});

test("omitted filter preserves legacy mention intake", async () => {
  delete deps.allowedIssueIds; mentioned = [unrelated];
  expect((await tick(deps)).actionsTaken).toEqual(["pickup_ticket"]);
  expect(pickedUp).toEqual([unrelated.id]); expect(posted).toEqual([unrelated.id]);
});

for (const pipeline of ["assigned", "mention"] as const) test(`revocation during ${pipeline} discovery is rechecked before recording or dispatching an action`, async () => {
  const allowed = new Set([selected.id]); deps.allowedIssueIds = allowed;
  if (pipeline === "assigned") {
    assigned = [selected]; deps.linear.fetchCommentMeta = async () => { allowed.clear(); return []; };
  } else {
    mentioned = [selected]; const read = deps.linear.fetchComments;
    deps.linear.fetchComments = async (...args) => { const result = await read(...args); allowed.clear(); return result; };
  }
  const result = await tick(deps);
  expect(result.candidatesConsidered).toBe(1); expect(result.actionsTaken).toEqual([]); expect(actions()).toEqual([]);
  expect(classify).not.toHaveBeenCalled(); expect(coding).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
  expect(posted).toEqual([]); expect(pickedUp).toEqual([]);
});

function enrollSelected(): SpendLedger {
  ledger = openSpendLedger(":memory:"); ledger.createCampaign("offline", 10);
  ledger.enrollTicket("offline", selected.id, 3, { draftPr: true }); deps.spend = ledger;
  assigned = [selected]; seedCode(selected); return ledger;
}

for (const filtered of [true, false]) test(`generic dispatch failure closes only a selected canary allocation (filtered=${filtered})`, async () => {
  const spend = enrollSelected(); if (!filtered) delete deps.allowedIssueIds;
  coding.mockRejectedValue(new Error("Offline handler failure"));
  expect((await tick(deps)).actionsTaken).toEqual(["start_coding"]);
  expect(spend.status(selected.id)?.state).toBe(filtered ? "closed" : "active");
  expect(spend.status(selected.id)?.terminalReason).toBe(filtered ? "canary_dispatch_failed" : null);
  expect(db.query("SELECT success,outcome,error_message FROM actions").get()).toEqual({
    success: 0, outcome: "error", error_message: "Offline handler failure" });
  await tick(deps);
  expect(coding).toHaveBeenCalledTimes(filtered ? 1 : 2); expect(spend.status(selected.id)?.attemptCount).toBe(0);
});

test("selected canary rate-limit pause preserves its active allocation", async () => {
  const spend = enrollSelected(); coding.mockRejectedValue(new AllProvidersExhaustedError(null));
  expect((await tick(deps)).actionsTaken).toEqual([]);
  expect(spend.status(selected.id)?.state).toBe("active"); expect(spend.status(selected.id)?.terminalReason).toBeNull();
  expect(db.query("SELECT outcome FROM actions").get()).toEqual({ outcome: "rate_limited" });
});

test("tick hook waits for dispatch settlement and is awaited before another poll", async () => {
  enrollSelected(); const controller = new AbortController(); const stages: string[] = [];
  const handlerStarted = Promise.withResolvers<void>(), releaseHandler = Promise.withResolvers<void>();
  const hookStarted = Promise.withResolvers<void>(), releaseHook = Promise.withResolvers<void>();
  let polls = 0;
  deps.linear.fetchAssignedIssues = async () => { polls++; return assigned; };
  coding.mockImplementation(async () => {
    stages.push("handler started"); handlerStarted.resolve(); await releaseHandler.promise;
    stages.push("handler settled"); return { status: "no_changes", branch: "fixture", summary: "Offline" };
  });
  const running = runLoop({ ...deps, intervalMs: 0, signal: controller.signal,
    onTickComplete: async result => {
      stages.push("hook started"); expect(result.actionsTaken).toEqual(["start_coding"]);
      expect(db.query<{ completed_at: string | null }, []>("SELECT completed_at FROM actions").get()?.completed_at).not.toBeNull();
      expect(ledger?.status(selected.id)?.state).toBe("closed"); hookStarted.resolve();
      await releaseHook.promise; stages.push("hook settled"); controller.abort();
    } });
  await handlerStarted.promise; expect(stages).toEqual(["handler started"]);
  releaseHandler.resolve(); await hookStarted.promise;
  expect(stages).toEqual(["handler started", "handler settled", "hook started"]);
  await Bun.sleep(10); expect(polls).toBe(1);
  releaseHook.resolve(); await running;
  expect(stages).toEqual(["handler started", "handler settled", "hook started", "hook settled"]); expect(polls).toBe(1);
});

for (const asynchronous of [false, true]) test(`tick hook failure propagates and prevents another poll (async=${asynchronous})`, async () => {
  let polls = 0; deps.linear.fetchAssignedIssues = async () => { polls++; return []; };
  const failure = new Error("Offline receipt persistence failed");
  const onTickComplete = asynchronous ? async () => { throw failure; } : () => { throw failure; };
  await expect(runLoop({ ...deps, intervalMs: 0, onTickComplete })).rejects.toBe(failure);
  expect(polls).toBe(1); expect(actions()).toEqual([]);
});

test("omitting the tick hook preserves normal abort after the current tick", async () => {
  const controller = new AbortController(); let polls = 0;
  deps.linear.fetchAssignedIssues = async () => { polls++; controller.abort(); return []; };
  await runLoop({ ...deps, intervalMs: 0, signal: controller.signal }); expect(polls).toBe(1);
});

for (const classification of ["ANSWER", "BOUNCE"] as const) test(`canary action scope blocks selected ${classification} work before legacy dispatch`, async () => {
  deps.allowedActionTypes = new Set(["classify", "start_coding"]); assigned = [selected]; seedCode(selected);
  setClassification(db, { linearId: selected.id, classification, confidence: 0.99, scope: "S" });
  expect(await tick(deps)).toEqual({ candidatesConsidered: 0, actionsTaken: [] });
  expect(classify).not.toHaveBeenCalled(); expect(coding).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
  expect(posted).toEqual([]); expect(pickedUp).toEqual([]); expect(actions()).toEqual([]);
});

test("canary action scope blocks legacy CI repair for an existing selected-ticket PR", async () => {
  deps.allowedActionTypes = new Set(["classify", "start_coding"]); assigned = [selected]; seedCode(selected);
  recordPr(db, { githubId: 7, ticketLinearId: selected.id, repo: "fixture/repo", prNumber: 7, branch: "fixture" });
  deps.github = { getPullRequest: async () => ({ number: 7, state: "open", merged: false, headSha: "offline-sha", isDraft: true,
    createdAt: "2026-10-08T00:00:00Z" }), aggregateCiStatus: async () => "red", getPullRequestComments: async () => [] } as unknown as GitHubClient;
  expect(await tick(deps)).toEqual({ candidatesConsidered: 0, actionsTaken: [] });
  expect(classify).not.toHaveBeenCalled(); expect(coding).not.toHaveBeenCalled(); expect(actions()).toEqual([]);
});

test("canary action scope admits classification and coding on successive polls", async () => {
  deps.allowedActionTypes = new Set(["classify", "start_coding"]); assigned = [selected];
  expect((await tick(deps)).actionsTaken).toEqual(["classify"]);
  expect((await tick(deps)).actionsTaken).toEqual(["start_coding"]);
  expect(classify).toHaveBeenCalledTimes(1); expect(coding).toHaveBeenCalledTimes(1);
  expect(actions().map(row => row.action_type)).toEqual(["classify", "start_coding"]);
});

for (const body of ["@gary take this", "@gary what happened?"]) test(`canary action scope blocks mention action: ${body}`, async () => {
  deps.allowedActionTypes = new Set(["classify", "start_coding"]); mentioned = [selected]; mentionBody = body;
  expect(await tick(deps)).toEqual({ candidatesConsidered: 0, actionsTaken: [] });
  expect(posted).toEqual([]); expect(pickedUp).toEqual([]); expect(answer).not.toHaveBeenCalled(); expect(actions()).toEqual([]);
});

for (const [label, value] of [["empty", new Set()], ["null", null], ["array", ["classify"]],
  ["unknown member", new Set(["classify", "invented_action"])]] as const) test(`${label} action scope fails closed`, async () => {
  deps.allowedActionTypes = value as unknown as NonNullable<LoopDeps["allowedActionTypes"]>; assigned = [selected]; mentioned = [unrelated];
  expect(await tick(deps)).toEqual({ candidatesConsidered: 0, actionsTaken: [] });
  expect(classify).not.toHaveBeenCalled(); expect(actions()).toEqual([]); expect(posted).toEqual([]);
});

test("action scope is rechecked after candidate enqueue before recording or dispatch", async () => {
  const allowed = new Set<"classify" | "start_coding">(["classify", "start_coding"]);
  deps.allowedActionTypes = allowed; assigned = [selected];
  deps.linear.fetchMentionedIssues = async () => { allowed.clear(); return []; };
  expect(await tick(deps)).toEqual({ candidatesConsidered: 1, actionsTaken: [] });
  expect(actions()).toEqual([]); expect(classify).not.toHaveBeenCalled(); expect(posted).toEqual([]);
});
