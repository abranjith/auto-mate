// ---------------------------------------------------------------------------
// Child processes for the Python runner (FEAT-106 TASK-004).
//
// Every spawn is `shell: false` with an application-built argument vector.
// `SpawnFn` is injected so no unit test ever starts a real process. A
// cancelled or timed-out run kills the WHOLE process tree — `taskkill /T /F`
// on Windows, a signal to the process group (`detached: true`) elsewhere —
// because a pytest that started a child must not outlive its cancel.
//
// Output is RAW and UNTRUSTED: it comes from generated code that runs with no
// isolation boundary. This module bounds it and never logs it.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { MAX_DIAGNOSTIC_BYTES, type LimitBreach } from '@automate/core';
import type { Logger } from 'pino';
import { watchOutput, type OutputWatchLimits } from './output-watchdog';

/** The slice of a child process this module uses; `ChildProcess` satisfies it. */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
}
export interface SpawnOptionsLike { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly detached: boolean; readonly windowsHide: true; readonly shell: false }
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptionsLike) => SpawnedProcess;

/** The real spawn. */
export const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, [...args], options);

/** Bytes of each stream kept by default: half from the start, half from the end. */
export const MAX_CAPTURE_BYTES = MAX_DIAGNOSTIC_BYTES * 8;

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly outputWatch?: { readonly dir: string; readonly limits: OutputWatchLimits };
}
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly droppedBytes: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError: Error | null;
  readonly durationMs: number;
  readonly limitBreached?: LimitBreach | null;
}
export interface ProcessRunnerOptions {
  readonly spawn?: SpawnFn;
  readonly platform?: NodeJS.Platform;
  /** Signals a POSIX process group; injectable so tests can observe it. */
  readonly killGroup?: (pid: number) => void;
  readonly maxCaptureBytes?: number;
  readonly clock?: () => number;
  /** Receives a warning when a tree kill fails; never any process output. */
  readonly logger?: Pick<Logger, 'warn'>;
}

/** Keeps the first and last halves of a stream and counts what fell between them. */
class BoundedCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail = Buffer.alloc(0);
  dropped = 0;
  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const headRoom = Math.max(0, Math.ceil(this.limit / 2) - this.headBytes);
    if (headRoom > 0) {
      const taken = chunk.subarray(0, headRoom);
      this.head.push(taken);
      this.headBytes += taken.length;
      chunk = chunk.subarray(taken.length);
    }
    if (chunk.length === 0) return;
    const tailLimit = Math.floor(this.limit / 2);
    const combined = Buffer.concat([this.tail, chunk]);
    this.dropped += Math.max(0, combined.length - tailLimit);
    this.tail = combined.subarray(Math.max(0, combined.length - tailLimit));
  }

  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    return this.dropped > 0 ? `${head}\n${this.tail.toString('utf8')}` : head + this.tail.toString('utf8');
  }
}

/** Runs one child process with a timeout, cancellation, bounded capture, and tree kill. */
export class ProcessRunner {
  private readonly spawnFn: SpawnFn;
  private readonly platform: NodeJS.Platform;
  private readonly killGroup: (pid: number) => void;
  private readonly clock: () => number;
  constructor(private readonly options: ProcessRunnerOptions = {}) {
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.platform = options.platform ?? process.platform;
    this.killGroup = options.killGroup ?? ((pid) => process.kill(-pid, 'SIGKILL'));
    this.clock = options.clock ?? (() => performance.now());
  }

  /** Run a command to completion. @param request Command, arguments, limits. @returns Exit code, bounded output, and how it ended; never rejects for a failing command. */
  run(request: ProcessRequest): Promise<ProcessResult> {
    const started = this.clock();
    const empty = { exitCode: null, stdout: '', stderr: '', droppedBytes: 0, timedOut: false, durationMs: 0, limitBreached: null };
    if (request.signal?.aborted) return Promise.resolve({ ...empty, aborted: true, spawnError: null });
    let child: SpawnedProcess;
    try {
      child = this.spawnFn(request.command, request.args, { cwd: request.cwd, env: request.env, detached: this.platform !== 'win32', windowsHide: true, shell: false });
    } catch (cause) {
      return Promise.resolve({ ...empty, aborted: false, spawnError: cause instanceof Error ? cause : new Error(String(cause)) });
    }
    return this.supervise(child, request, started);
  }

  private supervise(child: SpawnedProcess, request: ProcessRequest, started: number): Promise<ProcessResult> {
    const limit = this.options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
    const out = new BoundedCapture(limit);
    const err = new BoundedCapture(limit);
    child.stdout?.on('data', (chunk: Buffer) => out.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => err.push(Buffer.from(chunk)));
    return new Promise((resolve) => {
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let limitBreached: LimitBreach | null = null;
      let killed = false;
      const watcher = new AbortController();
      const kill = () => { if (killed || settled) return; killed = true; this.killTree(child); };
      const timer = setTimeout(() => { if (killed) return; timedOut = true; limitBreached = 'time'; kill(); }, request.timeoutMs);
      const onAbort = () => { if (killed) return; aborted = true; kill(); };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.outputWatch) void watchOutput(request.outputWatch.dir, request.outputWatch.limits, watcher.signal).then((breach) => { if (!breach || killed || settled) return; limitBreached = breach; kill(); }).catch((cause: unknown) => this.options.logger?.warn({ cause: cause instanceof Error ? cause.message : String(cause) }, 'output watch failed'));
      const finish = (exitCode: number | null, spawnError: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watcher.abort();
        request.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode, stdout: out.text(), stderr: err.text(), droppedBytes: out.dropped + err.dropped, timedOut, aborted, spawnError, limitBreached, durationMs: Math.max(0, Math.round(this.clock() - started)) });
      };
      child.once('error', (error) => finish(null, error));
      child.once('close', (code) => finish(code, null));
    });
  }

  /** Kill the process and everything it started. Best effort: a tree that already exited is not an error. */
  private killTree(child: SpawnedProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      if (this.platform === 'win32') {
        const killer = this.spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'], { detached: false, windowsHide: true, shell: false });
        killer.once('error', (cause) => this.options.logger?.warn({ pid, cause: cause.message }, 'process tree kill could not start'));
      } else this.killGroup(pid);
    } catch (cause) {
      // Usually the tree already exited; the close event still settles the run.
      this.options.logger?.warn({ pid, cause: cause instanceof Error ? cause.message : String(cause) }, 'process tree kill failed');
    }
  }
}
