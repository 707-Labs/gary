import { log } from "./logger.ts";

/**
 * Thrown when a provider's long-window usage limit kicks in (e.g. Z.ai's
 * 5-hour cap, Kimi Code's 5-hour Moderato window). The provider chain
 * uses this to decide when to fall through to the next provider — see
 * `src/providers.ts`.
 */
export class UsageLimitError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date, message?: string) {
    super(message ?? `usage limit reached; resets at ${resetAt.toISOString()}`);
    this.name = "UsageLimitError";
    this.resetAt = resetAt;
  }
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
