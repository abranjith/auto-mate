import {
  SCRIPT_MAX_OUTPUT_FILES,
  SCRIPT_MAX_OUTPUT_TOTAL_BYTES,
  SCRIPT_MEMORY_LIMIT_BYTES,
  SCRIPT_RUN_TIMEOUT_MS,
} from './runtime-limits';

export const RUNTIME_KINDS = ['script', 'verify'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];
export const RUNTIME_STATUSES = ['preparing', 'ready', 'failed', 'aborted'] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];
export const LIMIT_BREACHES = ['time', 'memory', 'output_bytes', 'output_files'] as const;
export type LimitBreach = (typeof LIMIT_BREACHES)[number];

export interface RuntimeEnvironmentView {
  readonly kind: RuntimeKind;
  readonly status: RuntimeStatus;
  readonly pythonVersion: string;
  readonly uvVersion: string;
  readonly fingerprint: string | null;
  readonly lockDigest: string;
  readonly packageCount: number;
  readonly packages: readonly { readonly name: string; readonly version: string }[];
  readonly preparedAt: string | null;
  readonly failureReason: string | null;
}

export interface RuntimeReadiness {
  readonly ready: boolean;
  readonly environment: RuntimeEnvironmentView | null;
  readonly reason: string | null;
}

export interface RuntimeLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly maxOutputTotalBytes: number;
  readonly maxOutputFiles: number;
}

const DEFAULT_LIMITS: RuntimeLimits = {
  timeoutMs: SCRIPT_RUN_TIMEOUT_MS,
  memoryBytes: SCRIPT_MEMORY_LIMIT_BYTES,
  maxOutputTotalBytes: SCRIPT_MAX_OUTPUT_TOTAL_BYTES,
  maxOutputFiles: SCRIPT_MAX_OUTPUT_FILES,
};

function humanSize(bytes: number): string {
  if (bytes <= 0) return 'the configured limit';
  return bytes >= 1_073_741_824 ? `${Number((bytes / 1_073_741_824).toFixed(1))} GB` : `${Math.ceil(bytes / 1_048_576)} MB`;
}

/**
 * Describe why a run was stopped without exposing paths or raw byte counts.
 * @param breach The enforced limit that was exceeded.
 * @param limits Effective limits for this run.
 * @returns One sentence suitable for the API, transcript, and UI.
 * @example describeLimitBreach('time')
 */
export function describeLimitBreach(breach: LimitBreach, limits: RuntimeLimits = DEFAULT_LIMITS): string {
  switch (breach) {
    case 'time': return `This script ran for ${Math.ceil(limits.timeoutMs / 60_000)} minutes without finishing and was stopped.`;
    case 'memory': return `This script exceeded its ${humanSize(limits.memoryBytes)} memory limit and was stopped.`;
    case 'output_bytes': return `This script wrote more than ${humanSize(limits.maxOutputTotalBytes)} of output and was stopped.`;
    case 'output_files': return `This script wrote more than ${limits.maxOutputFiles} output files and was stopped.`;
  }
}

// This function is the only source for the platform statement, especially the Windows memory gap.
export const WINDOWS_MEMORY_CAPABILITY = 'No memory limit is enforced on Windows.';
export const POSIX_MEMORY_CAPABILITY = 'A memory limit is enforced with RLIMIT_AS on macOS and Linux.';

/**
 * Explain which limits the current host actually enforces.
 * @param platform Node platform name.
 * @returns Sentences to render verbatim in Settings and documentation.
 * @example describeRuntimeCapabilities('win32')
 */
export function describeRuntimeCapabilities(platform: string): string[] {
  return [
    'Wall-clock time and captured output are limited on every platform.',
    'Output directory bytes and file count are watched on every platform.',
    platform === 'win32' ? WINDOWS_MEMORY_CAPABILITY : POSIX_MEMORY_CAPABILITY,
    'Generated code runs with this application’s access and can read any file this application can read.',
  ];
}
