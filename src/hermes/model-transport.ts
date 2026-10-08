import { timingSafeEqual } from "node:crypto";
import { createDeadline, type Deadline } from "../deadline.ts";
import { SpendLedger, SpendLimitError, SPEND_MAX_OUTPUT_TOKENS } from "../spend.ts";

/** Host-owned ceiling for one request, always clamped to the shared action deadline. */
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

/** These are Gary's existing priced Anthropic routes, not new pricing policies. */
const ROUTES = {
  "z.ai": { model: "glm-5.3", url: "https://api.z.ai/api/anthropic/v1/messages" },
  deepseek: { model: "deepseek-v4-pro", url: "https://api.deepseek.com/anthropic/v1/messages" },
} as const;

type PricedRoute =
  | { readonly provider: "z.ai"; readonly model: "glm-5.3" }
  | { readonly provider: "deepseek"; readonly model: "deepseek-v4-pro" };

export type ModelTransportCapability = PricedRoute & {
  readonly ticketId: string;
  readonly ownerId: string;
  /** Absolute host-issued deadline. Each request shares it; retries cannot extend it. */
  readonly deadlineMs: number;
  readonly allowedToolNames: readonly string[];
  readonly signal?: AbortSignal;
};

export type ModelTransportErrorCode =
  | "unsupported_request" | "body_too_large" | "unsupported_provider_response"
  | "unauthorized" | "unsupported_route" | "owner_revoked" | "request_in_flight"
  | "progress_guard_stopped" | "provider_request_failed" | "deadline_or_request_aborted"
  | "spend_guard_rejected" | "provider_transport_failed";
export interface ModelResponseRejection {
  readonly category: "invalid_json" | "envelope" | "model_mismatch" | "content_shape"
    | "unsupported_block_type" | "invalid_text_block" | "invalid_tool_block" | "tool_policy"
    | "parallel_tool_policy" | "required_tool_missing" | "stop_reason" | "stop_tool_mismatch" | "empty_content";
  readonly blockTypes: readonly ("text" | "tool_use" | "thinking" | "redacted_thinking" | "server_tool_use"
    | "tool_result" | "image" | "document" | "other" | "not_object")[];
  readonly blockCount: number | null;
  readonly stopReason: "end_turn" | "stop_sequence" | "max_tokens" | "tool_use" | "pause_turn" | "refusal" | "other" | "missing";
  readonly modelMatches: boolean;
}
export interface ModelTransportFailure {
  readonly errorCode: ModelTransportErrorCode;
  readonly responseRejection?: ModelResponseRejection;
}

export interface ModelTransportOptions {
  /** Existing, enrolled Gary ledger. This module never enrolls, resets or closes it. */
  readonly ledger: SpendLedger;
  readonly capability: ModelTransportCapability;
  /** Host-issued local bearer and upstream key; neither is taken from request JSON. */
  readonly bearerToken: string;
  readonly providerApiKey: string;
  /** Mandatory injection: there is deliberately no global fetch default. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Throw unless this owner still holds this ticket. Checked around every await boundary. */
  readonly assertOwner: (ticketId: string, ownerId: string) => void | Promise<void>;
  /** Optional trusted progress admission after schema validation, before spend reservation. */
  readonly beforeRequest?: (signal: AbortSignal) => Promise<void>;
  /** Trusted host policy only; worker JSON cannot configure provider thinking. */
  readonly thinking?: "disabled";
  /** Called synchronously once per failed request with fixed local metadata only.
   * Exceptions propagate so a failed audit sink cannot silently lose evidence. */
  readonly onFailure?: (failure: Readonly<ModelTransportFailure>) => void;
}

/**
 * POST /v1/chat/completions only. Supports text, local function tools, max_tokens,
 * temperature [0,1], top_p (0,1], stop and function tool_choice. Unknown fields,
 * modalities, native tools and streaming are rejected before reserving spend.
 * No internal retries/fallback; each dispatched request gets a fresh reservation.
 * All responses, including errors, are local JSON without provider error bodies.
 */
export type ModelTransportHandler = (request: Request) => Promise<Response>;

type JsonObject = Record<string, unknown>;
type Block = JsonObject;
interface AnthropicMessage { role: "user" | "assistant"; content: Block[] }
interface ConvertedRequest {
  body: JsonObject;
  offeredTools: Set<string>;
  toolMode: "auto" | "none" | "any" | "tool";
  selectedTool: string | null;
  allowParallel: boolean;
}
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const activeTickets = new WeakMap<SpendLedger, Set<string>>();

