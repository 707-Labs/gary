import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { GLMClient } from "../src/adapters/glm.ts";
import { DeadlineExceededError } from "../src/deadline.ts";
import { createProvider, createProviderChain, type LLMProvider } from "../src/providers.ts";
import { createRateLimitGate } from "../src/rate-limit.ts";

interface RequestOptions {
  signal?: AbortSignal;
  maxRetries?: number;
  timeout?: number;
}

function message(): Anthropic.Message {
  return {
    id: "offline-message", type: "message", role: "assistant", model: "offline-model",
    content: [{ type: "text", text: "late answer" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}

function provider(
  name: LLMProvider["name"],
  create: (_body: unknown, options?: RequestOptions) => Promise<Anthropic.Message>,
): LLMProvider {
  return {
    name, model: "offline-model", gate: createRateLimitGate(), defaultBackoffMs: 1_000,
    parse429: () => null,
    client: { messages: { create } } as unknown as Anthropic,
  };
}

const calls = {
  complete: (glm: GLMClient, deadlineMs: number) =>
    glm.complete({ system: "offline fixture", user: "test", deadlineMs }),
  createMessage: (glm: GLMClient, deadlineMs: number) =>
    glm.createMessage({ max_tokens: 8, messages: [{ role: "user", content: "test" }] }, { deadlineMs }),
};

describe("GLMClient shared deadlines", () => {
  for (const [name, call] of Object.entries(calls)) {
    it(`${name} cancels the SDK request without retrying or falling back after expiry`, async () => {
      let captured: RequestOptions | undefined;
      let attempts = 0;
      let fallbackCalls = 0;
      let pending = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let signal: AbortSignal | undefined;
      let onAbort: (() => void) | undefined;
      const primary = provider("z.ai", async (_body, options) => {
        attempts++;
        captured = options;
        signal = options?.signal;
        pending = true;
        return new Promise((resolve, reject) => {
          const cleanup = () => {
            pending = false;
            if (watchdog !== undefined) clearTimeout(watchdog);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
          };
          onAbort = () => {
            cleanup();
            // Even if a transport reports a retryable error while aborting,
            // cancellation must win over the provider fallback path.
            reject(Object.assign(new Error("transport cancelled"), { status: 429 }));
          };
          watchdog = setTimeout(() => { cleanup(); resolve(message()); }, 500);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      });
      const fallback = provider("kimi", async () => { fallbackCalls++; return message(); });
      const glm = new GLMClient(createProviderChain([primary, fallback]));
      try {
        await expect(call(glm, Date.now() + 50)).rejects.toBeInstanceOf(DeadlineExceededError);
        expect(captured?.signal).toBeInstanceOf(AbortSignal);
        expect(captured?.signal?.aborted).toBe(true);
        expect(captured?.maxRetries).toBe(0);
        expect(captured?.timeout).toBeGreaterThan(0);
        expect(captured?.timeout).toBeLessThanOrEqual(50);
        expect(pending).toBe(false);
        expect(attempts).toBe(1);
        expect(fallbackCalls).toBe(0);
        expect(primary.gate.isArmed()).toBe(false);
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    });

    it(`${name} rejects a response delivered as cancellation settles`, async () => {
      let signal: AbortSignal | undefined;
      let onAbort: (() => void) | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let responseDelivered = false;
      const primary = provider("z.ai", async (_body, options) => {
        signal = options?.signal;
        return new Promise((resolve) => {
          onAbort = () => {
            if (watchdog !== undefined) clearTimeout(watchdog);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
            // Simulate an already-buffered response winning the SDK's abort
            // race; the adapter must check the deadline after awaiting it.
            responseDelivered = true;
            resolve(message());
          };
          watchdog = setTimeout(onAbort, 500);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      });
      try {
        await expect(call(new GLMClient(createProviderChain([primary])), Date.now() + 50))
          .rejects.toBeInstanceOf(DeadlineExceededError);
        expect(responseDelivered).toBe(true);
        expect(signal?.aborted).toBe(true);
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    });
  }

  it("disables the real SDK's automatic retries using an entirely mocked transport", async () => {
    let transportCalls = 0;
    const primary = createProvider({
      name: "z.ai", model: "offline-model", apiKey: "offline-test-key",
      baseUrl: "https://offline.invalid", defaultBackoffMs: 1_000,
    }, {
      fetch: (async () => {
        transportCalls++;
        return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "offline 500 fixture" } }), {
          status: 500, headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const glm = new GLMClient(createProviderChain([primary]));
    await expect(glm.complete({ system: "", user: "offline", deadlineMs: Date.now() + 1_000 }))
      .rejects.toThrow("offline 500 fixture");
    expect(transportCalls).toBe(1);
  });

  it("does not start a provider call when the inherited deadline has already expired", async () => {
    let attempts = 0;
    const primary = provider("z.ai", async () => { attempts++; return message(); });
    const glm = new GLMClient(createProviderChain([primary]));
    await expect(glm.complete({ system: "", user: "offline", deadlineMs: Date.now() - 1 }))
      .rejects.toBeInstanceOf(DeadlineExceededError);
    expect(attempts).toBe(0);
  });
});


describe('GLM trusted host cancellation', () => {
  for (const method of ['complete', 'createMessage'] as const) it(method + ' composes inherited and explicit signals and awaits transport cleanup', async () => {
    const host = new AbortController(), local = new AbortController(), reason = new Error('host stopped');
    let entered!: () => void, released!: () => void, sawAbort!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const drain = new Promise<void>(resolve => { released = resolve; });
    const aborted = new Promise<void>(resolve => { sawAbort = resolve; });
    let cleaned = false, settled = false, attempts = 0, fallbacks = 0;
    let captured: RequestOptions | undefined;
    const primary = provider('deepseek', async (_body, options) => {
      attempts++; captured = options; entered();
      await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => { sawAbort(); resolve(); }, { once: true }));
      await drain; cleaned = true;
      throw Object.assign(new Error('retryable transport failure during shutdown'), { status: 429 });
    });
    const glm = new GLMClient(createProviderChain([primary, provider('kimi', async () => { fallbacks++; return message(); })]), { signal: host.signal });
    const pending = method === 'complete' ? glm.complete({ system: '', user: 'offline', signal: local.signal })
      : glm.createMessage({ max_tokens: 8, messages: [{ role: 'user', content: 'offline' }] }, { signal: local.signal });
    const result = pending.then(() => { settled = true; throw new Error('unexpected success'); }, error => { settled = true; return error; });
    await started; host.abort(reason); await aborted; await Bun.sleep(5);
    expect(settled).toBe(false); expect(cleaned).toBe(false); expect(local.signal.aborted).toBe(false);
    expect(captured?.signal?.aborted).toBe(true); expect(captured?.maxRetries).toBe(0);
    released(); expect(await result).toBe(reason); expect(cleaned).toBe(true);
    expect(attempts).toBe(1); expect(fallbacks).toBe(0); expect(primary.gate.isArmed()).toBe(false);
  });

  it('disables real SDK retry sleeps for signal-only calls with a completely fake transport', async () => {
    const controller = new AbortController(); let physicalRequests = 0;
    const primary = createProvider({ name: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'fake-only',
      baseUrl: 'https://offline.invalid', defaultBackoffMs: 1000 }, { fetch: (async () => {
        physicalRequests++; return Response.json({ type: 'error', error: { type: 'api_error', message: 'offline failure' } }, { status: 500 });
      }) as unknown as typeof fetch });
    await expect(new GLMClient(createProviderChain([primary]), { signal: controller.signal }).complete({ system: '', user: 'offline' })).rejects.toThrow('offline failure');
    expect(physicalRequests).toBe(1);
  });

  it('an already-aborted host starts no request and omitted signal keeps legacy SDK defaults', async () => {
    const host = new AbortController(); host.abort(new Error('already stopped'));
    let requests = 0, options: RequestOptions | undefined;
    const chain = createProviderChain([provider('deepseek', async (_body, opts) => { requests++; options = opts; return message(); })]);
    await expect(new GLMClient(chain, { signal: host.signal }).complete({ system: '', user: 'offline' })).rejects.toThrow('already stopped');
    expect(requests).toBe(0);
    await new GLMClient(chain).complete({ system: '', user: 'offline' });
    expect(requests).toBe(1); expect(options?.maxRetries).toBeUndefined(); expect(options?.timeout).toBeUndefined();
  });
});
