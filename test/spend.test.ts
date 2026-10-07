import { afterEach, describe, expect, it } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { GLMClient } from "../src/adapters/glm.ts";
import { createProvider, createProviderChain } from "../src/providers.ts";
import { openSpendLedger, SpendLimitError, type SpendLedger, spendReservationMicros, SPEND_CONTEXT_TOKENS } from "../src/spend.ts";

const DEEPSEEK_URL = "https://api.deepseek.com/anthropic/v1/messages";
const ZAI_URL = "https://api.z.ai/api/anthropic/v1/messages";
const ledgers: SpendLedger[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) { try { ledger.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "gary-spend-test-"));
  dirs.push(dir);
  return dir;
}
function ledgerAt(path = ":memory:", cap = 4.849454): SpendLedger {
  const ledger = openSpendLedger(path);
  ledgers.push(ledger);
  ledger.createCampaign("campaign", cap);
  ledger.enrollTicket("campaign", "ERT-3189", cap, { draftPr: true });
  return ledger;
}
function request(overrides: Record<string, unknown> = {}, url = DEEPSEEK_URL): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-secret" }, body: JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 8192, messages: [{ role: "user", content: "PRIVATE PROMPT DO NOT PERSIST" }], ...overrides }) });
}
function receipt(usage: Record<string, unknown> = {}, model = "deepseek-v4-pro"): Response {
  return Response.json({ id: "msg_offline", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 300, ...usage } });
}
function fakeFetch(fn: (request: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => fn(new Request(input, init))) as typeof fetch;
}
function scoped(ledger: SpendLedger, transport: typeof fetch, req = request()) {
  return ledger.withSpendScope("ERT-3189", () => transport(req));
}

