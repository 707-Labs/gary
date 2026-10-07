import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger, SpendLimitError, SPEND_CONTEXT_TOKENS, spendReservationMicros } from "../../src/spend.ts";

const ledgers: SpendLedger[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) { try { ledger.close(); } catch {} }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path = ":memory:"): SpendLedger {
  const ledger = new SpendLedger(path);
  ledgers.push(ledger);
  return ledger;
}

function enrolled(): SpendLedger {
  const ledger = open();
  ledger.createCampaign("offline", 10);
  ledger.enrollTicket("offline", "future", 10, { draftPr: true });
  return ledger;
}

const standardUsage = {
  input_tokens: 887,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 212,
  service_tier: "standard",
};

async function call(ledger: SpendLedger, usage: Record<string, unknown>, maxTokens = 2048, ticket = "future") {
  // Deliberately fake transport: no credentials, network, or provider calls.
  const transport = ledger.guardedFetch("deepseek", (async () => Response.json({
    id: "msg_offline_receipt", type: "message", role: "assistant", model: "deepseek-v4-pro",
    content: [{ type: "text", text: "offline fixture" }], stop_reason: "end_turn", usage,
  })) as unknown as typeof fetch);
  return ledger.withSpendScope(ticket, () => transport(new Request("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", max_tokens: maxTokens, messages: [{ role: "user", content: "offline fixture" }] }),
  })));
}

describe("standard service tier receipt compatibility", () => {
  // Only usage objects are preserved from the 2026-10-07 local synthetic paid
  // validation artifact (calls 2–5). Envelopes here are synthetic; these tests
  // do not establish ERT-3189's missing receipts or reconcile past charges.
  test.each([
    { ...standardUsage },
    { ...standardUsage, input_tokens: 119, cache_read_input_tokens: 1024, output_tokens: 64 },
    { ...standardUsage, input_tokens: 878, output_tokens: 160 },
    { ...standardUsage, input_tokens: 48, cache_read_input_tokens: 1024, output_tokens: 174 },
  ])("settles a compatible future receipt and retains the full output allowance %#", async (usage) => {
    const ledger = enrolled();
    await call(ledger, usage);
    const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    expect(ledger.status("future")).toMatchObject({
      attemptCount: 1, unknownAttempts: 0, state: "active",
      chargedMicros: Math.ceil((input * 132 + 2048 * 396) / 100),
    });
  });

  test("receipts without a service tier remain eligible", async () => {
    const ledger = enrolled();
    const { service_tier: _, ...usage } = standardUsage;
    await call(ledger, usage);
    expect(ledger.status("future")?.unknownAttempts).toBe(0);
    expect(ledger.status("future")?.chargedMicros).toBe(9281);
  });

  test.each([
    { service_tier: "priority" }, { service_tier: "batch" }, { service_tier: "Standard" },
    { service_tier: null }, { service_tier: 0 }, { service_tier: {} },
    { future_charge: 1 }, { reasoning_tokens: 50 }, { server_tool_use: { web_search_requests: 1 } },
    { input_tokens: undefined }, { output_tokens: undefined }, { cache_read_input_tokens: undefined },
    { cache_creation_input_tokens: undefined }, { cache_creation_input_tokens: null },
    { input_tokens: "887" }, { input_tokens: -1 }, { output_tokens: 0.1 },
    { cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])("keeps the complete reservation for an ambiguous future receipt %#", async (overrides) => {
    const ledger = enrolled();
    await call(ledger, { ...standardUsage, ...overrides });
    expect(ledger.status("future")).toMatchObject({
      unknownAttempts: 1, attemptCount: 1, chargedMicros: spendReservationMicros("deepseek", 2048),
    });
  });

  test.each([
    { input_tokens: SPEND_CONTEXT_TOKENS + 1 },
    { input_tokens: SPEND_CONTEXT_TOKENS, cache_read_input_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: Number.MAX_SAFE_INTEGER },
    { output_tokens: 2049 },
  ])("retains reservation and blocks a receipt exceeding the reserved bounds %#", async (overrides) => {
    const ledger = enrolled();
    await expect(call(ledger, { ...standardUsage, ...overrides })).rejects.toBeInstanceOf(SpendLimitError);
    expect(ledger.status("future")).toMatchObject({
      state: "closed", terminalReason: "receipt_exceeds_bounds", unknownAttempts: 1,
      chargedMicros: spendReservationMicros("deepseek", 2048),
    });
    expect(() => ledger.withSpendScope("future", () => {})).toThrow(SpendLimitError);
  });

  test("file-backed reopen preserves old unknown reservations and exhaustion while a new allocation settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gary-receipt-compatibility-"));
    directories.push(directory);
    const path = join(directory, "offline-spend.db");
    let ledger = open(path);
    ledger.createCampaign("offline", 20);
    ledger.enrollTicket("offline", "old-exhausted", 4.849454, { draftPr: true });
    ledger.enrollTicket("offline", "future", 10, { draftPr: true });
    ledger.close();

    // Historical state fixture only, in a disposable database. Deliberately no
    // reconstructed usage/body: the missing receipts cannot authorize refunds.
    const db = new Database(path);
    for (const maxTokens of [1024, 512, 8192]) {
      const reserved = spendReservationMicros("deepseek", maxTokens);
      db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state,http_status) VALUES(?,?,?,?,?,?,'unknown',200)")
        .run("old-exhausted", "deepseek", "deepseek-v4-pro", maxTokens, reserved, reserved);
    }
    db.query("UPDATE spend_tickets SET state='exhausted', terminal_reason='reservation_exhausted' WHERE ticket_id=?").run("old-exhausted");
    const oldRows = db.query("SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id").all("old-exhausted");
    db.close();

    ledger = open(path);
    ledger.createCampaign("offline", 20);
    ledger.enrollTicket("offline", "old-exhausted", 4.849454, { draftPr: true });
    const oldStatus = ledger.status("old-exhausted")!;
    expect(oldStatus).toMatchObject({
      state: "exhausted", terminalReason: "reservation_exhausted", chargedMicros: 4_190_885,
      unknownAttempts: 3, attemptCount: 3, remainingMicros: 658_569,
    });
    expect(() => ledger.withSpendScope("old-exhausted", () => {})).toThrow(SpendLimitError);
    await call(ledger, standardUsage);
    expect(ledger.status("future")).toMatchObject({ chargedMicros: 9281, unknownAttempts: 0 });
    ledger.close();

    ledger = open(path);
    expect(ledger.status("old-exhausted")).toMatchObject({
      state: oldStatus.state, terminalReason: oldStatus.terminalReason, chargedMicros: oldStatus.chargedMicros,
      unknownAttempts: oldStatus.unknownAttempts, attemptCount: oldStatus.attemptCount,
      campaignChargedMicros: 4_190_885 + 9281,
    });
    const readback = new Database(path, { readonly: true });
    expect(readback.query("SELECT * FROM spend_attempts WHERE ticket_id=? ORDER BY id").all("old-exhausted")).toEqual(oldRows);
    readback.close();
  });
});