class TransportError extends Error {
  constructor(readonly status: number, readonly code: ModelTransportErrorCode,
    readonly responseRejection?: ModelResponseRejection) { super(code); }
}
function invalid(): never { throw new TransportError(400, "unsupported_request"); }
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finiteJson(value: unknown): boolean {
  // JSON.parse accepts exponent overflow as Infinity; JSON.stringify would
  // silently change it to null. Never change tool arguments or schemas this way.
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "number" && !Number.isFinite(current)) return false;
    if (Array.isArray(current)) for (const item of current) pending.push(item);
    else if (object(current)) for (const item of Object.values(current)) pending.push(item);
  }
  return true;
}
function keys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function textBlocks(value: unknown): Block[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value) || value.length === 0) invalid();
  return value.map((part): Block => {
    if (!object(part)) invalid();
    keys(part, ["type", "text"]);
    if (part.type !== "text" || typeof part.text !== "string") invalid();
    return { type: "text", text: part.text };
  });
}
function allowedName(value: unknown, allowlist: ReadonlySet<string>): string {
  if (typeof value !== "string" || !TOOL_NAME.test(value) || !allowlist.has(value)) invalid();
  return value;
}

function convertRequest(value: unknown, model: string, allowlist: ReadonlySet<string>): ConvertedRequest {
  if (!object(value) || !finiteJson(value)) invalid();
  keys(value, ["model", "messages", "max_tokens", "stream", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls"]);
  if (value.model !== model || (value.stream !== undefined && value.stream !== false)) invalid();
  if (!Number.isSafeInteger(value.max_tokens) || (value.max_tokens as number) < 1 || (value.max_tokens as number) > SPEND_MAX_OUTPUT_TOKENS) invalid();
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 2048) invalid();
  const body: JsonObject = { model, max_tokens: value.max_tokens, stream: false };
  const offeredTools = new Set<string>();
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 64) invalid();
    body.tools = value.tools.map((tool): JsonObject => {
      if (!object(tool)) invalid();
      keys(tool, ["type", "function"]);
      if (tool.type !== "function" || !object(tool.function)) invalid();
      keys(tool.function, ["name", "description", "parameters"]);
      const name = allowedName(tool.function.name, allowlist);
      if (offeredTools.has(name) || !object(tool.function.parameters)) invalid();
      if (tool.function.description !== undefined && typeof tool.function.description !== "string") invalid();
      offeredTools.add(name);
      return { name, input_schema: tool.function.parameters,
        ...(tool.function.description === undefined ? {} : { description: tool.function.description }) };
    });
  }
  const messages: AnthropicMessage[] = [];
  const system: Block[] = [];
  const usedIds = new Set<string>();
  const pendingCalls = new Map<string, string>();
  let conversationStarted = false;
  const append = (role: "user" | "assistant", content: Block[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of value.messages) {
    if (!object(message)) invalid();
    if (message.role === "system") {
      keys(message, ["role", "content"]);
      if (conversationStarted) invalid();
      system.push(...textBlocks(message.content));
      continue;
    }
    conversationStarted = true;
    if (message.role === "tool") {
      keys(message, ["role", "content", "tool_call_id", "name"]);
      if (typeof message.tool_call_id !== "string" || !pendingCalls.has(message.tool_call_id)) invalid();
      // Pinned Hermes includes the tool name in result history. It may only
      // repeat the name attached to this outstanding call; it adds no authority.
      if (Object.hasOwn(message, "name") && message.name !== pendingCalls.get(message.tool_call_id)) invalid();
      pendingCalls.delete(message.tool_call_id);
      append("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: textBlocks(message.content) }]);
      continue;
    }
    if (pendingCalls.size !== 0) invalid();
    if (message.role === "user") {
      keys(message, ["role", "content"]);
      append("user", textBlocks(message.content));
    } else if (message.role === "assistant") {
      keys(message, ["role", "content", "tool_calls", "reasoning_content"]);
      // Pinned Hermes adds a whitespace compatibility placeholder even for
      // ordinary replies. Discard only that placeholder, never semantic text.
      if (Object.hasOwn(message, "reasoning_content") && (typeof message.reasoning_content !== "string" || message.reasoning_content.trim() !== "")) invalid();
      const blocks = message.content === null ? [] : textBlocks(message.content);
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0 || message.tool_calls.length > 64) invalid();
        for (const call of message.tool_calls) {
          if (!object(call)) invalid();
          keys(call, ["id", "type", "function"]);
          if (call.type !== "function" || typeof call.id !== "string" || !CALL_ID.test(call.id) || usedIds.has(call.id) || !object(call.function)) invalid();
          keys(call.function, ["name", "arguments"]);
          const name = allowedName(call.function.name, allowlist);
          if (typeof call.function.arguments !== "string") invalid();
          let input: unknown;
          try { input = JSON.parse(call.function.arguments); } catch { invalid(); }
          if (!object(input) || !finiteJson(input)) invalid();
          usedIds.add(call.id);
          pendingCalls.set(call.id, name);
          blocks.push({ type: "tool_use", id: call.id, name, input });
        }
      }
      if (blocks.length === 0) invalid();
      append("assistant", blocks);
    } else invalid();
  }
  if (messages.length === 0 || pendingCalls.size !== 0) invalid();
  body.messages = messages;
  if (system.length) body.system = system;
  for (const field of ["temperature", "top_p"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < (field === "top_p" ? Number.MIN_VALUE : 0) || value[field] > 1) invalid();
      body[field] = value[field];
    }
  }
  if (value.stop !== undefined) {
    const stops = typeof value.stop === "string" ? [value.stop] : value.stop;
    if (!Array.isArray(stops) || stops.length < 1 || stops.length > 4 || stops.some((stop) => typeof stop !== "string" || stop.length === 0)) invalid();
    body.stop_sequences = stops;
  }
  let choice: JsonObject | undefined;
  if (value.tool_choice !== undefined) {
    if (offeredTools.size === 0) invalid();
    if (typeof value.tool_choice === "string" && ["auto", "none", "required"].includes(value.tool_choice)) {
      choice = { type: value.tool_choice === "required" ? "any" : value.tool_choice };
    } else {
      if (!object(value.tool_choice)) invalid();
      keys(value.tool_choice, ["type", "function"]);
      if (value.tool_choice.type !== "function" || !object(value.tool_choice.function)) invalid();
      keys(value.tool_choice.function, ["name"]);
      const name = allowedName(value.tool_choice.function.name, allowlist);
      if (!offeredTools.has(name)) invalid();
      choice = { type: "tool", name };
    }
  }
  if (value.parallel_tool_calls !== undefined) {
    if (typeof value.parallel_tool_calls !== "boolean" || offeredTools.size === 0 || choice?.type === "none") invalid();
    choice = { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: !value.parallel_tool_calls };
  }
  if (choice) body.tool_choice = choice;
  return { body, offeredTools,
    toolMode: (choice?.type ?? (offeredTools.size ? "auto" : "none")) as ConvertedRequest["toolMode"],
    selectedTool: typeof choice?.name === "string" ? choice.name : null,
    allowParallel: choice?.disable_parallel_tool_use !== true,
  };
}

