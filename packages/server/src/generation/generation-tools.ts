import type { AgentToolDefinition } from '@automate/core';
import { createFinalizeScriptTool, type FinalizeScriptToolDependencies } from './tools/finalize-script-tool';
import { createRunTestsTool, type RunTestsToolDependencies } from './tools/run-tests-tool';
import { createWriteScriptTool } from './tools/write-script-tool';
import { createWriteTestTool } from './tools/write-test-tool';

export type GenerationToolsDependencies = RunTestsToolDependencies & FinalizeScriptToolDependencies & { readonly maxScriptBytes?: number };

/** The four application-owned generation tools, built once and shared by every run. */
export class GenerationTools {
  readonly writeScript: AgentToolDefinition;
  readonly writeTest: AgentToolDefinition;
  readonly runTests: AgentToolDefinition;
  readonly finalizeScript: AgentToolDefinition;

  constructor(deps: GenerationToolsDependencies) {
    this.writeScript = createWriteScriptTool(deps, deps.maxScriptBytes) as AgentToolDefinition;
    this.writeTest = createWriteTestTool(deps, deps.maxScriptBytes) as AgentToolDefinition;
    this.runTests = createRunTestsTool(deps) as AgentToolDefinition;
    this.finalizeScript = createFinalizeScriptTool(deps) as AgentToolDefinition;
  }

  /** In registration order. With `request_clarification`, exactly five tools reach the provider. */
  all(): readonly AgentToolDefinition[] {
    return [this.writeScript, this.writeTest, this.runTests, this.finalizeScript];
  }
}
