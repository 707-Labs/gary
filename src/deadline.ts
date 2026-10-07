/** A wall-clock budget shared by model calls, tools, and child loops. */
export interface DeadlineOptions {
  /** Absolute milliseconds since epoch; child work may shorten, never extend it. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export class DeadlineExceededError extends Error {
  constructor() {
    super("shared execution deadline exceeded");
    this.name = "DeadlineExceededError";
  }
}

export interface Deadline extends DeadlineOptions {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  throwIfExpired(): void;
  dispose(): void;
}

export function throwIfExpired(options: DeadlineOptions): void {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("aborted", "AbortError");
  }
  if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
    throw new DeadlineExceededError();
  }
}

/**
 * Legacy adapters do not expose request cancellation. Await an in-flight call,
 * but prevent a multi-request tool from starting another call after expiry.
 */
export function guardAdapterCalls<T extends object>(target: T, options: DeadlineOptions): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        throwIfExpired(options);
        const result = await value.apply(object, args);
        throwIfExpired(options);
        return result;
      };
    },
  });
}

/** Dispose after all awaited work settles. Aborting never abandons a running operation. */
export function createDeadline(options: DeadlineOptions & { timeoutMs?: number } = {}): Deadline {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    throw new Error("timeoutMs must be a finite non-negative number");
  }
  const deadlineMs = Math.min(
    options.deadlineMs ?? Infinity,
    options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs,
  );
  const controller = new AbortController();
  const expire = () => controller.abort(new DeadlineExceededError());
  const onAbort = () => controller.abort(options.signal?.reason ?? new DOMException("aborted", "AbortError"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  if (deadlineMs <= Date.now()) expire();
  else if (Number.isFinite(deadlineMs)) timer = setTimeout(expire, Math.min(2_147_483_647, deadlineMs - Date.now()));
  return {
    deadlineMs,
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineMs - Date.now()),
    throwIfExpired() {
      if (Date.now() >= deadlineMs && !controller.signal.aborted) expire();
      throwIfExpired({ signal: controller.signal, deadlineMs });
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}
