// This function is an allowlist. A line it does not recognize is dropped,
// never forwarded; adding a pass-through branch defeats the feature.

import { MAX_DIAGNOSTIC_BYTES, MAX_DIAGNOSTIC_FRAMES } from './limits';

export interface DiagnosticFrame { readonly file: string; readonly line: number; readonly function: string }
export interface DiagnosticCheck { readonly path: string; readonly line: number; readonly col: number; readonly code: string; readonly message: string }
export interface FilteredDiagnostic {
  readonly exceptionType: string | null;
  readonly message: string | null;
  readonly frames: readonly DiagnosticFrame[];
  readonly libraries: readonly string[];
  readonly checks: readonly DiagnosticCheck[];
  readonly testFailures: readonly string[];
  readonly droppedLineCount: number;
  readonly keptLineCount: number;
  readonly maskedLiteralCount: number;
  readonly truncated: boolean;
  readonly text: string;
}
export interface DiagnosticFilterOptions { readonly maxBytes?: number; readonly maxFrames?: number }

function basename(path: string): string { return path.split(/[\\/]/).pop() ?? path; }
function maskMessage(message: string): { text: string; count: number } {
  let count = 0;
  let quoted = '';
  let cursor = 0;
  while (cursor < message.length) {
    const rest = message.slice(cursor);
    const single = rest.indexOf("'");
    const double = rest.indexOf('"');
    const relative = single < 0 ? double : double < 0 ? single : Math.min(single, double);
    if (relative < 0) { quoted += rest; break; }
    const start = cursor + relative;
    const quote = message[start]!;
    let end = start + 1;
    while (end < message.length) {
      const next = message.indexOf(quote, end);
      if (next < 0) { end = -1; break; }
      const escaped = message[next - 1] === '\\';
      const followedByWord = /[\p{L}\p{N}_]/u.test(message[next + 1] ?? '');
      if (!escaped && !followedByWord) { end = next; break; }
      end = next + 1;
    }
    if (end < 0 || end >= message.length) { quoted += rest; break; }
    const logical = message.slice(start + 1, end).replace(/\\(['"\\])/g, '$1');
    quoted += `${message.slice(cursor, start)}<str len=${[...logical].length}>`;
    count += 1;
    cursor = end + 1;
  }
  return { text: quoted.replace(/\d{5,}/g, () => { count += 1; return '<num>'; }), count };
}
function selectFrames(frames: readonly DiagnosticFrame[], maximum: number): { values: DiagnosticFrame[]; truncated: boolean } {
  if (frames.length <= maximum) return { values: [...frames], truncated: false };
  const outer = Math.ceil(maximum / 2);
  return { values: [...frames.slice(0, outer), ...frames.slice(-(maximum - outer))], truncated: true };
}

/**
 * Keep only recognized diagnostic structure and mask literals in messages.
 *
 * @param raw Untrusted process output.
 * @param options Optional test caps; production uses D04 defaults.
 * @returns A bounded structured diagnostic and the exact prompt text.
 * @example filterDiagnostics("ValueError: bad value 'secret'").text
 */
export function filterDiagnostics(raw: string, options: DiagnosticFilterOptions = {}): FilteredDiagnostic {
  const frames: DiagnosticFrame[] = [];
  const checks: DiagnosticCheck[] = [];
  const testFailures: string[] = [];
  const headers: string[] = [];
  const terminals: string[] = [];
  let exceptionType: string | null = null;
  let message: string | null = null;
  let droppedLineCount = 0;
  let keptLineCount = 0;
  let maskedLiteralCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' && raw === '') continue;
    if (/^(Traceback \(most recent call last\):|During handling of the above exception|The above exception was the direct cause)/.test(line)) { headers.push(line); keptLineCount += 1; continue; }
    const frame = /^\s*File ["'](.+)["'], line (\d+)(?:, in (.+))?$/.exec(line);
    if (frame) { frames.push({ file: basename(frame[1]!), line: Number(frame[2]), function: frame[3] ?? '<module>' }); keptLineCount += 1; continue; }
    const check = /^(.+?):(\d+):(\d+):\s+([A-Z][A-Z0-9_-]+)\s+(.+)$/.exec(line);
    if (check) { const masked = maskMessage(check[5]!); maskedLiteralCount += masked.count; checks.push({ path: basename(check[1]!), line: Number(check[2]), col: Number(check[3]), code: check[4]!, message: masked.text }); keptLineCount += 1; continue; }
    const failure = /^FAILED\s+(.+?)::(.+?)(?:\s+-\s+([A-Za-z_][\w.]*)\s*:\s*(.*))?$/.exec(line);
    if (failure) { const masked = maskMessage(failure[4] ?? ''); maskedLiteralCount += masked.count; testFailures.push(`FAILED ${basename(failure[1]!)}::${failure[2]}${failure[3] ? ` - ${failure[3]}: ${masked.text}` : ''}`); keptLineCount += 1; continue; }
    const terminal = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt|Exit|Failure))\s*:\s*(.*)$/.exec(line);
    if (terminal) { const masked = maskMessage(terminal[2]!); exceptionType = terminal[1]!; message = masked.text; terminals.push(`${terminal[1]}: ${masked.text}`); maskedLiteralCount += masked.count; keptLineCount += 1; continue; }
    droppedLineCount += 1;
  }
  const selected = selectFrames(frames, options.maxFrames ?? MAX_DIAGNOSTIC_FRAMES);
  const libraries = [...new Set(selected.values.map((frame) => frame.file.split('.')[0]!).filter(Boolean))];
  const rendered = [
    ...headers,
    ...selected.values.map((frame) => `File "${frame.file}", line ${frame.line}, in ${frame.function}`),
    ...terminals,
    ...checks.map((item) => `${item.path}:${item.line}:${item.col}: ${item.code} ${item.message}`),
    ...testFailures,
  ];
  const maximum = options.maxBytes ?? MAX_DIAGNOSTIC_BYTES;
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  let byteTruncated = false;
  for (const line of rendered) { const extra = encoder.encode(`${kept.length ? '\n' : ''}${line}`).byteLength; if (bytes + extra > maximum) { byteTruncated = true; break; } kept.push(line); bytes += extra; }
  return { exceptionType, message, frames: selected.values, libraries, checks, testFailures, droppedLineCount, keptLineCount, maskedLiteralCount, truncated: selected.truncated || byteTruncated, text: kept.join('\n') };
}
