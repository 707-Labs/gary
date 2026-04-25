import { describe, expect, it } from "bun:test";
import {
  createRateLimitGate,
  parseUsageLimitError,
  UsageLimitError,
} from "../src/rate-limit.ts";

describe("parseUsageLimitError", () => {
  it("parses the Z.ai 5-hour cap message", () => {
    const raw =
      '429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-04-25 15:43:26"},"request_id":"abc"}';
    const d = parseUsageLimitError(raw);
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe("2026-04-25T15:43:26.000Z");
  });

  it("parses with T separator instead of space", () => {
    const raw = "Usage limit reached for 5 hour. Your limit will reset at 2026-04-25T15:43:26";
    expect(parseUsageLimitError(raw)?.toISOString()).toBe(
      "2026-04-25T15:43:26.000Z",
    );
  });

  it("returns null on unrelated messages", () => {
    expect(parseUsageLimitError("400 bad request")).toBeNull();
    expect(parseUsageLimitError("429 Too Many Requests")).toBeNull();
    expect(parseUsageLimitError("")).toBeNull();
  });

  it("returns null when the timestamp is malformed", () => {
    expect(
      parseUsageLimitError("Usage limit reached. reset at NOPE-NOPE-NOPE 99:99:99"),
    ).toBeNull();
  });
});

describe("RateLimitGate", () => {
  it("starts disarmed", () => {
    const g = createRateLimitGate();
    expect(g.isArmed()).toBe(false);
    expect(g.armedUntil()).toBeNull();
  });

  it("arms until the given time", () => {
    const g = createRateLimitGate();
    const future = new Date(Date.now() + 60_000);
    g.armUntil(future);
    expect(g.isArmed()).toBe(true);
    expect(g.armedUntil()?.getTime()).toBe(future.getTime());
  });

  it("disarms once now > armedUntil", () => {
    const g = createRateLimitGate();
    const past = new Date(Date.now() - 60_000);
    g.armUntil(past);
    expect(g.isArmed()).toBe(false);
  });

  it("only extends, never shortens", () => {
    const g = createRateLimitGate();
    const later = new Date(Date.now() + 600_000);
    const sooner = new Date(Date.now() + 60_000);
    g.armUntil(later);
    g.armUntil(sooner);
    expect(g.armedUntil()?.getTime()).toBe(later.getTime());
  });

  it("reset() clears the armed state", () => {
    const g = createRateLimitGate();
    g.armUntil(new Date(Date.now() + 60_000));
    g.reset();
    expect(g.isArmed()).toBe(false);
    expect(g.armedUntil()).toBeNull();
  });
});

describe("UsageLimitError", () => {
  it("carries the resetAt date", () => {
    const reset = new Date("2026-04-25T15:43:26Z");
    const err = new UsageLimitError(reset);
    expect(err.resetAt).toBe(reset);
    expect(err.name).toBe("UsageLimitError");
    expect(err instanceof Error).toBe(true);
  });
});
