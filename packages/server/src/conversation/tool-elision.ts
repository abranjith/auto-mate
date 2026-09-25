import { utf8ByteLength, type AgentToolDefinition } from '@automate/core';

/** What replaces an elided argument in the transcript. */
export interface ElidedArgument { readonly elided: true; readonly byteSize: number }

/**
 * Index the argument keys each tool asks to keep out of the transcript.
 *
 * @param tools The run's registered tools.
 * @returns Tool name to the keys it elides; tools that elide nothing are absent.
 */
export function redactionsFor(tools: readonly AgentToolDefinition[]): ReadonlyMap<string, readonly string[]> {
  return new Map(tools.flatMap((tool) => (tool.redactArgsInEvents?.length ? [[tool.name, tool.redactArgsInEvents] as const] : [])));
}

/**
 * Replace named argument keys with their size, for the persisted and broadcast `tool_started` event only.
 * The tool's `execute()` has already received — or will receive — the full arguments; this never touches them.
 *
 * @param input The tool input as the provider reported it.
 * @param keys Keys to elide; a key that is absent is a no-op.
 * @returns A shallow copy with each present key replaced by `{ elided: true, byteSize }`, or the input unchanged when it is not an object.
 * @example elideToolInput({ path: 'main.py', content: 'print(1)' }, ['content']) // { path: 'main.py', content: { elided: true, byteSize: 8 } }
 */
export function elideToolInput(input: unknown, keys: readonly string[]): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || keys.length === 0) return input;
  const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of keys) {
    if (!(key in copy)) continue;
    const value = copy[key];
    const elided: ElidedArgument = { elided: true, byteSize: utf8ByteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '') };
    copy[key] = elided;
  }
  return copy;
}
