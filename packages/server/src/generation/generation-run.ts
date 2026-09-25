// One live generation phase per execution (FEAT-106). The four tools reach
// their execution's budget and cancellation signal through here, so a person's
// abort, a shutdown drain, or a limit stops an in-flight `uv sync` or pytest
// process tree through the same `AbortController` before the provider aborts.

import type { GenerationBudget } from './generation-budget';

/** State a generation phase shares between its session lifecycle and its tools. */
export class GenerationRun {
  private readonly controller = new AbortController();
  constructor(readonly executionId: number, readonly taskId: number, readonly budget: GenerationBudget) {}

  /** Passed into every Python runner call; aborting it kills the process tree. */
  get signal(): AbortSignal { return this.controller.signal; }

  /** Cancel in-flight application work. Idempotent. */
  cancel(): void { if (!this.controller.signal.aborted) this.controller.abort(); }
}

/** The live generation runs, one per execution. */
export class GenerationRuns {
  private readonly runs = new Map<number, GenerationRun>();

  open(run: GenerationRun): GenerationRun {
    this.runs.get(run.executionId)?.cancel();
    this.runs.set(run.executionId, run);
    return run;
  }

  get(executionId: number): GenerationRun | undefined { return this.runs.get(executionId); }

  /** Cancel an execution's in-flight tests and environment preparation, if any are running. */
  cancel(executionId: number): void { this.runs.get(executionId)?.cancel(); }

  /** Forget a settled run. */
  close(executionId: number): void { this.runs.delete(executionId); }
}
