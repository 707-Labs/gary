import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CloudflareClient } from "../src/adapters/cloudflare.ts";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  authHeader: string | null;
}

const realFetch = globalThis.fetch;

function installMockFetch(
  responder: (req: CapturedRequest) => Response,
): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyText = init?.body ? String(init.body) : "{}";
    const headers = new Headers(init?.headers ?? {});
    const req: CapturedRequest = {
      url,
      body: JSON.parse(bodyText) as Record<string, unknown>,
      authHeader: headers.get("Authorization"),
    };
    captured.push(req);
    return responder(req);
  }) as typeof fetch;
  return { captured };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const cfg = {
  apiToken: "test-token-123",
  accountId: "acct-abc",
  observabilityWorkers: ["mulligan-labs", "mulligan-labs-party"],
  d1Databases: { "mulligan-labs": "db-uuid-1" },
};

describe("CloudflareClient", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = () => {
      globalThis.fetch = realFetch;
    };
  });
  afterEach(() => restore());

  it("queryLogs builds an events query and parses results (nested shape)", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse({
        success: true,
        result: {
          // Live API nests rows under result.events.events; the adapter
          // unwraps that so callers see a flat array.
          events: {
            events: [
              {
                $metadata: {
                  timestamp: 1700000000000,
                  service: "mulligan-labs",
                  message: "boom",
                  error: "TypeError: x is undefined",
                  level: "error",
                  id: "inv-1",
                },
              },
              {
                $metadata: {
                  timestamp: 1700000001000,
                  service: "mulligan-labs",
                  message: "ok",
                },
              },
            ],
          },
        },
      }),
    );

    const cf = new CloudflareClient(cfg);
    const events = await cf.queryLogs({
      service: "mulligan-labs",
      errorsOnly: true,
      needle: "boom",
      sinceMinutes: 30,
      limit: 7,
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.error).toBe("TypeError: x is undefined");
    expect(events[0]?.invocationId).toBe("inv-1");

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-abc/workers/observability/telemetry/query",
    );
    expect(req.authHeader).toBe("Bearer test-token-123");
    expect(req.body.view).toBe("events");
    const parameters = req.body.parameters as Record<string, unknown>;
    const filters = parameters.filters as Array<Record<string, unknown>>;
    expect(filters).toHaveLength(2);
    expect(filters[0]).toMatchObject({
      key: "$metadata.service",
      operation: "eq",
      value: "mulligan-labs",
    });
    expect(filters[1]).toMatchObject({
      key: "$metadata.error",
      operation: "exists",
    });
    expect(parameters.needle).toMatchObject({ value: "boom", isRegex: false });
    expect(parameters.limit).toBe(7);
  });

  it("queryLogs uses 'in' filter when no service is specified", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse({ success: true, result: { events: { events: [] } } }),
    );
    const cf = new CloudflareClient(cfg);
    await cf.queryLogs({});
    const req = captured[0]!;
    const parameters = req.body.parameters as Record<string, unknown>;
    const filters = parameters.filters as Array<Record<string, unknown>>;
    expect(filters[0]).toMatchObject({
      key: "$metadata.service",
      operation: "in",
      value: "mulligan-labs,mulligan-labs-party",
    });
  });

  it("listInvocations builds an invocations query and normalizes rows", async () => {
    installMockFetch((req) => {
      expect(req.body.view).toBe("invocations");
      return jsonResponse({
        success: true,
        result: {
          invocations: {
            invocations: [
              {
                $metadata: {
                  id: "inv-99",
                  service: "mulligan-labs",
                  timestamp: 1700000000000,
                  status: 500,
                  durationMs: 123,
                  error: "boom",
                },
                events: { total: 4, errors: 1 },
              },
            ],
          },
        },
      });
    });

    const cf = new CloudflareClient(cfg);
    const invs = await cf.listInvocations({ service: "mulligan-labs" });
    expect(invs).toHaveLength(1);
    expect(invs[0]).toMatchObject({
      invocationId: "inv-99",
      status: 500,
      durationMs: 123,
      hasError: true,
      events: 4,
    });
  });

  it("clamps limits and time windows to safe ranges", async () => {
    const { captured } = installMockFetch(() =>
      jsonResponse({ success: true, result: { events: { events: [] } } }),
    );
    const cf = new CloudflareClient(cfg);
    await cf.queryLogs({ limit: 9999, sinceMinutes: 99999 });
    const req = captured[0]!;
    const parameters = req.body.parameters as Record<string, unknown>;
    expect(parameters.limit).toBe(200);
    const tf = req.body.timeframe as { from: number; to: number };
    expect(tf.to - tf.from).toBe(7 * 24 * 60 * 60_000);
  });

  it("throws on non-2xx responses with a descriptive message", async () => {
    installMockFetch(() => new Response("forbidden", { status: 403 }));
    const cf = new CloudflareClient(cfg);
    await expect(cf.queryLogs({})).rejects.toThrow(/403/);
  });

  describe("queryD1", () => {
    it("rejects writes before hitting the network", async () => {
      const { captured } = installMockFetch(() => jsonResponse({}));
      const cf = new CloudflareClient(cfg);
      await expect(
        cf.queryD1({ database: "mulligan-labs", sql: "DELETE FROM users" }),
      ).rejects.toThrow(/SELECT/);
      expect(captured).toHaveLength(0);
    });

    it("rejects multi-statement payloads", async () => {
      installMockFetch(() => jsonResponse({}));
      const cf = new CloudflareClient(cfg);
      await expect(
        cf.queryD1({
          database: "mulligan-labs",
          sql: "SELECT 1; DROP TABLE users",
        }),
      ).rejects.toThrow(/single statement/);
    });

    it("strips comments before checking the verb", async () => {
      installMockFetch(() => jsonResponse({}));
      const cf = new CloudflareClient(cfg);
      await expect(
        cf.queryD1({
          database: "mulligan-labs",
          sql: "/* SELECT */ DELETE FROM users",
        }),
      ).rejects.toThrow();
    });

    it("posts to the right endpoint and parses rows + meta", async () => {
      const { captured } = installMockFetch(() =>
        jsonResponse({
          success: true,
          result: [
            {
              success: true,
              results: [{ id: 1, name: "alice" }],
              meta: { duration: 0.42, rows_read: 1, rows_written: 0 },
            },
          ],
        }),
      );
      const cf = new CloudflareClient(cfg);
      const out = await cf.queryD1({
        database: "mulligan-labs",
        sql: "SELECT id, name FROM users WHERE id = ?1",
        params: [1],
      });
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0]).toMatchObject({ id: 1, name: "alice" });
      expect(out.rowsRead).toBe(1);

      const req = captured[0]!;
      expect(req.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-abc/d1/database/db-uuid-1/query",
      );
      expect(req.body).toMatchObject({
        sql: "SELECT id, name FROM users WHERE id = ?1",
        params: [1],
      });
    });

    it("rejects unknown database aliases", async () => {
      installMockFetch(() => jsonResponse({}));
      const cf = new CloudflareClient(cfg);
      await expect(
        cf.queryD1({ database: "not-a-real-db", sql: "SELECT 1" }),
      ).rejects.toThrow(/unknown d1 database/);
    });

    it("accepts WITH, EXPLAIN, PRAGMA", async () => {
      installMockFetch(() =>
        jsonResponse({ success: true, result: [{ results: [] }] }),
      );
      const cf = new CloudflareClient(cfg);
      await cf.queryD1({ database: "mulligan-labs", sql: "WITH x AS (SELECT 1) SELECT * FROM x" });
      await cf.queryD1({ database: "mulligan-labs", sql: "EXPLAIN SELECT 1" });
      await cf.queryD1({ database: "mulligan-labs", sql: "PRAGMA table_info(users)" });
    });
  });
});
