import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENROUTER_PROVIDER_PREFERENCES, withOpenRouterPreferences, openSpendLedger, SpendLimitError, type SpendLedger, spendReservationMicros } from "../src/spend.ts";
import saved from "./fixtures/openrouter-anthropic-usage-2026-10-28.json";

const ledgers: SpendLedger[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) { try { ledger.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function ledgerAt(path: string): SpendLedger {
  const ledger = openSpendLedger(path);
  ledgers.push(ledger);
  return ledger;
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gary-receipts-test-"));
  dirs.push(dir);
  const path = join(dir, "spend.db");
  const ledger = ledgerAt(path);
  ledger.createCampaign("test", 5);
  ledger.enrollTicket("test", "ticket", 5, { draftPr: true });
  return { ledger, path };
}
type SavedCall = (typeof saved.calls)[number];
/** Rebuild the live content-block shapes (OpenRouter's citations/caller/empty signature) around saved usage. */
function savedContent(call: SavedCall): unknown[] {
  return call.contentBlocks.map((block, i) => block.type === "text" ? { ...block, text: "offline fixture" }
    : block.type === "thinking" ? { ...block, thinking: "offline reasoning" }
    : { ...block, id: `call_offline${i}`, input: {} });
}
function responseBody(usage: Record<string, unknown> = saved.calls[0]!.usage, call: SavedCall = saved.calls[0]!) {
  return { id: "offline-response", model: saved.returnedModel, type: "message", role: "assistant", stop_reason: call.stopReason, content: savedContent(call), usage };
}
function send(ledger: SpendLedger, body: unknown, headers: HeadersInit = {}, ticket = "ticket") {
  const transport = ledger.guardedFetch("openrouter", (async () => Response.json(body, { headers })) as unknown as typeof fetch);
  return ledger.withSpendScope(ticket, () => transport(saved.endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: saved.requestedModel, provider:{data_collection:'deny',max_price:{prompt:0.6,completion:2.4}}, max_tokens: saved.maxTokens, messages: [{ role: "user", content: "offline fixture" }] }),
  }));
}
function rows(path: string, sql: string) {
  const db = new Database(path, { readonly: true });
  try { return db.query(sql).all() as Array<Record<string, unknown>>; } finally { db.close(); }
}

