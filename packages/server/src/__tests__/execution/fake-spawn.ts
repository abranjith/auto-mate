// Shared test support: a scripted stand-in for `child_process.spawn`. Not a
// test file, so importing it registers no `describe` blocks.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnFn, SpawnOptionsLike, SpawnedProcess } from '../../execution/process-runner';

/** How one fake process behaves. */
export interface FakeBehavior {
  readonly stdout?: string | readonly Buffer[];
  readonly stderr?: string;
  readonly exitCode?: number | null;
  /** Emit `error` instead of running, as a missing executable does. */
  readonly error?: Error;
  /** Stay alive until killed. */
  readonly hang?: boolean;
}
export interface FakeSpawnCall { readonly command: string; readonly args: readonly string[]; readonly options: SpawnOptionsLike; readonly pid: number }

class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private closed = false;
  constructor(readonly pid: number) { super(); }
  close(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

/**
 * Build a fake spawn whose processes follow `behave`.
 *
 * @param behave Decides each spawned process's behavior from its command line.
 * @returns The spawn function, every call it received, and a `kill` that ends a hanging process as a tree kill would.
 */
export function fakeSpawn(behave: (command: string, args: readonly string[]) => FakeBehavior = () => ({ exitCode: 0 })) {
  const calls: FakeSpawnCall[] = [];
  const children = new Map<number, FakeChild>();
  let nextPid = 4000;
  const kill = (pid: number) => children.get(pid)?.close(null);
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    calls.push({ command, args, options, pid: child.pid });
    if (command === 'taskkill') { kill(Number(args[1])); child.close(0); return child; }
    const behavior = behave(command, args);
    setImmediate(() => {
      if (behavior.error) { child.emit('error', behavior.error); return; }
      const chunks = typeof behavior.stdout === 'string' ? [Buffer.from(behavior.stdout)] : behavior.stdout ?? [];
      for (const chunk of chunks) child.stdout.write(chunk);
      if (behavior.stderr) child.stderr.write(behavior.stderr);
      if (!behavior.hang) child.close(behavior.exitCode ?? 0);
    });
    return child;
  };
  return { spawn, calls, kill };
}