describe("durable spending allocation", () => {
  it("reserves full input context at uncached peak price and full capped output", () => {
    expect(spendReservationMicros("deepseek")).toBe(1_416_561);
    expect(spendReservationMicros("z.ai")).toBe(1_504_052);
    expect(() => spendReservationMicros("kimi")).toThrow(SpendLimitError);
    expect(() => spendReservationMicros("deepseek", 8193)).toThrow(SpendLimitError);
  });

  it("enrollment is immutable, campaign caps cannot be overallocated, and closure cannot renew", () => {
    const ledger = ledgerAt();
    expect(ledger.status("ERT-3189")?.draftPr).toBe(true);
    expect(ledger.status("missing")).toBeNull();
    expect(ledger.canDispatch("missing")).toBe(false);
    expect(() => ledger.createCampaign("campaign", 10)).toThrow(SpendLimitError);
    expect(() => ledger.enrollTicket("campaign", "ERT-3189", 5)).toThrow(SpendLimitError);
    expect(() => ledger.enrollTicket("campaign", "ERT-3189", 4.849454, { draftPr: false })).toThrow(SpendLimitError);
    expect(() => ledger.enrollTicket("campaign", "other", 0.1)).toThrow(SpendLimitError);
    ledger.markTerminal("ERT-3189", "pr_opened");
    ledger.enrollTicket("campaign", "ERT-3189", 4.849454, { draftPr: true });
    expect(ledger.status("ERT-3189")?.terminalReason).toBe("pr_opened");
    expect(ledger.canDispatch("ERT-3189")).toBe(false);
    expect(() => ledger.withSpendScope("ERT-3189", () => {})).toThrow(SpendLimitError);
  });

  it("rejects unsafe monetary inputs without rounding extra authorization", () => {
    const ledger = openSpendLedger(":memory:");
    ledgers.push(ledger);
    for (const cap of [0, -1, NaN, Infinity, 1001, 0.0000001]) expect(() => ledger.createCampaign("bad", cap)).toThrow(SpendLimitError);
    ledger.createCampaign("exact", 4.849454);
  });

  it("no HTTP request escapes without an enrolled active ticket scope", async () => {
    const ledger = ledgerAt();
    let calls = 0;
    const transport = ledger.guardedFetch("deepseek", fakeFetch(() => { calls++; return receipt(); }));
    await expect(transport(request())).rejects.toBeInstanceOf(SpendLimitError);
    expect(() => ledger.withSpendScope("missing", () => transport(request()))).toThrow(SpendLimitError);
    expect(calls).toBe(0);
  });

  it("scope propagates to review/subagent promises and cannot switch allocations", async () => {
    const ledger = ledgerAt();
    ledger.createCampaign("second", 5);
    ledger.enrollTicket("second", "other", 5);
    const transport = ledger.guardedFetch("deepseek", fakeFetch(() => receipt()));
    await ledger.withSpendScope("ERT-3189", async () => {
      expect(() => ledger.withSpendScope("other", () => {})).toThrow(SpendLimitError);
      await Promise.all([Promise.resolve().then(() => transport(request())), Promise.resolve().then(() => transport(request()))]);
    });
    expect(ledger.status("ERT-3189")?.attemptCount).toBe(2);
    expect(ledger.status("other")?.attemptCount).toBe(0);
  });

  it("settles all explicit input counters at uncached rates while retaining full output allowance", async () => {
    const ledger = ledgerAt();
    let completedCalls = 0;
    const transport = ledger.guardedFetch("deepseek", fakeFetch((req) => {
      expect(req.redirect).toBe("manual");
      expect(ledger.status("ERT-3189")?.chargedMicros).toBe(1_416_561 + completedCalls * 33_233);
      completedCalls++;
      return receipt();
    }));
    const response = await scoped(ledger, transport);
    expect((await response.json()).content[0].text).toBe("ok");
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(Math.ceil((600 * 132 + 8192 * 396) / 100));
    expect(ledger.status("ERT-3189")?.unknownAttempts).toBe(0);
    for (let i = 0; i < 10; i++) await scoped(ledger, transport);
    expect(ledger.status("ERT-3189")?.attemptCount).toBe(11);
    expect(ledger.status("ERT-3189")?.chargedMicros).toBeLessThan(400_000);
  });

  it.each([
    { cache_read_input_tokens: undefined },
    { cache_creation_input_tokens: null },
    { input_tokens: -1 },
    { output_tokens: 0.1 },
    { cache_creation_input_tokens: "300" },
    { reasoning_tokens: 100 },
    { server_tool_use: { web_search_requests: 1 } },
  ])("does not refund ambiguous or incomplete usage %#", async (usage) => {
    const ledger = ledgerAt();
    await scoped(ledger, ledger.guardedFetch("deepseek", fakeFetch(() => receipt(usage))));
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(1_416_561);
    expect(ledger.status("ERT-3189")?.unknownAttempts).toBe(1);
  });

  it("retains timeout/error reservations across restarts and permanently latches exhaustion", async () => {
    const path = join(directory(), "ledger.db");
    let ledger = ledgerAt(path, 3);
    let calls = 0;
    const inner = fakeFetch(() => { calls++; throw new Error("timeout with uncertain provider outcome"); });
    for (let i = 0; i < 2; i++) await expect(scoped(ledger, ledger.guardedFetch("deepseek", inner))).rejects.toThrow("timeout");
    ledger.close();
    ledger = ledgerAt(path, 3);
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(2_833_122);
    expect(ledger.canDispatch("ERT-3189")).toBe(false);
    // Admission check alone does not close a completed result's publication path.
    expect(ledger.status("ERT-3189")?.state).toBe("active");
    await expect(scoped(ledger, ledger.guardedFetch("deepseek", inner))).rejects.toThrow("allocation exhausted");
    expect(calls).toBe(2);
    ledger.close();
    ledger = ledgerAt(path, 3);
    expect(ledger.status("ERT-3189")?.state).toBe("exhausted");
    expect(ledger.status("ERT-3189")?.terminalReason).toBe("reservation_exhausted");
    expect(() => ledger.withSpendScope("ERT-3189", () => {})).toThrow(SpendLimitError);
  });

  it("commits reservation before process crash, without retaining prompts or secrets", () => {
    const dir = directory();
    const path = join(dir, "ledger.db");
    const ledger = ledgerAt(path, 3);
    const childPath = join(dir, "crash.ts");
    writeFileSync(childPath, `import {openSpendLedger} from ${JSON.stringify(resolve("src/spend.ts"))};
      const l=openSpendLedger(${JSON.stringify(path)});
      await l.withSpendScope('ERT-3189',()=>l.guardedFetch('deepseek',async()=>{process.exit(0)})(new Request(${JSON.stringify(DEEPSEEK_URL)},{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fake-secret'},body:JSON.stringify({model:'deepseek-v4-pro',max_tokens:8192,messages:[{role:'user',content:'PRIVATE PROMPT DO NOT PERSIST'}]})})));`);
    const child = Bun.spawnSync([process.execPath, childPath]);
    expect(child.exitCode).toBe(0);
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(1_416_561);
    expect(ledger.status("ERT-3189")?.unknownAttempts).toBe(1);
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT state FROM spend_attempts").get()).toEqual({ state: "reserved" });
    db.close();
    ledger.close();
    expect(readFileSync(path).includes(Buffer.from("fake-secret"))).toBe(false);
    expect(readFileSync(path).includes(Buffer.from("PRIVATE PROMPT"))).toBe(false);
  });

  it("atomically bounds simultaneous requests across ledger connections and does not clear exhaustion on late settlement", async () => {
    const path = join(directory(), "ledger.db");
    const a = ledgerAt(path, 3);
    const b = ledgerAt(path, 3);
    let releases: Array<() => void> = [];
    let calls = 0;
    const inner = fakeFetch(async () => {
      calls++;
      await new Promise<void>((resolve) => releases.push(resolve));
      return receipt();
    });
    const first = scoped(a, a.guardedFetch("deepseek", inner)).catch((error) => error);
    const second = scoped(b, b.guardedFetch("deepseek", inner)).catch((error) => error);
    while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(a.status("ERT-3189")?.chargedMicros).toBe(2_833_122);
    await expect(scoped(b, b.guardedFetch("deepseek", inner))).rejects.toThrow("allocation exhausted");
    expect(calls).toBe(2);
    releases.forEach((release) => release());
    const rejected = await Promise.all([first, second]);
    expect(rejected.every((error) => error instanceof SpendLimitError)).toBe(true);
    expect(a.status("ERT-3189")?.chargedMicros).toBe(2_833_122);
    expect(a.status("ERT-3189")?.state).toBe("exhausted");
  });

  it("closing a ticket revokes an in-flight completion without releasing its reservation", async () => {
    const ledger = ledgerAt();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const transport = ledger.guardedFetch("deepseek", fakeFetch(async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return receipt();
    }));
    const result = scoped(ledger, transport).catch((error) => error);
    await ready;
    ledger.markTerminal("ERT-3189", "operator_stopped");
    release();
    expect(await result).toBeInstanceOf(SpendLimitError);
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(1_416_561);
    expect(ledger.status("ERT-3189")?.terminalReason).toBe("operator_stopped");
  });

  it("rechecks state after asynchronous validation, before network send", async () => {
    const ledger = ledgerAt();
    let calls = 0;
    const result = scoped(ledger, ledger.guardedFetch("deepseek", fakeFetch(() => { calls++; return receipt(); })));
    ledger.markTerminal("ERT-3189", "operator_stopped");
    await expect(result).rejects.toThrow("not actively enrolled");
    expect(calls).toBe(0);
  });

  it.each([{ output_tokens: 8193 }, { input_tokens: SPEND_CONTEXT_TOKENS }])("closes on reported usage beyond request bounds %#", async (usage) => {
    const ledger = ledgerAt();
    await expect(scoped(ledger, ledger.guardedFetch("deepseek", fakeFetch(() => receipt(usage))))).rejects.toThrow("receipt exceeds");
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(1_416_561);
    expect(ledger.status("ERT-3189")?.terminalReason).toBe("receipt_exceeds_bounds");
  });
});

