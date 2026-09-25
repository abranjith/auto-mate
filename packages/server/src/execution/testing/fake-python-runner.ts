/**
 * An in-memory double for the Python runner seam (FEAT-106).
 *
 * It ships in `src`, not `__tests__`, because the generation, repair-loop, and
 * end-to-end suites all use it, and FEAT-107/108 will too. It is typed against
 * the real `PythonRunner` interface, so a seam change breaks its build.
 */

import type { PythonRunRequest, PythonRunResult, PythonRunner, PythonRuntimeInfo } from '@automate/core';

/** One scripted run. */
export interface FakePythonRun {
  /** Fields of the result; anything omitted defaults to a clean pass. */
  readonly result?: Partial<PythonRunResult>;
  /** Side effect while "running", such as writing a manifest into `AUTOMATE_OUTPUT_DIR`. */
  readonly onRun?: (request: PythonRunRequest) => void | Promise<void>;
  /** Keeps the run live until a test releases it or the request is aborted. */
  readonly waitUntil?: Promise<void>;
}

export interface FakePythonRunnerOptions {
  readonly runtime?: PythonRuntimeInfo;
  readonly probeError?: Error;
  readonly ensureError?: Error;
  /** Keeps `ensureEnvironment` pending until released or aborted. */
  readonly ensureUntil?: Promise<void>;
}

const PASS: PythonRunResult = { outcome: 'passed', exitCode: 0, stdout: '3 passed in 0.10s\n', stderr: '', droppedBytes: 0, durationMs: 100 };

/** Replays scripted runs in order and records every request. */
export class FakePythonRunner implements PythonRunner {
  readonly requests: PythonRunRequest[] = [];
  probeCount = 0;
  ensureCount = 0;
  private index = 0;

  constructor(private readonly runs: readonly FakePythonRun[] = [], private readonly options: FakePythonRunnerOptions = {}) {}

  /** @returns The scripted runtime. @throws The configured probe error. */
  probe(): Promise<PythonRuntimeInfo> {
    this.probeCount += 1;
    if (this.options.probeError) return Promise.reject(this.options.probeError);
    return Promise.resolve(this.options.runtime ?? { uvVersion: 'uv 0.0.0-fake', pythonVersion: '3.12.0' });
  }

  /** @param signal Cancels a gated preparation. @throws The configured preparation error. */
  async ensureEnvironment(signal: AbortSignal): Promise<void> {
    this.ensureCount += 1;
    if (this.options.ensureUntil) await Promise.race([this.options.ensureUntil, aborted(signal)]);
    if (signal.aborted) throw new Error('Environment preparation was cancelled.');
    if (this.options.ensureError) throw this.options.ensureError;
  }

  /** @param request Recorded for assertions. @returns The next scripted result, or `aborted` once the signal fires. */
  async run(request: PythonRunRequest): Promise<PythonRunResult> {
    this.requests.push(request);
    const scripted = this.runs[this.index] ?? {};
    this.index += 1;
    if (scripted.waitUntil) await Promise.race([scripted.waitUntil, aborted(request.signal)]);
    if (request.signal.aborted) return { ...PASS, outcome: 'aborted', exitCode: null, stdout: '', stderr: '' };
    await scripted.onRun?.(request);
    return { ...PASS, ...scripted.result };
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
