/**
 * In-memory doubles for FEAT-107's runtime probe and checker environment.
 *
 * They ship in `src`, not `__tests__`, for the same reason `FakePythonRunner`
 * does: the verification, approval, run, and end-to-end suites all use them,
 * and they are typed against the real seams so a seam change breaks the build.
 */

import { computeRuntimeFingerprint, type RuntimeDetail } from '@automate/core';
import type { ProbedRuntime, RuntimeProbe } from '../runtime-probe';
import type { CheckerResult, CheckerTool } from '../verify-env';
import type { CheckerEnvironment } from '../verification-pass';

export const FAKE_RUNTIME: RuntimeDetail = { pythonVersion: '3.12.4', uvVersion: 'uv 0.11.32', platform: 'linux', arch: 'x64', packages: [{ name: 'pandas', version: '2.3.1' }, { name: 'pytest', version: '8.4.2' }] };

/** A probe whose runtime a test can change, as an upgrade would. */
export class FakeRuntimeProbe implements RuntimeProbe {
  detail: RuntimeDetail;
  probeCount = 0;
  failWith: Error | null = null;
  private memo: ProbedRuntime | null = null;
  constructor(detail: RuntimeDetail = FAKE_RUNTIME) { this.detail = detail; }

  /** @returns The current detail; memoized unless `fresh`, like the real probe. */
  probe(signal: AbortSignal, options: { readonly fresh?: boolean } = {}): Promise<ProbedRuntime> {
    if (this.failWith) return Promise.reject(this.failWith);
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    if (this.memo && !options.fresh) return Promise.resolve(this.memo);
    this.probeCount += 1;
    this.memo = { detail: this.detail, fingerprint: computeRuntimeFingerprint(this.detail) };
    return Promise.resolve(this.memo);
  }

  invalidate(): void { this.memo = null; }

  /** Simulate an upgrade: the next fresh probe sees the new runtime. */
  upgrade(change: Partial<RuntimeDetail>): void { this.detail = { ...this.detail, ...change }; this.memo = null; }
}

const CLEAN: Readonly<Record<CheckerTool, string>> = { ruff: '[]', bandit: '{"errors": [], "results": []}' };

/** One scripted checker response; omitted fields are a clean, successful run. */
export type FakeCheckerResponse = Partial<CheckerResult> & { readonly waitUntil?: Promise<void> };

/** A checker environment that records every invocation and never spawns. */
export class FakeCheckerEnvironment implements CheckerEnvironment {
  readonly calls: { tool: CheckerTool; args: readonly string[] }[] = [];
  ensureCount = 0;
  ensureError: Error | null = null;
  readonly bandit = { configPath: '/verify-env/bandit.yaml', iniPath: '/verify-env/bandit.ini' };
  constructor(private readonly respond: (tool: CheckerTool, args: readonly string[]) => FakeCheckerResponse = () => ({})) {}

  ensureVerifyEnvironment(): Promise<void> {
    this.ensureCount += 1;
    return this.ensureError ? Promise.reject(this.ensureError) : Promise.resolve();
  }

  readonly runTool = async (tool: CheckerTool, args: readonly string[], _timeoutMs: number, signal: AbortSignal): Promise<CheckerResult> => {
    this.calls.push({ tool, args });
    const response = this.respond(tool, args);
    if (response.waitUntil) await Promise.race([response.waitUntil, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))]);
    const aborted = signal.aborted;
    return { exitCode: aborted ? null : 0, stdout: aborted ? '' : CLEAN[tool], stderr: '', droppedBytes: 0, timedOut: false, aborted, spawnError: null, durationMs: 5, ...(aborted ? {} : response) };
  };
}
