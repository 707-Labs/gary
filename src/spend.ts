import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

// Reviewed 2026-10-07. Peak, uncached USD / million tokens. One micro-USD
// per token at $1/MTok. Use integer hundredths of a micro-USD throughout.
// https://docs.z.ai/guides/overview/pricing
// https://docs.z.ai/guides/llm/glm-5.3
// https://api-docs.deepseek.com/quick_start/pricing
// https://api-docs.deepseek.com/guides/anthropic_api/
export const SPEND_CONTEXT_TOKENS = 1_048_576;
export const SPEND_MAX_OUTPUT_TOKENS = 8192;
const POLICIES = {
  "z.ai": { model: "glm-5.3", url: "https://api.z.ai/api/anthropic/v1/messages", input: 140, output: 440 },
  deepseek: { model: "deepseek-v4-pro", url: "https://api.deepseek.com/anthropic/v1/messages", input: 132, output: 396 },
} as const;
type PricedProvider = keyof typeof POLICIES;
type Policy = (typeof POLICIES)[PricedProvider];
type TicketState = "active" | "exhausted" | "closed";

export class SpendLimitError extends Error {
  constructor(readonly reason: string) {
    super(`spending guard stopped request: ${reason}`);
    this.name = "SpendLimitError";
  }
}

export interface SpendStatus {
  ticketId: string;
  campaignId: string;
  state: TicketState;
  terminalReason: string | null;
  draftPr: boolean;
  capMicros: number;
  chargedMicros: number;
  remainingMicros: number;
  attemptCount: number;
  unknownAttempts: number;
  campaignCapMicros: number;
  campaignChargedMicros: number;
}

interface TicketRow {
  ticket_id: string;
  campaign_id: string;
  state: TicketState;
  terminal_reason: string | null;
  draft_pr: number;
  cap_micros: number;
}
function usdToMicros(usd: number): number {
  const micros = Math.round(usd * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros <= 0 || micros > 1_000_000_000 || Math.abs(micros / 1_000_000 - usd) > 1e-10) {
    throw new SpendLimitError("cap must be positive USD with at most six decimal places (maximum $1000)");
  }
  return micros;
}
function assertId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new SpendLimitError("invalid allocation identifier");
}
function costMicros(policy: Policy, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * policy.input + outputTokens * policy.output) / 100);
}
export function spendReservationMicros(provider: string, maxTokens = SPEND_MAX_OUTPUT_TOKENS): number {
  const policy = getPolicy(provider);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > SPEND_MAX_OUTPUT_TOKENS) {
    throw new SpendLimitError("unsupported output limit");
  }
  return costMicros(policy, SPEND_CONTEXT_TOKENS, maxTokens);
}
function getPolicy(provider: string): Policy {
  if (!Object.hasOwn(POLICIES, provider)) throw new SpendLimitError("unpriced provider");
  return POLICIES[provider as PricedProvider];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function tokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// Check only protocol structure, not arbitrary JSON inside local tool inputs or
// schemas. Provider-native tools, remote content, modalities and future request
// fields require an explicit pricing review before becoming eligible.
function validateContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => {
    if (!record(block)) return false;
    switch (block.type) {
      case "text": return typeof block.text === "string" && onlyKeys(block, ["type", "text", "cache_control"]);
      case "thinking": return typeof block.thinking === "string" && onlyKeys(block, ["type", "thinking", "signature"]);
      case "tool_use": return typeof block.name === "string" && typeof block.id === "string" && record(block.input) && onlyKeys(block, ["type", "name", "id", "input", "cache_control"]);
      case "tool_result": return typeof block.tool_use_id === "string" && validateContent(block.content) && onlyKeys(block, ["type", "tool_use_id", "content", "is_error", "cache_control"]);
      default: return false;
    }
  });
}

