import type { CloudflareConfig } from "../config.ts";
import { log } from "../logger.ts";

/**
 * Read-only adapter over Cloudflare Workers Observability.
 *
 * Wraps the public telemetry API:
 *   POST /accounts/{id}/workers/observability/telemetry/query
 *   POST /accounts/{id}/workers/observability/telemetry/keys
 *   POST /accounts/{id}/workers/observability/telemetry/values
 *
 * We expose two views to Gary: `events` (individual log lines, useful for
 * grepping for an error message) and `invocations` (request-grouped, useful
 * for "show me recent failing requests"). Source maps are uploaded by the
 * Ertai workers, so stack traces come back de-minified.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface LogEvent {
  /** Unix ms. */
  timestamp: number;
  /** Worker / service name from `$metadata.service`. */
  service: string;
  /** `$metadata.message` if present, otherwise the raw message. */
  message: string;
  /** Log level if structured (`log` / `warn` / `error` / etc.), or null. */
  level: string | null;
  /** `$metadata.error` if the event was an exception. */
  error: string | null;
  /** Linkable invocation/trigger id, if present. */
  invocationId: string | null;
  /** Full event row from CF, for the model to dig into if it needs more. */
  raw: Record<string, unknown>;
}

export interface D1QueryResult {
  rows: Record<string, unknown>[];
  rowsRead: number;
  rowsWritten: number;
  durationMs: number;
}

export interface InvocationSummary {
  /** Invocation id (= `$metadata.id` in events). */
  invocationId: string;
  /** Worker name. */
  service: string;
  /** Unix ms. */
  timestamp: number;
  /** HTTP status code if this was a fetch invocation, else null. */
  status: number | null;
  /** Wall-clock duration ms if reported, else null. */
  durationMs: number | null;
  /** True if any event in the invocation had an error. */
  hasError: boolean;
  /** Event count in the invocation. */
  events: number;
  /** Top-level invocation metadata for the model to read. */
  raw: Record<string, unknown>;
}

export interface QueryArgs {
  /** Worker name. Falls back to all configured workers if omitted. */
  service?: string;
  /** Free-text substring search across event payloads. */
  needle?: string;
  /** Only include events with `$metadata.error` set. */
  errorsOnly?: boolean;
  /** Window length in minutes ending at "now". Default 60, max 7 days. */
  sinceMinutes?: number;
  /** Max events. Default 50, hard ceiling 200. */
  limit?: number;
}

export class CloudflareClient {
  constructor(private readonly cfg: CloudflareConfig) {}

  /**
   * Run an `events` view query. Returns flattened log events.
   *
   * If `service` is omitted, queries across all `cfg.observabilityWorkers`.
   */
  async queryLogs(args: QueryArgs = {}): Promise<LogEvent[]> {
    const body = this.buildQueryBody({ ...args, view: "events" });
    const response = await this.post("/telemetry/query", body);
    const events = extractArray(response, "events");
    return events.map((e) => normalizeEvent(e));
  }

  /**
   * Run an `invocations` view query. Returns one row per request/invocation.
   */
  async listInvocations(args: QueryArgs = {}): Promise<InvocationSummary[]> {
    const body = this.buildQueryBody({ ...args, view: "invocations" });
    const response = await this.post("/telemetry/query", body);
    const invocations = extractArray(response, "invocations");
    return invocations.map((i) => normalizeInvocation(i));
  }