describe("guard at SDK transport boundary", () => {
  it("every SDK retry gets its own durable reservation, including rejected responses", async () => {
    const ledger = ledgerAt();
    let calls = 0;
    const client = new Anthropic({ authToken: "not-a-secret", baseURL: "https://api.deepseek.com/anthropic", maxRetries: 2, fetch: ledger.guardedFetch("deepseek", fakeFetch(() => {
      calls++;
      if (calls < 3) return Response.json({ type: "error", error: { type: "overloaded_error", message: "offline fake overload" } }, { status: 529, headers: { "retry-after-ms": "1" } });
      return receipt();
    })) });
    await ledger.withSpendScope("ERT-3189", () => client.messages.create({ model: "deepseek-v4-pro", max_tokens: 8192, messages: [{ role: "user", content: "test" }] }));
    expect(calls).toBe(3);
    expect(ledger.status("ERT-3189")?.attemptCount).toBe(3);
    expect(ledger.status("ERT-3189")?.unknownAttempts).toBe(2);
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(2_833_122 + 33_233);
  });

  it("a fallback provider shares the original allocation", async () => {
    const ledger = ledgerAt();
    let zaiCalls = 0;
    let dsCalls = 0;
    const zai = createProvider({ name: "z.ai", apiKey: "fake", baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5.3", defaultBackoffMs: 60_000 }, { fetch: ledger.guardedFetch("z.ai", fakeFetch(() => {
      zaiCalls++;
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "offline quota" } }, { status: 429, headers: { "x-should-retry": "false" } });
    })) });
    const deepseek = createProvider({ name: "deepseek", apiKey: "fake", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro", defaultBackoffMs: 60_000 }, { fetch: ledger.guardedFetch("deepseek", fakeFetch(() => { dsCalls++; return receipt(); })) });
    const glm = new GLMClient(createProviderChain([zai, deepseek]));
    await ledger.withSpendScope("ERT-3189", () => glm.complete({ system: "test", user: "test", maxTokens: 8192 }));
    expect([zaiCalls, dsCalls]).toEqual([1, 1]);
    expect(ledger.status("ERT-3189")?.attemptCount).toBe(2);
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(1_504_052 + 33_233);
  });

  it("SDK retries cannot escape a rejected reservation even if SDK wraps the error", async () => {
    const ledger = ledgerAt(":memory:", 1);
    let calls = 0;
    const client = new Anthropic({ authToken: "fake", baseURL: "https://api.deepseek.com/anthropic", maxRetries: 1, fetch: ledger.guardedFetch("deepseek", fakeFetch(() => { calls++; return receipt(); })) });
    await expect(ledger.withSpendScope("ERT-3189", async () => await client.messages.create({ model: "deepseek-v4-pro", max_tokens: 8192, messages: [{ role: "user", content: "test" }] }))).rejects.toThrow();
    expect(calls).toBe(0);
    expect(ledger.status("ERT-3189")?.state).toBe("exhausted");
  });
});