describe("OpenRouter receipt compatibility", () => {
  it.each(saved.calls)("settles preserved usage from local call $call without refunding output allowance", async (call) => {
    const { ledger, path } = setup();
    await send(ledger, responseBody(call.usage, call));
    expect(ledger.status("ticket")?.chargedMicros).toBe(call.expectedChargedMicros);
    expect(ledger.status("ticket")?.unknownAttempts).toBe(0);
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "accepted" }]);
    expect(rows(path, "SELECT input_tokens FROM spend_attempts")).toEqual([{ input_tokens: call.usage.input_tokens + call.usage.cache_read_input_tokens + (call.usage.cache_creation_input_tokens ?? 0) }]);
  });

  it.each([
    { service_tier: "priority" }, { service_tier: "batch" }, { service_tier: "standard_only" }, { service_tier: "" },
    { service_tier: 0 }, { service_tier: false }, { service_tier: {} }, { speed: "fast" }, { speed: "" },
  ])("retains reservation for unpriced response tier or speed %#", async (tier) => {
    const { ledger, path } = setup();
    await send(ledger, responseBody({ ...saved.calls[0]!.usage, ...tier }));
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("openrouter", saved.maxTokens));
    expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "service_tier" }]);
  });

  it.each([
    { changes: { input_tokens: undefined }, reason: "usage_counters" },
    { changes: { cache_creation_input_tokens: null, cost: undefined }, reason: "usage_counters" },
    { changes: { cache_creation_input_tokens: undefined }, reason: "usage_counters" },
    { changes: { cost: -1 }, reason: "provider_cost" },
    { changes: { cost: "0.01" }, reason: "provider_cost" },
    { changes: { is_byok: true }, reason: "usage_fields" },
    { changes: { cache_read_input_tokens: -1 }, reason: "usage_counters" },
    { changes: { output_tokens: 1.5 }, reason: "usage_counters" },
    { changes: { output_tokens: "12" }, reason: "usage_counters" },
    { changes: { reasoning_tokens: 12 }, reason: "usage_fields" },
    { changes: { server_tool_use: { web_search_requests: 1 } }, reason: "usage_fields" },
  ])("standard tier does not bypass counter or unknown-field checks %#", async ({ changes, reason }) => {
    const { ledger, path } = setup();
    await send(ledger, responseBody({ ...saved.calls[0]!.usage, ...changes }));
    expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("openrouter", saved.maxTokens));
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason }]);
  });

  it.each([
    { changes: { role: "user" }, reason: "envelope" },
    { changes: { model: "deepseek-v4-pro-unknown" }, reason: "model_mismatch" },
    { changes: { stop_reason: "new_reason" }, reason: "stop_reason" },
    { changes: { content: [{ type: "server_tool_use" }] }, reason: "content" },
    { changes: { usage: null }, reason: "usage_missing" },
  ])("standard tier does not bypass envelope checks %#", async ({ changes, reason }) => {
    const { ledger, path } = setup();
    await send(ledger, { ...responseBody(), ...changes });
    expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason }]);
  });

  it("still closes on over-limit standard usage and records the reason", async () => {
    const { ledger, path } = setup();
    await expect(send(ledger, responseBody({ ...saved.calls[0]!.usage, output_tokens: saved.maxTokens + 1 }))).rejects.toThrow(SpendLimitError);
    expect(ledger.status("ticket")?.terminalReason).toBe("receipt_exceeds_bounds");
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("openrouter", saved.maxTokens));
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "token_bounds" }]);
  });

  it("does not broaden other providers or enable request-side service tiers", async () => {
    const { ledger, path } = setup();
    let calls = 0;
    const zai = ledger.guardedFetch("z.ai", (async () => { calls++; return Response.json({ ...responseBody(), model: "glm-5.3" }); }) as unknown as typeof fetch);
    await ledger.withSpendScope("ticket", () => zai("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5.3", max_tokens: 2048, messages: [{ role: "user", content: "offline" }] }) }));
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "usage_fields" }]);
    const deepseek = ledger.guardedFetch("openrouter", (async () => { calls++; return Response.json(responseBody()); }) as unknown as typeof fetch);
    await expect(ledger.withSpendScope("ticket", () => deepseek(saved.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: saved.requestedModel, provider:{data_collection:'deny',max_price:{prompt:0.6,completion:2.4}}, max_tokens: 2048, service_tier: "standard", messages: [{ role: "user", content: "offline" }] }) }))).rejects.toThrow(SpendLimitError);
    expect(calls).toBe(1);
  });
});

