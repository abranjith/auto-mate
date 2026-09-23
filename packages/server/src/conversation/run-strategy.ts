import type { TaskRow } from '../db/repositories/task-repository';

/** Prompt/tool projection replaced by FEAT-106 without changing session orchestration. */
export interface RunStrategy {
  buildRun(task: TaskRow): {
    prompt: string;
    systemPrompt?: string;
    customTools: readonly unknown[];
  };
}

/** Send only the words the person typed and register no custom tools. */
export class PassthroughRunStrategy implements RunStrategy {
  buildRun(task: TaskRow): { prompt: string; customTools: readonly unknown[] } {
    return { prompt: task.description, customTools: [] };
  }
}
