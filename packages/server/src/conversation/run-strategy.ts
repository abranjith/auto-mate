import type { AgentToolDefinition, UnnumberedConversationEvent } from '@automate/core';
import type { ExecutionRow } from '../db/repositories/execution-repository';
import type { TaskRow } from '../db/repositories/task-repository';

/** Prompt/tool projection replaced by FEAT-106 without changing session orchestration. */
export interface RunStrategy {
  buildRun(task: TaskRow, execution: ExecutionRow): {
    prompt: string;
    systemPrompt?: string;
    customTools: readonly AgentToolDefinition[];
    events?: readonly UnnumberedConversationEvent[];
  };
}

/** Send only the words the person typed and register no custom tools. */
export class PassthroughRunStrategy implements RunStrategy {
  buildRun(task: TaskRow): { prompt: string; customTools: readonly AgentToolDefinition[] } {
    return { prompt: task.description, customTools: [] };
  }
}
