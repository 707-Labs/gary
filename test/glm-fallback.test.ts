import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { GLMClient } from "../src/adapters/glm.ts";
import {
  AllProvidersExhaustedError,
  createProviderChain,
  type LLMProvider,
} from "../src/providers.ts";
import { createRateLimitGate } from "../src/rate-limit.ts";

interface FakeOpts {
  /** Sequence of behaviors per call: success(text), 429-with-parseable, 429-no-parse, throw. */
  responses: Array<
    | { kind: "ok"; text: string }
    | { kind: "rate_limit"; resetAt?: Date; message?: string }
    | { kind: "error"; message: string }
  >;
}

function fakeProvider(
  name: "z.ai" | "kimi" | "deepseek",
  opts: FakeOpts,
): LLMProvider & { calls: number } {
  let calls = 0;
  const provider = {
    name,
    model: `${name}-model`,
    gate: createRateLimitGate(),
    defaultBackoffMs: 30_000,
    parse429(message: string): Date | null {
      // Honor the resetAt the test attached to the response, otherwise null.
      const m = message.match(/resetAt=(\S+)/);
      if (!m || !m[1]) return null;
      const d = new Date(m[1]);
      return Number.isNaN(d.getTime()) ? null : d;
    },
    client: {
      messages: {
        async create(_args: unknown): Promise<Anthropic.Message> {
          const i = calls++;
          const r = opts.responses[i];
          if (!r) throw new Error(`no scripted response for call ${i}`);
          if (r.kind === "ok") {
            return {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: provider.model,
              content: [{ type: "text", text: r.text }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            } as Anthropic.Message;
          }
          if (r.kind === "rate_limit") {
            const tagged =
              (r.message ?? "Usage limit reached") +
              (r.resetAt ? ` resetAt=${r.resetAt.toISOString()}` : "");
            const err = new Error(tagged) as Error & { status?: number };
            err.status = 429;
            throw err;
          }
          throw new Error(r.message);
        },
      },
    } as unknown as Anthropic,
    get calls() {
      return calls;
    },
  };
  return provider as LLMProvider & { calls: number };
}

describe("GLMClient.complete — provider fallback", () => {
  it("returns the first provider's response when no rate limit hits", async () => {
    const a = fakeProvider("z.ai", { responses: [{ kind: "ok", text: "from-z" }] });
    const b = fakeProvider("kimi", { responses: [] });
    const glm = new GLMClient(createProviderChain([a, b]));
    const out = await glm.complete({ system: "", user: "" });
    expect(out).toBe("from-z");
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
  });

  it("falls through to the next provider on 429", async () => {
    const reset = new Date(Date.now() + 60_000);
    const a = fakeProvider("z.ai", {
      responses: [{ kind: "rate_limit", resetAt: reset }],
    });
    const b = fakeProvider("kimi", {
      responses: [{ kind: "ok", text: "from-kimi" }],
    });
    const glm = new GLMClient(createProviderChain([a, b]));
    const out = await glm.complete({ system: "", user: "" });
    expect(out).toBe("from-kimi");
    expect(a.gate.isArmed()).toBe(true);
    expect(a.gate.armedUntil()?.getTime()).toBe(reset.getTime());
    expect(b.gate.isArmed()).toBe(false);
  });

  it("uses defaultBackoffMs when the 429 has no parseable timestamp", async () => {
    const a = fakeProvider("z.ai", {
      responses: [{ kind: "rate_limit", message: "no timestamp here" }],
    });
    const b = fakeProvider("kimi", {
      responses: [{ kind: "ok", text: "from-kimi" }],
    });
    const glm = new GLMClient(createProviderChain([a, b]));
    const before = Date.now();
    const out = await glm.complete({ system: "", user: "" });
    const after = Date.now();
    expect(out).toBe("from-kimi");
    const armed = a.gate.armedUntil()!.getTime();
    expect(armed).toBeGreaterThanOrEqual(before + 30_000);
    expect(armed).toBeLessThanOrEqual(after + 30_000 + 100);
  });

  it("throws AllProvidersExhaustedError when every provider 429s", async () => {
    const reset = new Date(Date.now() + 60_000);
    const a = fakeProvider("z.ai", {
      responses: [{ kind: "rate_limit", resetAt: reset }],
    });
    const b = fakeProvider("kimi", {
      responses: [{ kind: "rate_limit", resetAt: reset }],
    });
    const glm = new GLMClient(createProviderChain([a, b]));
    await expect(glm.complete({ system: "", user: "" })).rejects.toBeInstanceOf(
      AllProvidersExhaustedError,
    );
    expect(a.gate.isArmed()).toBe(true);
    expect(b.gate.isArmed()).toBe(true);
  });

  it("does NOT fall through on non-429 errors (e.g. 5xx, malformed input)", async () => {
    const a = fakeProvider("z.ai", {
      responses: [{ kind: "error", message: "500 Internal Server Error" }],
    });
    const b = fakeProvider("kimi", { responses: [] });
    const glm = new GLMClient(createProviderChain([a, b]));
    await expect(glm.complete({ system: "", user: "" })).rejects.toThrow(
      "500 Internal Server Error",
    );
    expect(b.calls).toBe(0);
    // Z.ai's gate is NOT armed — non-429 means the call genuinely failed.
    expect(a.gate.isArmed()).toBe(false);
  });
});

describe("GLMClient.createMessage — provider fallback", () => {
  it("reaches the second provider on 429 and returns its message", async () => {
    const reset = new Date(Date.now() + 60_000);
    const a = fakeProvider("z.ai", {
      responses: [{ kind: "rate_limit", resetAt: reset }],
    });
    const b = fakeProvider("kimi", {
      responses: [{ kind: "ok", text: "from-kimi" }],
    });
    const glm = new GLMClient(createProviderChain([a, b]));
    const msg = await glm.createMessage({
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(msg.content[0]).toMatchObject({ type: "text", text: "from-kimi" });
    // Active provider is now Kimi (Z.ai armed)
    expect(glm.active().name).toBe("kimi");
  });
});
