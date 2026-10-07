import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSpendLedger, SpendLimitError, type SpendLedger, spendReservationMicros } from "../src/spend.ts";
import saved from "./fixtures/deepseek-anthropic-usage-2026-10-07.json";

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
function responseBody(usage: Record<string, unknown> = saved.calls[0]!.usage) {
  return { id: "offline-response", model: saved.requestedModel, type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "offline fixture" }], usage };
}
function send(ledger: SpendLedger, body: unknown, headers: HeadersInit = {}, ticket = "ticket") {
  const transport = ledger.guardedFetch("deepseek", (async () => Response.json(body, { headers })) as unknown as typeof fetch);
  return ledger.withSpendScope(ticket, () => transport(saved.endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: saved.requestedModel, max_tokens: saved.maxTokens, messages: [{ role: "user", content: "offline fixture" }] }),
  }));
}
function rows(path: string, sql: string) {
  const db = new Database(path, { readonly: true });
  try { return db.query(sql).all() as Array<Record<string, unknown>>; } finally { db.close(); }
}

describe("DeepSeek standard receipt compatibility", () => {
  it.each(saved.calls)("settles preserved usage from local call $call without refunding output allowance", async (call) => {
    const { ledger, path } = setup();
    await send(ledger, responseBody(call.usage));
    expect(ledger.status("ticket")?.chargedMicros).toBe(call.expectedChargedMicros);
    expect(ledger.status("ticket")?.unknownAttempts).toBe(0);
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "accepted" }]);
    expect(rows(path, "SELECT input_tokens FROM spend_attempts")).toEqual([{ input_tokens: call.usage.input_tokens + call.usage.cache_read_input_tokens + call.usage.cache_creation_input_tokens }]);
  });

  it.each(["priority", "batch", "standard_only", "", null, 0, false, {}])("retains reservation for unpriced response tier %#", async (tier) => {
    const { ledger, path } = setup();
    await send(ledger, responseBody({ ...saved.calls[0]!.usage, service_tier: tier }));
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("deepseek", saved.maxTokens));
    expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "service_tier" }]);
  });

  it.each([
    { changes: { input_tokens: undefined }, reason: "usage_counters" },
    { changes: { cache_creation_input_tokens: null }, reason: "usage_counters" },
    { changes: { cache_read_input_tokens: -1 }, reason: "usage_counters" },
    { changes: { output_tokens: 1.5 }, reason: "usage_counters" },
    { changes: { output_tokens: "12" }, reason: "usage_counters" },
    { changes: { reasoning_tokens: 12 }, reason: "usage_fields" },
    { changes: { server_tool_use: { web_search_requests: 1 } }, reason: "usage_fields" },
  ])("standard tier does not bypass counter or unknown-field checks %#", async ({ changes, reason }) => {
    const { ledger, path } = setup();
    await send(ledger, responseBody({ ...saved.calls[0]!.usage, ...changes }));
    expect(ledger.status("ticket")?.unknownAttempts).toBe(1);
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("deepseek", saved.maxTokens));
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
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("deepseek", saved.maxTokens));
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "token_bounds" }]);
  });

  it("does not broaden other providers or enable request-side service tiers", async () => {
    const { ledger, path } = setup();
    let calls = 0;
    const zai = ledger.guardedFetch("z.ai", (async () => { calls++; return Response.json({ ...responseBody(), model: "glm-5.3" }); }) as unknown as typeof fetch);
    await ledger.withSpendScope("ticket", () => zai("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5.3", max_tokens: 2048, messages: [{ role: "user", content: "offline" }] }) }));
    expect(rows(path, "SELECT reason FROM spend_receipts")).toEqual([{ reason: "usage_fields" }]);
    const deepseek = ledger.guardedFetch("deepseek", (async () => { calls++; return Response.json(responseBody()); }) as unknown as typeof fetch);
    await expect(ledger.withSpendScope("ticket", () => deepseek(saved.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: saved.requestedModel, max_tokens: 2048, service_tier: "standard", messages: [{ role: "user", content: "offline" }] }) }))).rejects.toThrow(SpendLimitError);
    expect(calls).toBe(1);
  });
});

describe("receipt evidence without historical reconciliation", () => {
  it.each(["closed", "exhausted"])("does not refund when a concurrent writer commits %s during response parsing", async (state) => {
    const { ledger, path } = setup();
    const ready = `${path}.writer-ready`;
    let writer: ReturnType<typeof Bun.spawn> | undefined;
    const body = responseBody();
    const transport = ledger.guardedFetch("deepseek", (async () => {
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
        body: JSON.stringify({ model: saved.requestedModel, max_tokens: saved.maxTokens, messages: [{ role: "user", content: "offline" }] }),
      }))).rejects.toThrow("ticket closed while request was in flight");
      expect(await writer!.exited).toBe(0);
      expect(ledger.status("ticket")?.state).toBe(state);
      expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("deepseek", saved.maxTokens));
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
    expect(ledger.status("ticket")?.chargedMicros).toBe(spendReservationMicros("deepseek", saved.maxTokens) + saved.calls[0]!.expectedChargedMicros);
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
    expect(details.counters.input_tokens).toEqual({ state: "integer", value: 887 });
    expect(details.counters.cache_creation_input_tokens).toEqual({ state: "null" });
    expect(details.counters.cache_read_input_tokens).toEqual({ state: "missing" });
    expect(details.counters.output_tokens).toEqual({ state: "invalid" });
  });
});
