/** Host-selected fixed lifetime; this module has no filesystem/process effects.
 * Legacy jobs retain 30 minutes. Standing sessions require the original
 * admission window, also bound into the durable guardian invocation. */
export interface StandingEngineeringSessionWindow {
  readonly startedAtMs: number;
  readonly deadlineMs: number;
}
export interface ExecutorGuardianDeadlineBinding {
  readonly deadlineMs: number;
  readonly expectedBinding: string;
  readonly standingSession?: StandingEngineeringSessionWindow;
}
export const LEGACY_GUARDIAN_MAX_MS = 30 * 60_000;
export const STANDING_ENGINEERING_MAX_MS = 150 * 60_000;
function fail(): never { throw new Error('executor_guardian_deadline_invalid'); }

export function snapshotStandingEngineeringSessionWindow(value: StandingEngineeringSessionWindow): Readonly<StandingEngineeringSessionWindow> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Reflect.ownKeys(value).length !== 2) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const start = descriptors.startedAtMs, end = descriptors.deadlineMs;
  if (!start || !end || !Object.hasOwn(start, 'value') || !Object.hasOwn(end, 'value')
      || !start.enumerable || !end.enumerable) fail();
  const startedAtMs: unknown = start.value, deadlineMs: unknown = end.value;
  if (typeof startedAtMs !== 'number' || !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0
      || typeof deadlineMs !== 'number' || !Number.isSafeInteger(deadlineMs) || deadlineMs <= startedAtMs
      || deadlineMs - startedAtMs > STANDING_ENGINEERING_MAX_MS) fail();
  return Object.freeze({ startedAtMs, deadlineMs });
}

/** Used before launch and independently in the guardian child. A replacement
 * child consumes only the time remaining in the original admission window. */
export function executorGuardianDeadlineDelay(binding: ExecutorGuardianDeadlineBinding, nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(binding.deadlineMs) || binding.deadlineMs <= nowMs) fail();
  if (binding.standingSession === undefined) {
    if (binding.deadlineMs - nowMs > LEGACY_GUARDIAN_MAX_MS) fail();
  } else {
    const window = snapshotStandingEngineeringSessionWindow(binding.standingSession);
    if (window.startedAtMs > nowMs || window.deadlineMs !== binding.deadlineMs) fail();
    let durable: unknown;
    try { durable = JSON.parse(binding.expectedBinding); } catch { fail(); }
    if (!durable || typeof durable !== 'object' || Array.isArray(durable)) fail();
    const recorded = snapshotStandingEngineeringSessionWindow((durable as Record<string, unknown>).standingSession as StandingEngineeringSessionWindow);
    if (recorded.startedAtMs !== window.startedAtMs || recorded.deadlineMs !== window.deadlineMs) fail();
  }
  return binding.deadlineMs - nowMs;
}

/** One monotonic timer, cancellation only: neither messages nor a later wall
 * clock change can renew it. Tests inject an in-memory scheduler. */
export function armExecutorGuardianDeadline(binding: ExecutorGuardianDeadlineBinding, onDeadline: () => void,
  dependencies: { now?: () => number; schedule?: (callback: () => void, delayMs: number) => () => void } = {}): () => void {
  const delay = executorGuardianDeadlineDelay(binding, (dependencies.now ?? Date.now)());
  const schedule = dependencies.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer);
  });
  let active = true;
  const cancel = schedule(() => { if (active) { active = false; onDeadline(); } }, delay);
  return () => { if (active) { active = false; cancel(); } };
}
