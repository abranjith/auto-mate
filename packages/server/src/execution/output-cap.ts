// Head-and-tail truncation of captured process output (FEAT-107). The start
// of output says what a script began doing and the end says how it finished;
// the middle is what goes. Truncation is always reported, never silent.
//
// The text passing through here is RAW, UNTRUSTED output from generated code
// and — for a real run — may contain the person's cell values. This module
// only measures and cuts it; it never logs it.

/** The marker placed where bytes were removed. */
export const TRUNCATION_MARKER = '\n…[output truncated]…\n';

/**
 * Keep at most `maxBytes` UTF-8 bytes of `text`: half from the start, half from the end.
 *
 * @param text Captured output.
 * @param maxBytes Byte budget for the kept text, excluding the marker.
 * @returns The kept text and whether anything was cut. Never splits a character.
 * @example capHeadTail('abcdef', 4) // { text: 'ab\n…[output truncated]…\nef', truncated: true }
 */
export function capHeadTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const head = bytes.subarray(0, half).toString('utf8').replace(/�$/, '');
  const tail = bytes.subarray(bytes.length - half).toString('utf8').replace(/^�/, '');
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
}
