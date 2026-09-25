// ---------------------------------------------------------------------------
// The runtime probe (FEAT-107 TASK-009): the facts a `runtime_fingerprint`
// covers — Python and every package as the SCRIPT environment actually has
// them, uv's version, the platform, and the checker versions.
//
// The interpreter and package set are read from inside `env/` with one
// `PythonRunner.run` — the same seam the tests and the real run use, not
// widened (FEAT-106 pins it at three methods) — so the fingerprint describes
// the environment the code runs in, not whatever Python a PATH lookup finds.
// Probing spawns processes and the gate renders often, so the result is
// memoized; approval and the real run ask for a FRESH probe, because a runtime
// that changed after verification must be caught rather than assumed.
// ---------------------------------------------------------------------------

import { computeRuntimeFingerprint, normalizeRuntimeDetail, type PythonRunner, type RuntimeDetail } from '@automate/core';

/** A probed runtime and its fingerprint. */
export interface ProbedRuntime {
  readonly detail: RuntimeDetail;
  readonly fingerprint: string;
}

/** What verification, approval, and the run ask of a probe. */
export interface RuntimeProbe {
  /** @param options.fresh Ignore the memo and probe again. @throws PythonRuntimeUnavailableError when uv or Python is missing. */
  probe(signal: AbortSignal, options?: { readonly fresh?: boolean }): Promise<ProbedRuntime>;
  /** Forget the memoized result. */
  invalidate(): void;
}

/** Application-authored Python that prints the interpreter version and every installed distribution as JSON. No data is read. */
export const PROBE_SCRIPT = 'import importlib.metadata as m, json, sys; print(json.dumps({"python": "%d.%d.%d" % sys.version_info[:3], "packages": sorted([[d.metadata["Name"], d.version] for d in m.distributions() if d.metadata["Name"]])}))';

export interface UvRuntimeProbeOptions {
  readonly runner: PythonRunner;
  /** A neutral working directory for the probe — never generated code's. */
  readonly workingDir: string;
  readonly checkerVersions: (signal: AbortSignal) => Promise<Record<string, string>>;
  readonly platform?: string;
  readonly arch?: string;
  readonly timeoutMs?: number;
}

/** Probes the prepared script environment through the `PythonRunner` seam. */
export class UvRuntimeProbe implements RuntimeProbe {
  private memo: ProbedRuntime | null = null;
  constructor(private readonly options: UvRuntimeProbeOptions) {}

  async probe(signal: AbortSignal, options: { readonly fresh?: boolean } = {}): Promise<ProbedRuntime> {
    if (this.memo && !options.fresh) return this.memo;
    const info = await this.options.runner.probe();
    await this.options.runner.ensureEnvironment(signal);
    const result = await this.options.runner.run({ executionId: 0, workingDir: this.options.workingDir, args: ['-c', PROBE_SCRIPT], env: {}, timeoutMs: this.options.timeoutMs ?? 30_000, signal });
    const parsed = parseProbe(result.stdout);
    if (result.exitCode !== 0 || !parsed) throw new Error('The Python environment could not report its version and packages.');
    const checkers = await this.options.checkerVersions(signal);
    const detail = normalizeRuntimeDetail({ pythonVersion: parsed.python, uvVersion: info.uvVersion, platform: this.options.platform ?? process.platform, arch: this.options.arch ?? process.arch, packages: [...parsed.packages, ...Object.entries(checkers).map(([name, version]) => ({ name: `checker:${name}`, version }))] });
    this.memo = { detail, fingerprint: computeRuntimeFingerprint(detail) };
    return this.memo;
  }

  invalidate(): void { this.memo = null; }
}

/** Read the probe script's JSON; null when it is not that shape. */
export function parseProbe(stdout: string): { python: string; packages: { name: string; version: string }[] } | null {
  try {
    const line = stdout.trim().split(/\r?\n/).at(-1) ?? '';
    const value = JSON.parse(line) as { python?: unknown; packages?: unknown };
    if (typeof value.python !== 'string' || !Array.isArray(value.packages)) return null;
    const packages = (value.packages as unknown[]).filter((item): item is [string, string] => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string').map(([name, version]) => ({ name, version }));
    return { python: value.python, packages };
  } catch {
    return null;
  }
}
