/** Host-only evidence. No command, output, credentials or model-supplied text. */
export interface ExecutorCleanupEvidence {
  readonly container: string;
  readonly reason: "removal_failed" | "removal_threw";
  readonly exitCode: number | null;
  readonly timedOut: boolean | null;
}

export class ExecutorCleanupUncertainError extends Error {
  constructor(readonly evidence: Readonly<ExecutorCleanupEvidence>) {
    super("executor_cleanup_uncertain");
    this.name = "ExecutorCleanupUncertainError";
  }
}

/** One-way fence shared by a host action and its executors. Never reset/retry it. */
export class ExecutorCleanupGuard {
  private readonly controller = new AbortController();
  private failure: ExecutorCleanupUncertainError | undefined;
  readonly signal = this.controller.signal;

  assertSafe(): void {
    if (this.failure) throw this.failure;
  }

  markUncertain(evidence: ExecutorCleanupEvidence): never {
    this.failure ??= new ExecutorCleanupUncertainError(Object.freeze({ ...evidence }));
    this.controller.abort(this.failure);
    throw this.failure;
  }
}