describe("receipt evidence without historical reconciliation", () => {
  it.each(["closed", "exhausted"])("does not refund when a concurrent writer commits %s during response parsing", async (state) => {
    const { ledger, path } = setup();
    const ready = `${path}.writer-ready`;
    let writer: ReturnType<typeof Bun.spawn> | undefined;
    const body = responseBody();
    const transport = ledger.guardedFetch("openrouter", (async () => {
      const response = Response.json(body);
      const clone = response.clone.bind(response);
      response.clone = () => {
        const copy = clone();
        copy.json = async () => {
          // WAL readers still see 'active' until this competing writer commits.
          // The old separate activity check would pass, then its INSERT would
          // wait for this commit and incorrectly refund the terminal ticket.
          writer = Bun.spawn([process.execPath, "-e", `
            import {Database} from 'bun:sqlite';
            import {writeFileSync} from 'node:fs';
            const db=new Database(${JSON.stringify(path)});
            db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
            db.query("UPDATE spend_tickets SET state=?,terminal_reason='concurrent_stop' WHERE ticket_id='ticket'").run(${JSON.stringify(state)});
            writeFileSync(${JSON.stringify(ready)},'ready');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
            db.exec('COMMIT'); db.close();
          `], { stdout: "pipe", stderr: "pipe" });
          const deadline = Date.now() + 2000;
          while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
          expect(existsSync(ready)).toBe(true);
          return body;
        };
        return copy;
      };
      return response;
    }) as unknown as typeof fetch);
    try {
      await expect(ledger.withSpendScope("ticket", () => transport(saved.endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: saved.requestedModel, provider:{data_collection:'deny',max_price:{prompt:0.6,completion:2.4}}, max_tokens: saved.maxTokens, messages: [{ role: "user", content: "offline" }] }),
      }))).rejects.toThrow("ticket closed while request was in flight");
      expect(await writer!.exited).toBe(0);
      expect(ledger.status("ticket")?.state).toBe(state);
      expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("openrouter", saved.maxTokens));
      expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
      expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "ticket_closed" }]);
    } finally { writer?.kill(); }
  });

  it("keeps legacy unknown charges and exhausted enrollment unchanged across upgrade and new settlements", async () => {
    const { ledger, path } = setup();
    ledger.close();
    const legacy = new Database(path);
    legacy.exec("DROP TABLE spend_receipts"); // Schema before receipt diagnostics.
    legacy.query("UPDATE spend_tickets SET state='exhausted',terminal_reason='reservation_exhausted' WHERE ticket_id='ticket'").run();
    for (const [max, amount] of [[1024, 1_388_176], [512, 1_386_148], [8192, 1_416_561]]) {
      legacy.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state,http_status) VALUES('ticket','deepseek','deepseek-v4-pro',?,?,?,'unknown',200)").run(max!, amount!, amount!);
    }
    const before = legacy.query<Record<string, unknown>, []>("SELECT * FROM spend_attempts ORDER BY id").all();
    const ticketBefore = legacy.query<Record<string, unknown>, []>("SELECT * FROM spend_tickets WHERE ticket_id='ticket'").get()!;
    const campaignBefore = legacy.query<Record<string, unknown>, []>("SELECT * FROM spend_campaigns WHERE id='test'").get()!;
    legacy.close();
    const updated = ledgerAt(path);
    updated.createCampaign("test", 5);
    updated.enrollTicket("test", "ticket", 5, { draftPr: true });
    expect(updated.status("ticket")?.chargedMicros).toBe(4_190_885);
    expect(updated.status("ticket")?.state).toBe("exhausted");
    expect(() => send(updated, responseBody())).toThrow(SpendLimitError);
    expect(rows(path, "SELECT * FROM spend_receipts")).toEqual([]);
    updated.createCampaign("new-campaign", 5);
    updated.enrollTicket("new-campaign", "new-ticket", 5);
    await send(updated, responseBody(), {}, "new-ticket");
    updated.close();
    const reopened = ledgerAt(path);
    expect(reopened.status("ticket")?.unknownAttempts).toBe(3);
    expect(reopened.canDispatch("ticket")).toBe(false);
    expect(rows(path, "SELECT * FROM spend_attempts WHERE ticket_id='ticket' ORDER BY id")).toEqual(before);
    expect(rows(path, "SELECT * FROM spend_tickets WHERE ticket_id='ticket'")).toEqual([ticketBefore]);
    expect(rows(path, "SELECT * FROM spend_campaigns WHERE id='test'")).toEqual([campaignBefore]);
    expect(rows(path, "SELECT attempt_id FROM spend_receipts")).toEqual([{ attempt_id: 4 }]);
  });

  it("a subsequent valid receipt never settles an earlier unknown attempt on the same active ticket", async () => {
    const { ledger, path } = setup();
    await send(ledger, responseBody({ ...saved.calls[0]!.usage, service_tier: "unpriced" }));
    const before = rows(path, "SELECT * FROM spend_attempts WHERE id=1");
    const receiptBefore = rows(path, "SELECT * FROM spend_receipts WHERE attempt_id=1");
    await send(ledger, responseBody());
    expect(rows(path, "SELECT * FROM spend_attempts WHERE id=1")).toEqual(before);
    expect(rows(path, "SELECT * FROM spend_receipts WHERE attempt_id=1")).toEqual(receiptBefore);
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("openrouter", saved.maxTokens) + saved.calls[0]!.expectedChargedMicros);
    expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
  });

  it("records typed counter presence and hashed correlation without provider content, arbitrary strings or headers", async () => {
    const { ledger, path } = setup();
    const secret = "sensitive-value-not-to-persist";
    const body = { ...responseBody({ ...saved.calls[0]!.usage, cache_creation_input_tokens: null, cache_read_input_tokens: undefined, output_tokens: "invalid", [secret]: secret }), id: secret, model: secret, content: [{ type: "text", text: secret }] };
    await send(ledger, body, { "x-request-id": secret, authorization: secret, "x-private-header": secret });
    const receipt = rows(path, "SELECT reason,details_json FROM spend_receipts")[0]!;
    expect(receipt.reason).toBe("model_mismatch");
    const serialized = String(receipt.details_json);
    expect(serialized.includes(secret)).toBe(false);
    expect(serialized.includes("authorization")).toBe(false);
    const details = JSON.parse(serialized);
    const expectedHash = createHash("sha256").update(secret).digest("hex");
    expect(details.responseIdHash).toBe(expectedHash);
    expect(details.requestIdHash).toBe(expectedHash);
    expect(details.responseModelHash).toBe(expectedHash);
    expect(details.modelMatches).toBe(false);
    expect(details.unknownUsageFields).toBe(1);
    expect(details.counters.input_tokens).toEqual({ state: "integer", value: saved.calls[0]!.usage.input_tokens });
    expect(details.counters.cache_creation_input_tokens).toEqual({ state: "null" });
    expect(details.counters.cache_read_input_tokens).toEqual({ state: "missing" });
    expect(details.counters.output_tokens).toEqual({ state: "invalid" });
  });
});