async function validateRequest(provider: string, request: Request): Promise<{ policy: Policy; maxTokens: number }> {
  const policy = getPolicy(provider);
  // Exact route, including absence of query/fragment/credentials. Never permit
  // redirects: a retry is a new guarded fetch and gets a new reservation.
  if (request.url !== policy.url || request.method !== "POST") throw new SpendLimitError("unpriced API route");
  if (request.headers.has("content-encoding")) throw new SpendLimitError("encoded request body");
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw new SpendLimitError("non-JSON request");
  let body: unknown;
  try { body = await request.clone().json(); } catch { throw new SpendLimitError("invalid request JSON"); }
  if (!record(body) || !onlyKeys(body, ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "stream", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "thinking", "output_config"])) {
    throw new SpendLimitError("unpriced request fields");
  }
  if (body.model !== policy.model || (body.stream !== undefined && body.stream !== false)) throw new SpendLimitError("unpriced model or streaming request");
  if (!tokenCount(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > SPEND_MAX_OUTPUT_TOKENS) throw new SpendLimitError("unsupported output limit");
  if (body.system !== undefined && !validateContent(body.system)) throw new SpendLimitError("unsupported system content");
  if (!Array.isArray(body.messages) || !body.messages.every((message) => record(message) && onlyKeys(message, ["role", "content"]) && ["user", "assistant"].includes(String(message.role)) && validateContent(message.content))) {
    throw new SpendLimitError("unsupported message content");
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool) => record(tool) && onlyKeys(tool, ["name", "description", "input_schema", "cache_control"]) && typeof tool.name === "string" && record(tool.input_schema)))) {
    throw new SpendLimitError("provider-native tools are not priced");
  }
  if (body.thinking !== undefined && (!record(body.thinking) || !onlyKeys(body.thinking, ["type", "budget_tokens"]) || !["enabled", "disabled", "adaptive"].includes(String(body.thinking.type)) || (body.thinking.budget_tokens !== undefined && (!tokenCount(body.thinking.budget_tokens) || body.thinking.budget_tokens > body.max_tokens)))) {
    throw new SpendLimitError("unsupported thinking budget");
  }
  if (body.output_config !== undefined && (!record(body.output_config) || !onlyKeys(body.output_config, ["effort"]))) throw new SpendLimitError("unsupported output configuration");
  return { policy, maxTokens: body.max_tokens };
}

/**
 * The receipt does not need to prove output/reasoning inclusion: we always keep
 * the complete requested output allowance. Input is refunded only when all
 * three Anthropic input counters are explicit nonnegative integers. All input
 * (including cached input) is charged at the uncached price, so overlapping
 * counters overestimate rather than undercount. Unknown usage fields/formats,
 * missing counters and error responses keep the entire original reservation.
 */
function receiptInput(body: unknown, policy: Policy, maxTokens: number): number | null {
  if (!record(body) || body.type !== "message" || body.role !== "assistant" || body.model !== policy.model || typeof body.id !== "string" || !["end_turn", "tool_use", "max_tokens", "stop_sequence"].includes(String(body.stop_reason)) || !validateContent(body.content) || !record(body.usage)) return null;
  const usage = body.usage;
  if (!onlyKeys(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])) return null;
  if (![usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.output_tokens].every(tokenCount)) return null;
  const input = (usage.input_tokens as number) + (usage.cache_read_input_tokens as number) + (usage.cache_creation_input_tokens as number);
  if (input > SPEND_CONTEXT_TOKENS || (usage.output_tokens as number) > maxTokens) throw new SpendLimitError("receipt exceeds reserved token bounds");
  return input;
}

