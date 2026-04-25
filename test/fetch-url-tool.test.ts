import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeToolset } from "../src/agent/tools.ts";
import type { Executor } from "../src/executors/index.ts";

const noopExecutor: Executor = {
  workspaceRoot: "/tmp",
  readFile: async () => "",
  writeFile: async () => {},
  listFiles: async () => [],
  grep: async () => [],
  run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
};

const realFetch = globalThis.fetch;

describe("fetch_url tool", () => {
  let captured: { url: string; userAgent: string | null }[] = [];

  beforeEach(() => {
    captured = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers ?? {});
      captured.push({ url, userAgent: headers.get("User-Agent") });
      return new Response("hello world", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fetches an https url and returns headers + body", async () => {
    const tools = makeToolset(noopExecutor);
    const fetchUrl = tools.handlers.fetch_url!;
    const out = await fetchUrl.run({ url: "https://example.com/foo" });
    expect(out).toContain("status: 200");
    expect(out).toContain("content-type: text/plain");
    expect(out).toContain("hello world");
    expect(captured[0]?.userAgent).toContain("gary-707-labs");
  });

  it("rejects non-http(s) schemes", async () => {
    const tools = makeToolset(noopExecutor);
    const fetchUrl = tools.handlers.fetch_url!;
    const out = await fetchUrl.run({ url: "file:///etc/passwd" });
    expect(out).toMatch(/only http\(s\)/);
    expect(captured).toHaveLength(0);
  });

  it("rejects malformed input via zod", async () => {
    const tools = makeToolset(noopExecutor);
    const fetchUrl = tools.handlers.fetch_url!;
    await expect(fetchUrl.run({ url: "not a url" })).rejects.toThrow();
  });

  it("truncates oversized responses", async () => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(500_000), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;

    const tools = makeToolset(noopExecutor);
    const fetchUrl = tools.handlers.fetch_url!;
    const out = await fetchUrl.run({ url: "https://example.com/big" });
    expect(out).toContain("truncated to 200000");
  });
});