describe("reject unpriced request surfaces before sending", () => {
  it.each([
    { model: "some-other-model" },
    { stream: true },
    { max_tokens: 8193 },
    { max_tokens: undefined },
    { tools: [{ type: "web_search_20250305", name: "web_search" }] },
    { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/image" } }] }] },
    { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "document", source: { type: "url" } }] }] }] },
    { service_tier: "priority" },
    { mcp_servers: [] },
    { thinking: { type: "enabled", budget_tokens: 10_000 } },
    { output_config: { format: "video" } },
  ])("rejects unpriced body %#", async (overrides) => {
    const ledger = ledgerAt();
    let calls = 0;
    await expect(scoped(ledger, ledger.guardedFetch("deepseek", fakeFetch(() => { calls++; return receipt(); })), request(overrides))).rejects.toBeInstanceOf(SpendLimitError);
    expect(calls).toBe(0);
    expect(ledger.status("ERT-3189")?.attemptCount).toBe(0);
  });

  it.each(["https://api.deepseek.com/anthropic/v1/messages?beta=true", "https://api.deepseek.com/v1/chat/completions", "https://example.com/anthropic/v1/messages", ZAI_URL])("rejects different routes %s", async (url) => {
    const ledger = ledgerAt();
    let calls = 0;
    await expect(scoped(ledger, ledger.guardedFetch("deepseek", fakeFetch(() => { calls++; return receipt(); })), request({}, url))).rejects.toBeInstanceOf(SpendLimitError);
    expect(calls).toBe(0);
  });

  it("rejects Kimi and records a redirect as uncertain, never follows it", async () => {
    const ledger = ledgerAt();
    let calls = 0;
    const inner = fakeFetch((req) => {
      calls++;
      expect(req.redirect).toBe("manual");
      return new Response(null, { status: 307, headers: { location: "https://example.com/paid" } });
    });
    await expect(scoped(ledger, ledger.guardedFetch("kimi", inner))).rejects.toThrow("unpriced provider");
    await expect(scoped(ledger, ledger.guardedFetch("deepseek", inner))).rejects.toThrow("redirect rejected");
    expect(calls).toBe(1);
    expect(ledger.status("ERT-3189")?.chargedMicros).toBe(1_416_561);
    expect(ledger.status("ERT-3189")?.unknownAttempts).toBe(1);
  });
});