export class SpendLedger {
  private readonly db: Database;
  private readonly scope = new AsyncLocalStorage<string>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS spend_campaigns (id TEXT PRIMARY KEY, cap_micros INTEGER NOT NULL CHECK(cap_micros>0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS spend_tickets (ticket_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES spend_campaigns(id), cap_micros INTEGER NOT NULL CHECK(cap_micros>0), draft_pr INTEGER NOT NULL CHECK(draft_pr IN (0,1)), state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','exhausted','closed')), terminal_reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS spend_attempts (id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES spend_tickets(ticket_id), provider TEXT NOT NULL, model TEXT NOT NULL, max_tokens INTEGER NOT NULL, reserved_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','unknown','settled')), input_tokens INTEGER, http_status INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, settled_at TEXT);
      CREATE INDEX IF NOT EXISTS spend_attempts_ticket ON spend_attempts(ticket_id);`);
  }

  createCampaign(campaignId: string, capUsd: number): void {
    assertId(campaignId);
    const cap = usdToMicros(capUsd);
    this.db.transaction(() => {
      const existing = this.db.query<{ cap_micros: number }, [string]>("SELECT cap_micros FROM spend_campaigns WHERE id=?").get(campaignId);
      if (existing) {
        if (existing.cap_micros !== cap) throw new SpendLimitError("campaign cap is immutable");
        return;
      }
      this.db.query("INSERT INTO spend_campaigns(id,cap_micros) VALUES(?,?)").run(campaignId, cap);
    }).immediate();
  }

  enrollTicket(campaignId: string, ticketId: string, capUsd: number, options: { draftPr?: boolean } = {}): void {
    assertId(campaignId); assertId(ticketId);
    const cap = usdToMicros(capUsd);
    const draft = options.draftPr === true ? 1 : 0;
    this.db.transaction(() => {
      const existing = this.ticket(ticketId);
      if (existing) {
        if (existing.campaign_id !== campaignId || existing.cap_micros !== cap || existing.draft_pr !== draft) throw new SpendLimitError("ticket enrollment is immutable");
        return; // Existing closure, exhaustion and reservations survive enrollment/restart.
      }
      const campaign = this.db.query<{ cap_micros: number }, [string]>("SELECT cap_micros FROM spend_campaigns WHERE id=?").get(campaignId);
      if (!campaign) throw new SpendLimitError("missing campaign");
      const allocated = this.db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(cap_micros),0) AS n FROM spend_tickets WHERE campaign_id=?").get(campaignId)!.n;
      if (allocated + cap > campaign.cap_micros) throw new SpendLimitError("campaign allocation exceeded");
      this.db.query("INSERT INTO spend_tickets(ticket_id,campaign_id,cap_micros,draft_pr) VALUES(?,?,?,?)").run(ticketId, campaignId, cap, draft);
    }).immediate();
  }

  status(ticketId: string): SpendStatus | null {
    const row = this.db.query<TicketRow & { charged: number; attempts: number; unknowns: number; campaign_cap: number; campaign_charged: number }, [string]>(`
      SELECT t.*, c.cap_micros AS campaign_cap,
        (SELECT COALESCE(SUM(charged_micros),0) FROM spend_attempts WHERE ticket_id=t.ticket_id) AS charged,
        (SELECT COUNT(*) FROM spend_attempts WHERE ticket_id=t.ticket_id) AS attempts,
        (SELECT COUNT(*) FROM spend_attempts WHERE ticket_id=t.ticket_id AND state!='settled') AS unknowns,
        (SELECT COALESCE(SUM(a.charged_micros),0) FROM spend_attempts a JOIN spend_tickets t2 ON t2.ticket_id=a.ticket_id WHERE t2.campaign_id=t.campaign_id) AS campaign_charged
      FROM spend_tickets t JOIN spend_campaigns c ON c.id=t.campaign_id WHERE t.ticket_id=?`).get(ticketId);
    if (!row) return null;
    return { ticketId, campaignId: row.campaign_id, state: row.state, terminalReason: row.terminal_reason, draftPr: row.draft_pr === 1, capMicros: row.cap_micros, chargedMicros: row.charged, remainingMicros: row.cap_micros - row.charged, attemptCount: row.attempts, unknownAttempts: row.unknowns, campaignCapMicros: row.campaign_cap, campaignChargedMicros: row.campaign_charged };
  }

  canDispatch(ticketId: string): boolean {
    const status = this.status(ticketId);
    // This is a cheap admission check only; the transaction reserves the exact
    // provider/max_tokens amount. Require enough for any supported next call.
    const largest = Math.max(...Object.keys(POLICIES).map((provider) => spendReservationMicros(provider)));
    return status !== null && status.state === "active" && status.remainingMicros >= largest && status.campaignCapMicros - status.campaignChargedMicros >= largest;
  }
  assertCanDispatch(ticketId: string): void {
    if (!this.canDispatch(ticketId)) throw new SpendLimitError("ticket is not eligible for dispatch");
  }
  withSpendScope<T>(ticketId: string, fn: () => T): T {
    const current = this.scope.getStore();
    if (current !== undefined && current !== ticketId) throw new SpendLimitError("cannot switch ticket inside a spending scope");
    const status = this.status(ticketId);
    if (!status || status.state !== "active") throw new SpendLimitError("ticket is not actively enrolled");
    return this.scope.run(ticketId, fn);
  }
  markTerminal(ticketId: string, reason: string): void {
    // Only an operator-defined enum-like reason is persisted; no prompts/errors.
    assertId(reason);
    this.db.query("UPDATE spend_tickets SET state='closed', terminal_reason=? WHERE ticket_id=? AND state='active'").run(reason, ticketId);
  }
  close(): void { this.db.close(); }

  guardedFetch(provider: string, inner: typeof fetch = globalThis.fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const ticketId = this.scope.getStore();
      if (!ticketId) throw new SpendLimitError("missing ticket scope");
      let request: Request;
      try { request = new Request(input, { ...init, redirect: "manual" }); } catch { throw new SpendLimitError("invalid HTTP request"); }
      const { policy, maxTokens } = await validateRequest(provider, request);
      const attempt = this.reserve(ticketId, provider, policy, maxTokens);
      let response: Response;
      try {
        response = await inner(request);
      } catch (error) {
        this.unknown(attempt, null);
        throw error;
      }
      this.assertResponseActive(ticketId, attempt, response.status);
      if (response.status >= 300 && response.status < 400) {
        this.unknown(attempt, response.status);
        throw new SpendLimitError("provider redirect rejected");
      }
      if (!response.ok) { this.unknown(attempt, response.status); return response; }
      let body: unknown;
      try { body = await response.clone().json(); } catch {
        this.unknown(attempt, response.status);
        this.assertResponseActive(ticketId, attempt, response.status);
        return response;
      }
      this.assertResponseActive(ticketId, attempt, response.status);
      let inputTokens: number | null;
      try { inputTokens = receiptInput(body, policy, maxTokens); } catch (error) {
        this.unknown(attempt, response.status);
        this.markTerminal(ticketId, "receipt_exceeds_bounds");
        throw error;
      }
      if (inputTokens === null) { this.unknown(attempt, response.status); return response; }
      // Always keep full output cost; usage.output_tokens may omit reasoning on
      // a compatibility endpoint. The unused input portion alone is released.
      const charged = costMicros(policy, inputTokens, maxTokens);
      this.db.query("UPDATE spend_attempts SET charged_micros=?, state='settled', input_tokens=?, http_status=?, settled_at=CURRENT_TIMESTAMP WHERE id=? AND state='reserved'").run(charged, inputTokens, response.status, attempt);
      return response;
    }) as typeof fetch;
  }

  private ticket(ticketId: string): TicketRow | null {
    return this.db.query<TicketRow, [string]>("SELECT * FROM spend_tickets WHERE ticket_id=?").get(ticketId);
  }
  private reserve(ticketId: string, provider: string, policy: Policy, maxTokens: number): number {
    const reserved = costMicros(policy, SPEND_CONTEXT_TOKENS, maxTokens);
    const outcome = this.db.transaction((): number | SpendLimitError => {
      const status = this.status(ticketId);
      if (!status || status.state !== "active") return new SpendLimitError("ticket is not actively enrolled");
      if (reserved > status.remainingMicros || reserved > status.campaignCapMicros - status.campaignChargedMicros) {
        this.db.query("UPDATE spend_tickets SET state='exhausted',terminal_reason='reservation_exhausted' WHERE ticket_id=?").run(ticketId);
        return new SpendLimitError("allocation exhausted"); // Commit latch before throwing.
      }
      const result = this.db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros) VALUES(?,?,?,?,?,?)").run(ticketId, provider, policy.model, maxTokens, reserved, reserved);
      return Number(result.lastInsertRowid);
    }).immediate();
    if (outcome instanceof SpendLimitError) throw outcome;
    return outcome;
  }
  private unknown(id: number, status: number | null): void {
    this.db.query("UPDATE spend_attempts SET state='unknown',http_status=? WHERE id=? AND state='reserved'").run(status, id);
  }
  private assertResponseActive(ticketId: string, attempt: number, status: number): void {
    if (this.ticket(ticketId)?.state !== "active") {
      this.unknown(attempt, status);
      throw new SpendLimitError("ticket closed while request was in flight");
    }
  }
}

export function openSpendLedger(path: string): SpendLedger { return new SpendLedger(path); }
