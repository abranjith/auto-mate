import { MAX_SCRIPT_BYTES, WriteTestArgsSchema, type AgentToolDefinition } from '@automate/core';
import { writeFile, type GenerationToolDependencies } from './tool-context';

/**
 * `write_test`: store one pytest file of the current attempt.
 *
 * Same storage rules as `write_script`; the name must be `test_<name>.py` or
 * `<name>_test.py` so pytest collects it, and scripts may not use that shape.
 *
 * @param deps The code workspace and version repository.
 * @param maxScriptBytes The per-file cap named in the description.
 * @returns The SDK-free tool definition.
 */
export function createWriteTestTool(deps: GenerationToolDependencies, maxScriptBytes = MAX_SCRIPT_BYTES): AgentToolDefinition<typeof WriteTestArgsSchema> {
  return {
    name: 'write_test',
    description: `Store a pytest test file for the current attempt. Name it \`test_<name>.py\` or \`<name>_test.py\` (for example \`test_main.py\`); the path is relative, uses forward slashes, and is at most two levels deep. Each file may be at most ${maxScriptBytes.toLocaleString('en-US')} bytes. Tests run against synthetic data in $AUTOMATE_INPUT_DIR shaped like the person's file, never the file itself. Returns the stored path, size, line count, and attempt number — not the content.`,
    parameters: WriteTestArgsSchema,
    redactArgsInEvents: ['content'],
    execute: async (args, context) => writeFile(deps, context, 'test', args),
  };
}