describe("OpenRouter cutover accounting", () => {
  const request = (model = saved.requestedModel) => ({ method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, provider: OPENROUTER_PROVIDER_PREFERENCES, max_tokens: saved.maxTokens, messages: [{ role: "user", content: "offline" }] }) });

  it("charges OpenRouter's billed cost when it exceeds the policy price for the same tokens", async () => {
    const { ledger } = setup();
    // Policy price for these tokens: ceil((6*60 + 2048*240)/100) = 4919 micro-USD.
    expect(saved.calls[0]!.expectedChargedMicros).toBe(4919);
    await send(ledger, responseBody({ ...saved.calls[0]!.usage, cost: 0.006 }));
    expect(ledger.status("ticket")?.chargedMicros).toBe(6000);
    expect(ledger.status("ticket")?.state).toBe("active");
  });

  it("records a billed cost above the reservation and stops the ticket", async () => {
    const { ledger, path } = setup();
    const reservation = spendReservationMicros("openrouter", saved.maxTokens);
    await expect(send(ledger, responseBody({ ...saved.calls[0]!.usage, cost: (reservation + 1) / 1_000_000 }))).rejects.toThrow("billed cost exceeds reservation");
    expect(ledger.status("ticket")?.chargedMicros).toBe(reservation + 1);
    expect(ledger.status("ticket")?.terminalReason).toBe("receipt_exceeds_bounds");
    expect(rows(path, "SELECT state FROM spend_attempts")).toEqual([{ state: "settled" }]);
  });

  it("admits only the reviewed OpenRouter routing preferences, derived from the 60/240 policy", async () => {
    const { ledger } = setup();
    expect(OPENROUTER_PROVIDER_PREFERENCES).toEqual({ data_collection: "deny", max_price: { prompt: 0.6, completion: 2.4 } });
    let calls = 0;
    const inner = (async () => { calls++; return Response.json(responseBody()); }) as unknown as typeof fetch;
    const send = (provider: unknown) => ledger.withSpendScope("ticket", () => ledger.guardedFetch("openrouter", inner)(saved.endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: saved.requestedModel, ...(provider === undefined ? {} : { provider }), max_tokens: saved.maxTokens, messages: [{ role: "user", content: "x" }] }) }));
    for (const provider of [undefined, {}, { data_collection: "allow", max_price: { prompt: 0.6, completion: 2.4 } },
      { data_collection: "deny", max_price: { prompt: 0.61, completion: 2.4 } }, { data_collection: "deny", max_price: { prompt: 0.6, completion: 2.4, request: 1 } },
      { data_collection: "deny", max_price: { prompt: 0.6, completion: 2.4 }, allow_fallbacks: true }, { data_collection: "deny" }])
      await expect(send(provider)).rejects.toThrow("unreviewed provider routing preferences");
    expect(calls).toBe(0);
    // Key order does not matter; values and key sets do.
    await send({ max_price: { completion: 2.4, prompt: 0.6 }, data_collection: "deny" });
    expect(calls).toBe(1);
    const zai = ledger.guardedFetch("z.ai", inner);
    await expect(ledger.withSpendScope("ticket", () => zai("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", provider: OPENROUTER_PROVIDER_PREFERENCES, max_tokens: 16, messages: [{ role: "user", content: "x" }] }) })))
      .rejects.toThrow("unreviewed provider routing preferences");
  });

  it("withOpenRouterPreferences adds the preferences to each JSON request body", async () => {
    const bodies: unknown[] = [];
    const wrapped = withOpenRouterPreferences((async (input: RequestInfo | URL, init?: RequestInit) => { bodies.push(await new Request(input, init).json()); return new Response("{}"); }) as unknown as typeof fetch);
    await wrapped(saved.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: saved.requestedModel, max_tokens: 1 }) });
    expect(bodies).toEqual([{ model: saved.requestedModel, max_tokens: 1, provider: { data_collection: "deny", max_price: { prompt: 0.6, completion: 2.4 } } }]);
  });

  it("requires OpenRouter's billed cost to settle even when every counter is an integer", async () => {
    const { ledger, path } = setup();
    const { cost: _, ...usage } = { ...saved.calls[0]!.usage, cache_creation_input_tokens: 0 };
    await send(ledger, responseBody(usage));
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("openrouter", saved.maxTokens));
    expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "usage_counters" }]);
  });

  it("the saved probe returned the undated model slug that the receipt check requires", () => {
    expect(saved.returnedModel).toBe("deepseek/deepseek-v4.1-flash");
    expect(saved.returnedModel).toBe(saved.requestedModel);
  });

  it("rejects any new request on the retired direct DeepSeek route before HTTP", async () => {
    const { ledger } = setup();
    let calls = 0;
    const inner = (async () => { calls++; return Response.json(responseBody()); }) as unknown as typeof fetch;
    await expect(ledger.withSpendScope("ticket", () => ledger.guardedFetch("deepseek", inner)("https://api.deepseek.com/anthropic/v1/messages", request("deepseek-v4-pro"))))
      .rejects.toThrow("unpriced provider");
    await expect(ledger.withSpendScope("ticket", () => ledger.guardedFetch("openrouter", inner)(saved.endpoint, request("deepseek-v4-pro"))))
      .rejects.toThrow("unpriced model");
    expect(calls).toBe(0);
    expect(ledger.status("ticket")?.attemptCount).toBe(0);
  });

  it("an active coding ticket with settled historical DeepSeek attempts continues on OpenRouter without rewriting them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gary-cutover-test-"));
    dirs.push(dir);
    const path = join(dir, "spend.db");
    const ledger = ledgerAt(path);
    ledger.createCampaign("coding", 10);
    ledger.enrollTicket("coding", "ticket", 10, { draftPr: true, codingReviewReserve: true });
    const sql = new Database(path);
    // Shape of the live pre-cutover rows: full DeepSeek reservation, settled charge, accepted receipt.
    for (const charged of [36_388, 37_438]) {
      const id = Number(sql.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state,input_tokens,http_status,settled_at) VALUES('ticket','deepseek','deepseek-v4-pro',8192,1416561,?,'settled',1000,200,CURRENT_TIMESTAMP)").run(charged).lastInsertRowid);
      sql.query("INSERT INTO spend_receipts(attempt_id,reason,details_json) VALUES(?,'accepted','{}')").run(id);
    }
    const before = sql.query("SELECT * FROM spend_attempts ORDER BY id").all();
    sql.close();
    await send(ledger, responseBody());
    const after = rows(path, "SELECT * FROM spend_attempts ORDER BY id");
    expect(after.slice(0, 2)).toEqual(before as Array<Record<string, unknown>>);
    expect(after[2]).toMatchObject({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", state: "settled",
      reserved_micros: spendReservationMicros("openrouter", saved.maxTokens), charged_micros: saved.calls[0]!.expectedChargedMicros });
    expect(ledger.status("ticket")?.chargedMicros).toBe(36_388 + 37_438 + saved.calls[0]!.expectedChargedMicros);
    expect(ledger.canDispatch("ticket")).toBe(true);
  });

  it("an unresolved historical DeepSeek attempt still blocks the protected coding allocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gary-cutover-test-"));
    dirs.push(dir);
    const path = join(dir, "spend.db");
    const ledger = ledgerAt(path);
    ledger.createCampaign("coding", 10);
    ledger.enrollTicket("coding", "ticket", 10, { draftPr: true, codingReviewReserve: true });
    const sql = new Database(path);
    sql.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES('ticket','deepseek','deepseek-v4-pro',8192,1416561,1416561,'unknown')").run();
    sql.close();
    let calls = 0;
    await expect(ledger.withSpendScope("ticket", () => ledger.guardedFetch("openrouter", (async () => { calls++; return Response.json(responseBody()); }) as unknown as typeof fetch)(saved.endpoint, request())))
      .rejects.toThrow("unresolved request");
    expect(calls).toBe(0);
  });
});