  /**
   * Run a read-only D1 query against one of the configured databases.
   * Throws if the SQL isn't a SELECT/WITH/EXPLAIN/PRAGMA, or if the database
   * alias isn't registered in cfg.d1Databases.
   */
  async queryD1(args: {
    database: string;
    sql: string;
    params?: readonly (string | number | null)[];
  }): Promise<D1QueryResult> {
    const databaseId = this.cfg.d1Databases[args.database];
    if (!databaseId) {
      const known = Object.keys(this.cfg.d1Databases).join(", ") || "(none)";
      throw new Error(
        `unknown d1 database alias '${args.database}'. Known: ${known}`,
      );
    }
    assertReadOnlySql(args.sql);
    const url = `${API_BASE}/accounts/${this.cfg.accountId}/d1/database/${databaseId}/query`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiToken}`,
      },
      body: JSON.stringify({ sql: args.sql, params: args.params ?? [] }),
    });
    if (!res.ok) {
      const text = await res.text();
      log.error("cloudflare d1 error", {
        database: args.database,
        status: res.status,
        body: text.slice(0, 500),
      });
      throw new Error(`cloudflare d1 ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as unknown;
    return parseD1Response(json);
  }

  /** Diagnostic — list the keys CF currently sees in the telemetry dataset. */
  async listKeys(): Promise<Array<{ key: string; type: string }>> {
    const response = await this.post("/telemetry/keys", {});
    const result = isObject(response) && Array.isArray(response.result)
      ? response.result
      : [];
    return result
      .filter(isObject)
      .map((r) => ({
        key: String(r.key ?? ""),
        type: String(r.type ?? "string"),
      }))
      .filter((r) => r.key.length > 0);
  }

  // ---- internals ----

  private buildQueryBody(args: QueryArgs & { view: "events" | "invocations" }): Record<string, unknown> {
    const now = Date.now();
    const sinceMs = clamp(args.sinceMinutes ?? 60, 1, 7 * 24 * 60) * 60_000;
    const limit = clamp(args.limit ?? 50, 1, 200);

    const services = args.service
      ? [args.service]
      : this.cfg.observabilityWorkers;

    const filters: Array<Record<string, unknown>> = [];
    if (services.length === 1) {
      filters.push({
        key: "$metadata.service",
        operation: "eq",
        type: "string",
        value: services[0],
      });
    } else if (services.length > 1) {
      filters.push({
        key: "$metadata.service",
        operation: "in",
        type: "string",
        value: services.join(","),
      });
    }
    if (args.errorsOnly) {
      filters.push({
        key: "$metadata.error",
        operation: "exists",
        type: "string",
      });
    }

    const parameters: Record<string, unknown> = {
      datasets: [],
      filterCombination: "and",
      filters,
      limit,
    };
    if (args.needle) {
      parameters.needle = {
        value: args.needle,
        isRegex: false,
        matchCase: false,
      };
    }

    return {
      queryId: crypto.randomUUID(),
      timeframe: { from: now - sinceMs, to: now },
      view: args.view,
      parameters,
      limit,
      dry: false,
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = `${API_BASE}/accounts/${this.cfg.accountId}/workers/observability${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      log.error("cloudflare api error", {
        path,
        status: res.status,
        body: text.slice(0, 500),
      });
      throw new Error(`cloudflare ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

const READ_ONLY_VERB = /^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i;

/**
 * Reject anything that isn't a single read-only statement. We strip line and
 * block comments first so a comment can't smuggle "SELECT" in front of a
 * mutating statement.
 */
function assertReadOnlySql(sql: string): void {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
  if (!READ_ONLY_VERB.test(stripped)) {
    throw new Error(
      "d1 query must start with SELECT, WITH, EXPLAIN, or PRAGMA — write operations are not permitted",
    );
  }
  // Forbid multi-statement payloads. A trailing semicolon is fine; a second
  // statement after it is not.
  const trimmed = stripped.replace(/;\s*$/, "");
  if (trimmed.includes(";")) {
    throw new Error("d1 query must be a single statement");
  }
}

function parseD1Response(raw: unknown): D1QueryResult {
  const empty: D1QueryResult = { rows: [], rowsRead: 0, rowsWritten: 0, durationMs: 0 };
  if (!isObject(raw)) return empty;
  const result = raw.result;
  if (!Array.isArray(result) || result.length === 0) return empty;
  const first = result[0];
  if (!isObject(first)) return empty;
  const rows = Array.isArray(first.results)
    ? first.results.filter(isObject)
    : [];
  const meta = isObject(first.meta) ? first.meta : {};
  return {
    rows,
    rowsRead: typeof meta.rows_read === "number" ? meta.rows_read : 0,
    rowsWritten: typeof meta.rows_written === "number" ? meta.rows_written : 0,
    durationMs: typeof meta.duration === "number" ? meta.duration : 0,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pull rows out of the API response, defending against shape drift.
 *
 * The response wraps each view in a container object: `result.events.events[]`,
 * `result.invocations.invocations[]`, etc. Older drafts of the docs implied
 * `result.events[]` directly; the live API uses the nested form. We try both.
 */
function extractArray(response: unknown, key: string): Record<string, unknown>[] {
  if (!isObject(response)) return [];
  const result = response.result;
  if (!isObject(result)) return [];
  const container = result[key];
  if (Array.isArray(container)) return container.filter(isObject);
  if (isObject(container)) {
    const inner = container[key];
    if (Array.isArray(inner)) return inner.filter(isObject);
  }
  return [];
}

function normalizeEvent(row: Record<string, unknown>): LogEvent {
  const metadata = isObject(row.$metadata) ? row.$metadata : {};
  const timestamp = numberOf(metadata.timestamp ?? row.timestamp ?? row.time ?? 0);
  const service = stringOf(metadata.service ?? row.service ?? "");
  const message = stringOf(metadata.message ?? row.message ?? "");
  const level = nullableStringOf(metadata.level ?? row.level);
  const error = nullableStringOf(metadata.error ?? row.error);
  const invocationId = nullableStringOf(
    metadata.id ?? metadata.invocationId ?? row.invocationId,
  );
  return { timestamp, service, message, level, error, invocationId, raw: row };
}

function normalizeInvocation(row: Record<string, unknown>): InvocationSummary {
  const metadata = isObject(row.$metadata) ? row.$metadata : {};
  const events = isObject(row.events) ? row.events : null;

  return {
    invocationId: stringOf(metadata.id ?? row.invocationId ?? ""),
    service: stringOf(metadata.service ?? row.service ?? ""),
    timestamp: numberOf(metadata.timestamp ?? row.timestamp ?? 0),
    status: nullableNumberOf(metadata.status ?? row.status),
    durationMs: nullableNumberOf(
      metadata.durationMs ?? metadata.wallTimeMs ?? row.durationMs,
    ),
    hasError:
      metadata.error !== undefined ||
      row.error !== undefined ||
      (events !== null && Number(events.errors ?? 0) > 0),
    events: numberOf(
      isObject(events) ? events.total : 0,
    ),
    raw: row,
  };
}

function stringOf(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function nullableStringOf(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function numberOf(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function nullableNumberOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
