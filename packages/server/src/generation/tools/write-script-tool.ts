import { MAX_SCRIPT_BYTES, WriteScriptArgsSchema, type AgentToolDefinition } from '@automate/core';
import { writeFile, type GenerationToolDependencies } from './tool-context';

/**
 * `write_script`: store one Python source file of the current attempt.
 *
 * The file lands in the database as part of the execution's draft and is
 * written to disk by the application only when the draft is sealed. The
 * transcript records that a file was written and its size; `code_file` holds
 * the one authoritative copy of the bytes (`redactArgsInEvents: ['content']`).
 *
 * @param deps The code workspace and version repository.
 * @param maxScriptBytes The per-file cap named in the description.
 * @returns The SDK-free tool definition.
 */
export function createWriteScriptTool(deps: GenerationToolDependencies, maxScriptBytes = MAX_SCRIPT_BYTES): AgentToolDefinition<typeof WriteScriptArgsSchema> {
  return {
    name: 'write_script',
    description: `Store a Python source file for the current attempt, such as \`main.py\` or \`lib/helpers.py\`. The path is relative, uses forward slashes, is at most two levels deep, ends in \`.py\`, and must not be named like a test (\`test_*.py\`, \`*_test.py\`) or live under \`output/\`. Each file may be at most ${maxScriptBytes.toLocaleString('en-US')} bytes. Files are stored and versioned by the application, not written to a shared directory; writing the same path again replaces it within this attempt. Returns the stored path, size, line count, and attempt number — not the content.`,
    parameters: WriteScriptArgsSchema,
    redactArgsInEvents: ['content'],
    execute: async (args, context) => writeFile(deps, context, 'script', args),
  };
}