async function bytes(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(signal.reason);
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new TransportError(413, "body_too_large");
      }
      chunks.push(part.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function responseRejection(value: unknown, model: string, category: ModelResponseRejection["category"]): ModelResponseRejection {
  const content = object(value) && Array.isArray(value.content) ? value.content : null;
  const types = new Set<ModelResponseRejection["blockTypes"][number]>();
  for (const block of content ?? []) {
    const type = object(block) ? block.type : undefined;
    types.add(!object(block) ? "not_object"
      : type === "text" || type === "tool_use" || type === "thinking" || type === "redacted_thinking"
        || type === "server_tool_use" || type === "tool_result" || type === "image" || type === "document" ? type : "other");
  }
  const reason = object(value) ? value.stop_reason : undefined;
  const stopReason: ModelResponseRejection["stopReason"] = reason === undefined ? "missing"
    : reason === "end_turn" || reason === "stop_sequence" || reason === "max_tokens" || reason === "tool_use"
      || reason === "pause_turn" || reason === "refusal" ? reason : "other";
  return Object.freeze({ category, blockTypes: Object.freeze([...types]),
    blockCount: content === null ? null : Math.min(content.length, 1_000_000), stopReason,
    modelMatches: object(value) && value.model === model });
}

function convertResponse(value: unknown, model: string, request: ConvertedRequest): JsonObject {
  const bad = (category: ModelResponseRejection["category"]): never => {
    throw new TransportError(502, "unsupported_provider_response", responseRejection(value, model, category));
  };
  if (!object(value) || value.type !== "message" || value.role !== "assistant" || typeof value.id !== "string") bad("envelope");
  if ((value as JsonObject).model !== model) bad("model_mismatch");
  if (!Array.isArray((value as JsonObject).content)) bad("content_shape");
  const response = value as JsonObject & { content: unknown[] };
  const texts: string[] = [];
  const calls: JsonObject[] = [];
  const ids = new Set<string>();
  for (const block of response.content) {
    if (!object(block)) bad("content_shape");
    const part = block as JsonObject;
    if (part.type === "text") {
      if (typeof part.text !== "string" || !Object.keys(part).every((key) => ["type", "text"].includes(key))) bad("invalid_text_block");
      texts.push(part.text as string);
    } else if (part.type === "tool_use") {
      if (typeof part.id !== "string" || !CALL_ID.test(part.id) || ids.has(part.id) || typeof part.name !== "string"
        || !object(part.input) || !finiteJson(part.input) || !Object.keys(part).every((key) => ["type", "id", "name", "input"].includes(key))) bad("invalid_tool_block");
      if (!request.offeredTools.has(part.name as string) || request.toolMode === "none"
        || (request.toolMode === "tool" && part.name !== request.selectedTool)) bad("tool_policy");
      ids.add(part.id as string);
      calls.push({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input) } });
    } else bad("unsupported_block_type");
  }
  const reason = response.stop_reason;
  if (!request.allowParallel && calls.length > 1) bad("parallel_tool_policy");
  if (["any", "tool"].includes(request.toolMode) && calls.length === 0) bad("required_tool_missing");
  if (!["end_turn", "stop_sequence", "max_tokens", "tool_use"].includes(String(reason))) bad("stop_reason");
  if ((reason === "tool_use") !== (calls.length > 0)) bad("stop_tool_mismatch");
  if (texts.length === 0 && calls.length === 0) bad("empty_content");
  const result: JsonObject = {
    id: response.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: texts.length ? texts.join("") : null,
      ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: reason === "tool_use" ? "tool_calls" : reason === "max_tokens" ? "length" : "stop" }],
  };
  const usage = response.usage;
  // Do not invent zero cache counters or normalize an unknown receipt. The
  // original bytes have already passed through the actual SpendLedger.
  const counters = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  if (object(usage) && Object.keys(usage).every((key) => counters.includes(key)) && counters.every((key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)) {
    const input = (usage.input_tokens as number) + (usage.cache_read_input_tokens as number) + (usage.cache_creation_input_tokens as number);
    result.usage = { prompt_tokens: input, completion_tokens: usage.output_tokens, total_tokens: input + (usage.output_tokens as number) };
  }
  return result;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
function authorized(request: Request, token: string): boolean {
  const actual = request.headers.get("authorization") ?? "";
  const expected = "Bearer " + token;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createModelTransport(options: ModelTransportOptions): ModelTransportHandler {
  if (!(options.ledger instanceof SpendLedger) || typeof options.fetch !== "function" || typeof options.assertOwner !== "function") throw new Error("trusted ledger, fetch and owner guard required");
  const issued = options.capability;
  if (!issued || !Object.hasOwn(ROUTES, issued.provider) || ROUTES[issued.provider].model !== issued.model || !Number.isFinite(issued.deadlineMs) || issued.deadlineMs <= 0 || typeof issued.ticketId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(issued.ticketId) || typeof issued.ownerId !== "string" || issued.ownerId.length === 0 || !Array.isArray(issued.allowedToolNames) || issued.allowedToolNames.some((name) => typeof name !== "string" || !TOOL_NAME.test(name))) throw new Error("invalid host capability");
  if (typeof options.bearerToken !== "string" || !/^[^\s]{1,4096}$/.test(options.bearerToken) || typeof options.providerApiKey !== "string" || !/^[^\s]{1,4096}$/.test(options.providerApiKey)) throw new Error("host credentials required");
  if (options.thinking !== undefined && (options.thinking !== "disabled" || issued.provider !== "deepseek")) throw new Error("invalid host thinking policy");
  if (options.onFailure !== undefined && typeof options.onFailure !== "function") throw new Error("invalid host failure callback");
  const capability = Object.freeze({ ...issued, allowedToolNames: Object.freeze([...issued.allowedToolNames]) });
  const allowlist = new Set(capability.allowedToolNames);
  const route = ROUTES[capability.provider];
  const ledger = options.ledger;
  const providerFetch = options.fetch;
  const assertOwner = options.assertOwner;
  const beforeRequest = options.beforeRequest;
  const thinking = options.thinking;
  const onFailure = options.onFailure;
  const bearerToken = options.bearerToken;
  const providerApiKey = options.providerApiKey;
  let active = activeTickets.get(ledger);
  if (!active) { active = new Set(); activeTickets.set(ledger, active); }
  const tickets = active;

  return async (request: Request): Promise<Response> => {
    let deadline: Deadline | undefined;
    let locked = false;
    try {
      if (!authorized(request, bearerToken)) throw new TransportError(401, "unauthorized");
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions" || url.search || url.hash) throw new TransportError(404, "unsupported_route");
      if (request.headers.has("content-encoding") || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) invalid();
      deadline = createDeadline({ timeoutMs: MODEL_REQUEST_TIMEOUT_MS, deadlineMs: capability.deadlineMs,
        signal: capability.signal ? AbortSignal.any([capability.signal, request.signal]) : request.signal });
      const currentDeadline = deadline;
      const guard = async () => {
        currentDeadline.throwIfExpired();
        try { await assertOwner(capability.ticketId, capability.ownerId); }
        catch { throw new TransportError(403, "owner_revoked"); }
        currentDeadline.throwIfExpired();
      };
      await guard();
      if (tickets.has(capability.ticketId)) throw new TransportError(409, "request_in_flight");
      tickets.add(capability.ticketId);
      locked = true;
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(request.body, MAX_REQUEST_BYTES, currentDeadline.signal))); }
      catch (error) {
        if (error instanceof TransportError || currentDeadline.signal.aborted) throw error;
        invalid();
      }
      const converted = convertRequest(body, capability.model, allowlist);
      if (thinking !== undefined) converted.body.thinking = { type: thinking };
      await guard();
      if (beforeRequest) {
        try { await beforeRequest(currentDeadline.signal); } catch { throw new TransportError(409, "progress_guard_stopped"); }
        await guard();
      }
      const guarded = ledger.guardedFetch(capability.provider, (async (input: RequestInfo | URL, init?: RequestInit) => {
        await guard();
        const upstream = await providerFetch(new Request(input, init));
        await guard();
        // Preserve receipt bytes exactly while enforcing the shared deadline
        // through body consumption, before Gary's receipt parser sees them.
        const raw = await bytes(upstream.body, MAX_RESPONSE_BYTES, currentDeadline.signal);
        await guard();
        return new Response(raw.byteLength ? raw.buffer as ArrayBuffer : null, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
      }) as typeof fetch);
      const upstream = await ledger.withSpendScope(capability.ticketId, () => guarded(route.url, {
        method: "POST", redirect: "manual", signal: currentDeadline.signal,
        headers: { authorization: "Bearer " + providerApiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(converted.body),
      }));
      await guard();
      if (!upstream.ok) throw new TransportError(upstream.status === 429 ? 429 : 502, "provider_request_failed");
      let result: unknown;
      try { result = await upstream.json(); } catch {
        throw new TransportError(502, "unsupported_provider_response", responseRejection(undefined, capability.model, "invalid_json"));
      }
      const completion = convertResponse(result, capability.model, converted);
      await guard();
      return json(completion);
    } catch (error) {
      const failure = deadline?.signal.aborted ? new TransportError(408, "deadline_or_request_aborted")
        : error instanceof TransportError ? error
        : error instanceof SpendLimitError ? new TransportError(402, "spend_guard_rejected")
        : new TransportError(502, "provider_transport_failed");
      onFailure?.(Object.freeze({ errorCode: failure.code,
        ...(failure.responseRejection ? { responseRejection: failure.responseRejection } : {}) }));
      return json({ error: { message: failure.code, type: "guarded_transport_error", code: failure.code } }, failure.status);
    } finally {
      if (locked) tickets.delete(capability.ticketId);
      deadline?.dispose();
    }
  };
}
