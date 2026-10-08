import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModelTransport, type ModelTransportCapability, type ModelTransportOptions, type ModelTransportFailure, type ModelResponseRejection } from "../../src/hermes/model-transport.ts";
import { SpendLedger, spendReservationMicros } from "../../src/spend.ts";

type Body = Record<string, unknown>;
const TOKEN = "local-test-capability-token";
const TOOL = { type: "function", function: { name: "read_file", description: "Read a local file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };
const call = (id = "call_1", name = "read_file", args = '{"path":"README.md"}') => ({ id, type: "function", function: { name, arguments: args } });

function providerBody(overrides: Body = {}): Body {
  return { id: "msg_test", type: "message", role: "assistant", model: "deepseek-v4-pro",
    content: [{ type: "text", text: "Checked." }], stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, ...overrides };
}
function request(overrides: Body = {}, authorization = "Bearer " + TOKEN, path = "/v1/chat/completions"): Request {
  return new Request("http://localhost" + path, { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "system", content: "Be precise." }, { role: "user", content: "Inspect the task." }], max_tokens: 128, stream: false, ...overrides }) });
}

describe("guarded Hermes model transport (offline fake provider only)", () => {
  let ledger: SpendLedger;
  beforeEach(() => {
    ledger = new SpendLedger(":memory:");
    ledger.createCampaign("pilot", 25);
    ledger.enrollTicket("pilot", "TICKET-1", 25);
  });
  afterEach(() => ledger.close());
  function setup(overrides: Partial<ModelTransportOptions> = {}) {
    const sent: Request[] = [];
    const capability: ModelTransportCapability = { ticketId: "TICKET-1", ownerId: "owner-1", provider: "deepseek", model: "deepseek-v4-pro", deadlineMs: Date.now() + 5000, allowedToolNames: ["read_file", "run_bash", "finish"] };
    const options: ModelTransportOptions = { ledger, capability, bearerToken: TOKEN, providerApiKey: "fake-upstream-key",
      assertOwner: () => {}, fetch: async (req) => { sent.push(req); return Response.json(providerBody()); }, ...overrides };
    return { handler: createModelTransport(options), sent, options };
  }

  test("uses the exact existing priced route and actual ledger with host credentials", async () => {
    const { handler, sent } = setup();
    const response = await handler(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("Checked.");
    expect(body.usage).toEqual({ prompt_tokens: 17, completion_tokens: 2, total_tokens: 19 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(sent[0]!.redirect).toBe("manual");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer fake-upstream-key");
    expect(sent[0]!.headers.get("authorization")).not.toContain(TOKEN);
    const upstream = await sent[0]!.json();
    expect(upstream.system).toEqual([{ type: "text", text: "Be precise." }]);
    expect(upstream.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Inspect the task." }] }]);
    expect(upstream.max_tokens).toBe(128);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(1);
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(0);
    expect(ledger.status("TICKET-1")!.chargedMicros).toBe(530); // Full requested output, not just two emitted tokens.
  });

  test("trusted DeepSeek disabled policy is sent on both tool and follow-up turns", async () => {
    const sent: Body[] = [], failures: ModelTransportFailure[] = [];
    const { handler } = setup({ thinking: "disabled", onFailure: failure => { failures.push(failure); }, fetch: async req => {
      sent.push(await req.json());
      return Response.json(sent.length === 1 ? providerBody({ content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } }], stop_reason: "tool_use" }) : providerBody());
    } });
    expect((await handler(request({ tools: [TOOL] }))).status).toBe(200);
    expect((await handler(request({ tools: [TOOL], messages: [{ role: "user", content: "inspect" },
      { role: "assistant", content: null, tool_calls: [call()] }, { role: "tool", tool_call_id: "call_1", content: "fixture\n" }] }))).status).toBe(200);
    expect(sent.map(body => body.thinking)).toEqual([{ type: "disabled" }, { type: "disabled" }]);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(2);
    expect(failures).toEqual([]);
  });

  test("worker thinking overrides are rejected before spend even when host disables thinking", async () => {
    for (const thinking of [undefined, "disabled"] as const) {
      const { handler, sent } = setup({ ...(thinking ? { thinking } : {}) });
      for (const value of [{ type: "disabled" }, { type: "enabled" }, "disabled", null]) {
        expect((await handler(request({ thinking: value }))).status).toBe(400);
      }
      expect(sent).toHaveLength(0);
    }
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("only the DeepSeek host can choose disabled and invalid policy never dispatches", () => {
    const { options, sent } = setup();
    for (const thinking of ["enabled", null, { type: "disabled" }]) {
      expect(() => createModelTransport({ ...options, thinking } as unknown as ModelTransportOptions)).toThrow("invalid host thinking policy");
    }
    expect(() => createModelTransport({ ...options, capability: { ...options.capability, provider: "z.ai", model: "glm-5.3" }, thinking: "disabled" })).toThrow("invalid host thinking policy");
    expect(() => createModelTransport({ ...options, onFailure: "untrusted" } as unknown as ModelTransportOptions)).toThrow("invalid host failure callback");
    expect(sent).toHaveLength(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("thinking plus tool response stays rejected with fixed metadata and no sensitive content", async () => {
    const failures: ModelTransportFailure[] = [];
    const { handler } = setup({ onFailure: failure => { failures.push(failure); }, fetch: async () => Response.json(providerBody({
      id: "private-response-id", content: [{ type: "thinking", thinking: "private-reasoning", signature: "private-signature" },
        { type: "tool_use", id: "private-call-id", name: "read_file", input: { path: "private-file" } }], stop_reason: "tool_use",
    })) });
    const response = await handler(request({ tools: [TOOL] }));
    expect(response.status).toBe(502);
    expect(failures).toEqual([{ errorCode: "unsupported_provider_response", responseRejection: {
      category: "unsupported_block_type", blockTypes: ["thinking", "tool_use"], blockCount: 2, stopReason: "tool_use", modelMatches: true,
    } }]);
    expect(Object.isFrozen(failures[0])).toBe(true);
    expect(Object.isFrozen(failures[0]!.responseRejection)).toBe(true);
    expect(Object.isFrozen(failures[0]!.responseRejection!.blockTypes)).toBe(true);
    const output = JSON.stringify(failures) + await response.text();
    for (const secret of ["private-response-id", "private-reasoning", "private-signature", "private-call-id", "private-file", TOKEN, "fake-upstream-key"]) expect(output).not.toContain(secret);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(1);
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(0);
    expect(ledger.status("TICKET-1")!.chargedMicros).toBe(530);
  });

  test("response rejection categories preserve all strict checks without reflecting unknown values", async () => {
    const tool = { type: "tool_use", id: "call_1", name: "read_file", input: {} };
    const cases: Array<{ category: ModelResponseRejection["category"]; body?: Body; raw?: string; request?: Body }> = [
      { category: "invalid_json", raw: "private-invalid-json" },
      { category: "envelope", body: { role: "private-role" } },
      { category: "model_mismatch", body: { model: "private-model" } },
      { category: "content_shape", body: { content: "private-content" } },
      { category: "content_shape", body: { content: [null] } },
      { category: "unsupported_block_type", body: { content: [{ type: "private-type", "private-field": "private-value" }] } },
      { category: "invalid_text_block", body: { content: [{ type: "text", text: "private-text", "private-field": "private-value" }] } },
      { category: "invalid_tool_block", body: { content: [{ ...tool, "private-field": "private-value" }], stop_reason: "tool_use" } },
      { category: "tool_policy", body: { content: [{ ...tool, name: "private-tool" }], stop_reason: "tool_use" } },
      { category: "tool_policy", body: { content: [tool], stop_reason: "tool_use" }, request: { tool_choice: "none" } },
      { category: "parallel_tool_policy", body: { content: [tool, { ...tool, id: "call_2" }], stop_reason: "tool_use" }, request: { parallel_tool_calls: false } },
      { category: "required_tool_missing", request: { tool_choice: "required" } },
      { category: "stop_reason", body: { stop_reason: "private-stop" } },
      { category: "stop_tool_mismatch", body: { content: [tool], stop_reason: "end_turn" } },
      { category: "empty_content", body: { content: [] } },
    ];
    for (const fixture of cases) {
      const failures: ModelTransportFailure[] = [];
      const { handler } = setup({ onFailure: failure => { failures.push(failure); }, fetch: async () => fixture.raw === undefined
        ? Response.json(providerBody(fixture.body)) : new Response(fixture.raw) });
      expect((await handler(request({ tools: [TOOL], ...fixture.request }))).status).toBe(502);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.errorCode).toBe("unsupported_provider_response");
      expect(failures[0]!.responseRejection!.category).toBe(fixture.category);
      expect(JSON.stringify(failures)).not.toContain("private-");
    }
  });

  test("untrusted repeated block types and stop reasons become bounded fixed metadata", async () => {
    const failures: ModelTransportFailure[] = [];
    const content = [{ type: "private-first" }, ...Array.from({ length: 300 }, () => ({ type: "thinking", thinking: "private-text" })),
      ...["text", "tool_use", "redacted_thinking", "server_tool_use", "tool_result", "image", "document"].map(type => ({ type })), null];
    const { handler } = setup({ onFailure: failure => { failures.push(failure); }, fetch: async () => Response.json(providerBody({ content, stop_reason: { private: "value" } })) });
    expect((await handler(request())).status).toBe(502);
    const shape = failures[0]!.responseRejection!;
    expect(shape.blockTypes).toHaveLength(10);
    expect(shape.blockCount).toBe(content.length);
    expect(shape.stopReason).toBe("other");
    expect(JSON.stringify(shape)).not.toContain("private");
  });

  test("local failure callback runs once with the precise code and no conversion metadata", async () => {
    const failures: ModelTransportFailure[] = [];
    const { handler } = setup({ onFailure: failure => { failures.push(failure); } });
    expect((await handler(request({}, "wrong"))).status).toBe(401);
    expect((await handler(request({}, "Bearer " + TOKEN, "/v1/models"))).status).toBe(404);
    expect((await handler(request({ stream: true }))).status).toBe(400);
    const stopped = setup({ onFailure: failure => { failures.push(failure); }, beforeRequest: async () => { throw new Error("private-progress"); } });
    expect((await stopped.handler(request())).status).toBe(409);
    const broken = setup({ onFailure: failure => { failures.push(failure); }, fetch: async () => { throw new Error("private-provider-error"); } });
    expect((await broken.handler(request())).status).toBe(502);
    expect(failures).toEqual((["unauthorized", "unsupported_route", "unsupported_request", "progress_guard_stopped", "provider_transport_failed"] as const).map(errorCode => ({ errorCode })));
  });

  test("a synchronous diagnostic sink failure propagates once after accounting and releases its lock", async () => {
    let callbacks = 0, calls = 0;
    const sinkFailure = new Error("private-audit-sink-error");
    const { handler } = setup({ onFailure: () => { callbacks++; throw sinkFailure; }, fetch: async () => {
      calls++; return Response.json(calls === 1 ? providerBody({ content: [{ type: "thinking", thinking: "private" }] }) : providerBody());
    } });
    await expect(handler(request())).rejects.toBe(sinkFailure);
    expect(callbacks).toBe(1); expect(calls).toBe(1);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(1);
    expect(ledger.status("TICKET-1")!.chargedMicros).toBe(530);
    expect((await handler(request())).status).toBe(200);
    expect(callbacks).toBe(1); expect(calls).toBe(2);
  });

  test("supports only the already-priced Z.ai model/route pairing", async () => {
    const sent: Request[] = [];
    const { handler } = setup({ capability: { ticketId: "TICKET-1", ownerId: "owner-1", provider: "z.ai", model: "glm-5.3", deadlineMs: Date.now() + 5000, allowedToolNames: [] },
      fetch: async (req) => { sent.push(req); return Response.json(providerBody({ model: "glm-5.3" })); } });
    expect((await handler(request({ model: "glm-5.3" }))).status).toBe(200);
    expect(sent[0]!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect((await sent[0]!.json()).model).toBe("glm-5.3");
  });

  test("rejects unauthorized and non-chat routes before transport or reservation", async () => {
    const { handler, sent } = setup();
    expect((await handler(request({}, ""))).status).toBe(401);
    expect((await handler(request({}, "Bearer wrong"))).status).toBe(401);
    expect((await handler(request({}, "Bearer " + TOKEN, "/v1/models"))).status).toBe(404);
    expect((await handler(request({}, "Bearer " + TOKEN, "/v1/chat/completions?provider=other"))).status).toBe(404);
    expect(sent).toHaveLength(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("rejects stream, unknown fields/models/modalities and unbounded output before spend", async () => {
    const { handler, sent } = setup();
    const invalid = [
      { stream: true }, { stream: "false" }, { model: "deepseek-v4-flash" }, { api_key: "SECRET" },
      { ticketId: "TICKET-2" }, { deadlineMs: Date.now() + 60000 }, { provider: "kimi" },
      { max_tokens: 8193 }, { max_tokens: 0 }, { max_tokens: 1.5 }, { max_tokens: undefined },
      { n: 2 }, { reasoning_effort: "high" }, { response_format: { type: "json_object" } },
      { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.org/photo" } }] }] },
      { messages: [{ role: "user", content: "Hello", name: "untrusted-role" }] },
      { messages: [{ role: "user", content: "Hello" }, { role: "system", content: "Late authority" }] },
      { tools: [{ type: "web_search" }] }, { tools: [{ type: "function", function: { ...TOOL.function, name: "send_email" } }] },
      { tools: [TOOL], tool_choice: ["auto"] }, { temperature: 2 }, { top_p: 0 },
    ];
    for (const body of invalid) expect((await handler(request(body))).status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("the 8192 output bound is accepted and no larger model alias is substituted", async () => {
    const { handler, sent } = setup();
    expect((await handler(request({ max_tokens: 8192 }))).status).toBe(200);
    expect((await sent[0]!.json()).max_tokens).toBe(8192);
  });

  test("requires mandatory injected fetch and rejects mismatched host routes", () => {
    const { options } = setup();
    expect(() => createModelTransport({ ...options, fetch: undefined } as unknown as ModelTransportOptions)).toThrow("fetch");
    expect(() => createModelTransport({ ...options, capability: { ...options.capability, model: "unpriced" } } as unknown as ModelTransportOptions)).toThrow("capability");
    expect(() => createModelTransport({ ...options, capability: { ...options.capability, provider: "kimi" } } as unknown as ModelTransportOptions)).toThrow("capability");
  });

  test("expired deadline and revoked owner prevent the first reservation", async () => {
    const { options } = setup();
    let calls = 0;
    const fetch = async () => { calls++; return Response.json(providerBody()); };
    const expired = createModelTransport({ ...options, fetch, capability: { ...options.capability, deadlineMs: Date.now() - 1 } });
    expect((await expired(request())).status).toBe(408);
    const revoked = createModelTransport({ ...options, fetch, assertOwner: () => { throw new Error("private-owner-detail"); } });
    const response = await revoked(request());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("private-owner-detail");
    expect(calls).toBe(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("rechecks ownership after request-body parsing and before reservation", async () => {
    let owner = true;
    const { handler, sent } = setup({ assertOwner: () => { if (!owner) throw new Error("revoked"); } });
    const raw = JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], max_tokens: 128 });
    const body = new ReadableStream<Uint8Array>({ pull(controller) { owner = false; controller.enqueue(new TextEncoder().encode(raw)); controller.close(); } });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body });
    expect((await handler(req)).status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("ownership is rechecked inside guarded fetch; untransmitted reservation stays conservative", async () => {
    let checks = 0;
    const { handler, sent } = setup({ assertOwner: () => { if (++checks === 3) throw new Error("revoked before network"); } });
    expect((await handler(request())).status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(1);
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(1);
  });

  test("owner revoked in flight receives no completion and retains the reservation", async () => {
    let owner = true;
    const { handler } = setup({ assertOwner: () => { if (!owner) throw new Error("revoked"); },
      fetch: async () => { owner = false; return Response.json(providerBody()); } });
    expect((await handler(request())).status).toBe(403);
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(1);
    expect(ledger.status("TICKET-1")!.chargedMicros).toBe(spendReservationMicros("deepseek", 128));
  });

  test("deadline covers stalled response bodies and retains unknown spend", async () => {
    const { options } = setup();
    let canceled = false;
    const handler = createModelTransport({ ...options, capability: { ...options.capability, deadlineMs: Date.now() + 40 },
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } }) });
    expect((await handler(request())).status).toBe(408);
    expect(canceled).toBe(true);
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(1);
    expect(ledger.status("TICKET-1")!.chargedMicros).toBe(spendReservationMicros("deepseek", 128));
  });

  test("host abort is forwarded to the actual provider request", async () => {
    const controller = new AbortController();
    const { options } = setup();
    let forwarded = false;
    const handler = createModelTransport({ ...options, capability: { ...options.capability, signal: controller.signal }, fetch: async (req) => {
      controller.abort();
      forwarded = req.signal.aborted;
      throw new Error("provider may have billed this request");
    } });
    expect((await handler(request())).status).toBe(408);
    expect(forwarded).toBe(true);
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(1);
  });

  test("budget exhaustion latches without fetch; new handlers cannot reset it", async () => {
    ledger.close();
    ledger = new SpendLedger(":memory:");
    ledger.createCampaign("pilot", 1);
    ledger.enrollTicket("pilot", "TICKET-1", 1);
    const first = setup();
    expect((await first.handler(request())).status).toBe(402);
    expect(ledger.status("TICKET-1")!.state).toBe("exhausted");
    const second = setup();
    expect((await second.handler(request())).status).toBe(402);
    expect(first.sent.length + second.sent.length).toBe(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("missing or unknown receipt counters never become refunds or invented OAI usage", async () => {
    for (const usage of [undefined, { input_tokens: 10, output_tokens: 2 }, { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, new_usage_field: 5 }]) {
      const { handler } = setup({ fetch: async () => Response.json(providerBody({ usage })) });
      const response = await handler(request());
      expect(response.status).toBe(200);
      expect((await response.json()).usage).toBeUndefined();
    }
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(3);
    expect(ledger.status("TICKET-1")!.chargedMicros).toBe(3 * spendReservationMicros("deepseek", 128));
  });

  test("every explicit retry reserves separately; transport never retries errors itself", async () => {
    let calls = 0;
    const { handler } = setup({ fetch: async () => { calls++; return Response.json({ error: "SECRET provider detail" }, { status: 429 }); } });
    for (let i = 0; i < 2; i++) {
      const response = await handler(request());
      expect(response.status).toBe(429);
      expect(await response.text()).not.toContain("SECRET");
    }
    expect(calls).toBe(2);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(2);
    expect(ledger.status("TICKET-1")!.chargedMicros).toBe(2 * spendReservationMicros("deepseek", 128));
  });

  test("network errors and malformed provider JSON remain charged", async () => {
    for (const fetch of [async () => { throw new Error("SECRET-network"); }, async () => new Response("SECRET-not-json")]) {
      const { handler } = setup({ fetch });
      const response = await handler(request());
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("SECRET");
    }
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(2);
  });

  test("redirects never follow and retain unknown reservation", async () => {
    let count = 0;
    const { handler } = setup({ fetch: async (req) => { count++; expect(req.redirect).toBe("manual"); return new Response(null, { status: 302, headers: { location: "https://unpriced.invalid/messages" } }); } });
    expect((await handler(request())).ok).toBe(false);
    expect(count).toBe(1);
    expect(ledger.status("TICKET-1")!.unknownAttempts).toBe(1);
  });

  test("same-ticket concurrency is rejected across factories before a second reservation", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = setup({ fetch: async () => { entered(); await waiting; return Response.json(providerBody()); } });
    const running = first.handler(request());
    await started;
    const second = setup();
    expect((await second.handler(request())).status).toBe(409);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(1);
    release();
    expect((await running).status).toBe(200);
    expect((await second.handler(request())).status).toBe(200);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(2);
  });

  test("function tool requests and results round-trip with grouped Anthropic results", async () => {
    const sent: Body[] = [];
    const { handler } = setup({ fetch: async (req) => {
      sent.push(await req.json());
      return Response.json(sent.length === 1 ? providerBody({ content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } }, { type: "tool_use", id: "call_2", name: "read_file", input: { path: "package.json" } }], stop_reason: "tool_use" }) : providerBody());
    } });
    const initial = await handler(request({ tools: [TOOL], tool_choice: "auto", parallel_tool_calls: true }));
    expect(initial.status).toBe(200);
    const completion = await initial.json();
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect(completion.choices[0].message.tool_calls[0]).toEqual(call());
    expect(sent[0]!.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: false });
    const response = await handler(request({ tools: [TOOL], messages: [{ role: "user", content: "Read files" }, completion.choices[0].message,
      { role: "tool", tool_call_id: "call_1", content: "README contents" }, { role: "tool", tool_call_id: "call_2", content: "Package contents" }] }));
    expect(response.status).toBe(200);
    expect((sent[1]!.messages as Body[])[2]).toEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "README contents" }] },
      { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "Package contents" }] },
    ] });
  });

  test("rejects orphan/duplicate results, malformed arguments and historical disallowed tools", async () => {
    const { handler, sent } = setup();
    const user = { role: "user", content: "Read" };
    const result = { role: "tool", tool_call_id: "call_1", content: "done" };
    const assistant = (calls: unknown[]) => ({ role: "assistant", content: null, tool_calls: calls });
    const histories = [
      [user, result], [user, assistant([call()]), result, result], [user, assistant([call(), call()]), result],
      [user, assistant([call("call_1", "read_file", "[]")]), result],
      [user, assistant([call("call_1", "read_file", "not json")]), result],
      [user, assistant([call("call_1", "read_file", '{"limit":{"nested":[1e309]}}')]), result],
      [user, assistant([call("call_1", "send_email")]), result],
      [user, assistant([call()]), { role: "user", content: "Skip tool result" }],
    ];
    for (const messages of histories) expect((await handler(request({ messages, tools: [TOOL] }))).status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("rejects unknown/native returned tool blocks and unoffered tool names", async () => {
    for (const content of [
      [{ type: "tool_use", id: "call_1", name: "send_email", input: {} }],
      [{ type: "server_tool_use", id: "call_1", name: "web_search", input: {} }],
      [{ type: "thinking", thinking: "Private reasoning", signature: "x" }],
    ]) {
      const { handler } = setup({ fetch: async () => Response.json(providerBody({ content, stop_reason: "tool_use" })) });
      expect((await handler(request({ tools: [TOOL] }))).status).toBe(502);
    }
  });

  test("provider replies must honor none, forced-tool and no-parallel request constraints", async () => {
    const read = { type: "tool_use", id: "call_1", name: "read_file", input: {} };
    const run = { type: "tool_use", id: "call_2", name: "run_bash", input: {} };
    const runTool = { type: "function", function: { ...TOOL.function, name: "run_bash" } };
    for (const fixture of [
      { options: { tool_choice: "none" }, content: [read] },
      { options: { tool_choice: { type: "function", function: { name: "read_file" } } }, content: [run] },
      { options: { parallel_tool_calls: false }, content: [read, run] },
      { options: { tool_choice: "required" }, content: [{ type: "text", text: "No tool chosen." }] },
    ]) {
      const { handler } = setup({ fetch: async () => Response.json(providerBody({ content: fixture.content, stop_reason: fixture.content[0]!.type === "text" ? "end_turn" : "tool_use" })) });
      expect((await handler(request({ tools: [TOOL, runTool], ...fixture.options }))).status).toBe(502);
    }
  });

  test("numeric overflow in tool schemas and returned arguments never becomes executable null", async () => {
    const first = setup();
    const raw = JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 128, messages: [{ role: "user", content: "read" }], tools: [TOOL] }).replace('"type":"object"', '"type":"object","minimum":1e309');
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: raw });
    expect((await first.handler(req)).status).toBe(400);
    expect(first.sent).toHaveLength(0);
    const payload = JSON.stringify(providerBody({ content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { limit: "OVERFLOW" } }], stop_reason: "tool_use" })).replace('"OVERFLOW"', '1e309');
    const second = setup({ fetch: async () => new Response(payload, { headers: { "content-type": "application/json" } }) });
    expect((await second.handler(request({ tools: [TOOL] }))).status).toBe(502);
  });

  test("capability snapshot cannot gain tools or extend its deadline through mutation", async () => {
    const tools = ["read_file"];
    const { options } = setup();
    const mutable = { ...options.capability, allowedToolNames: tools };
    const handler = createModelTransport({ ...options, capability: mutable });
    tools.push("send_email");
    mutable.deadlineMs = Date.now() + 60000;
    expect((await handler(request({ tools: [{ type: "function", function: { ...TOOL.function, name: "send_email" } }] }))).status).toBe(400);
    expect(ledger.status("TICKET-1")!.attemptCount).toBe(0);
  });

  test("unknown spend survives ledger reopen and factory recreation without reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gary-transport-test-"));
    const path = join(dir, "spend.sqlite");
    let persistent = new SpendLedger(path);
    try {
      persistent.createCampaign("pilot", 25);
      persistent.enrollTicket("pilot", "TICKET-1", 25);
      const first = setup({ ledger: persistent, fetch: async () => Response.json(providerBody({ usage: undefined })) });
      expect((await first.handler(request())).status).toBe(200);
      const charged = persistent.status("TICKET-1")!.chargedMicros;
      persistent.close();
      persistent = new SpendLedger(path);
      const second = setup({ ledger: persistent });
      expect(persistent.status("TICKET-1")!.chargedMicros).toBe(charged);
      expect(persistent.status("TICKET-1")!.unknownAttempts).toBe(1);
      expect((await second.handler(request())).status).toBe(200);
      expect(persistent.status("TICKET-1")!.attemptCount).toBe(2);
      expect(persistent.status("TICKET-1")!.unknownAttempts).toBe(1);
    } finally { persistent.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
