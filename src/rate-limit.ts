import { log } from "./logger.ts";

/**
 * Thrown when a provider responds with a long-window usage limit (e.g.
 * Z.ai's 5-hour cap). Distinct from generic 429s — this one we wait out
 * by arming the rate-limit gate, not by retrying immediately.
 */
export class UsageLimitError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date, message?: string) {
    super(message ?? `usage limit reached; resets at ${resetAt.toISOString()}`);
    this.name = "UsageLimitError";
    this.resetAt = resetAt;
  }
}

/**
 * Z.ai's 5-hour cap returns:
 *   429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-04-25 15:43:26"},...}
 *
 * The reset timestamp is server time. Z.ai's docs and observed behavior treat
 * it as UTC. If they're ever off by a timezone we wait too long (safe).
 */
const USAGE_LIMIT_PATTERN =
  /Usage limit reached[^"]*?reset at\s+(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/i;

export function parseUsageLimitError(message: string): Date | null {
  const m = message.match(USAGE_LIMIT_PATTERN);
  if (!m || !m[1] || !m[2]) return null;
  const iso = `${m[1]}T${m[2]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface RateLimitGate {
  /** True when a back-off is currently in effect. */
  isArmed(now?: Date): boolean;
  /** When the back-off clears, or null if not armed. */
  armedUntil(): Date | null;
  /** Arm (or extend) the back-off until at least the given time. */
  armUntil(resetAt: Date): void;
  /** Manually clear the back-off (mainly for tests). */
  reset(): void;
}

export function createRateLimitGate(): RateLimitGate {
  let until: Date | null = null;
  return {
    isArmed(now = new Date()) {
      return until !== null && until.getTime() > now.getTime();
    },
    armedUntil: () => until,
    armUntil(resetAt) {
      if (until === null || resetAt.getTime() > until.getTime()) {
        until = resetAt;
        log.warn("rate-limit gate armed", { until: resetAt.toISOString() });
      }
    },
    reset() {
      until = null;
    },
  };
}
