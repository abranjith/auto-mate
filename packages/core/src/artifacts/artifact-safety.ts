// ---------------------------------------------------------------------------
// Artifact safety constants (FEAT-109 TASK-001, D12).
//
// Generated HTML is model-written code. It renders in an
// `<iframe sandbox="allow-scripts">` — deliberately WITHOUT the same-origin
// sandbox token (whose literal name a grep keeps out of this package) — over
// bytes served with `ARTIFACT_CSP`. The opaque origin closes access to
// this application's DOM, storage, and cookies; `default-src 'none'` with no
// `connect-src`, no remote `img-src`, and no form target closes exfiltration;
// the `sandbox` directive repeated in the header makes the URL opened directly
// in a tab as restricted as the frame. `'unsafe-eval'` is absent on purpose:
// adding it is a decision for a person, not a quiet edit.
//
// That is a guarantee about the BROWSER. It says nothing about the Python that
// wrote the report, which ran unisolated with this application's access (D03).
//
// `describeArtifactSafety` is the ONLY place the preview caveat is worded —
// the same protection FEAT-108 gave `describeRuntimeCapabilities`. Tests
// assert the UI renders it verbatim, so softening it is a visible edit here.
//
// Browser-safe: no Node built-ins.
// ---------------------------------------------------------------------------

import type { RenderMode } from './artifact-type';

/** The Content-Security-Policy sent with every artifact byte response. Defined once; tests compare against it by equality. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts',
].join('; ');

/** The iframe `sandbox` attribute: scripts may run, and nothing else is granted. */
export const SANDBOX_ATTRIBUTE = 'allow-scripts';

/** Leading characters a spreadsheet treats as the start of a formula (OWASP CSV-injection list). */
export const FORMULA_PREFIXES: readonly string[] = Object.freeze(['=', '+', '-', '@', '\t', '\r']);

/**
 * Whether a cell starts with a formula prefix. A plain negative number (`-5`)
 * counts: that is a known false positive, counted and never corrected.
 *
 * @param cell The cell's text.
 * @returns True when a spreadsheet may treat the cell as a formula.
 * @example hasFormulaPrefix('=SUM(A1:A3)') // true
 */
export function hasFormulaPrefix(cell: string): boolean {
  return cell.length > 0 && FORMULA_PREFIXES.includes(cell[0]!);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const MAX_DOWNLOAD_NAME = 200;

function capLength(name: string): string {
  const chars = [...name];
  if (chars.length <= MAX_DOWNLOAD_NAME) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  return chars.slice(0, MAX_DOWNLOAD_NAME - [...extension].length).join('') + extension;
}

/**
 * Make a model-authored filename safe to hand to a browser or a ZIP entry.
 *
 * Keeps only the last path segment, strips control characters (NUL, CR, LF),
 * replaces characters Windows or a header would misread, collapses `..`,
 * strips leading dots and spaces, and prefixes Windows reserved device names.
 * Unicode is kept; `buildContentDisposition` supplies the RFC 5987 form.
 *
 * @param name The artifact's display filename.
 * @returns A plain name with no separator and no `..`; `download` when nothing is left.
 * @example sanitizeDownloadFilename('../../etc/passwd') // 'passwd'
 */
export function sanitizeDownloadFilename(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const cleaned = [...last]
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/["*:<>?|;]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!cleaned) return 'download';
  return capLength(WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned);
}

/** RFC 5987 `ext-value` encoding: percent-encode everything outside `attr-char`. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build a `Content-Disposition` header value for an artifact.
 *
 * @param disposition `inline` for the content route, `attachment` for downloads.
 * @param filename The artifact's display filename (model-authored; sanitized here).
 * @returns An ASCII `filename` fallback plus the `filename*=UTF-8''` form, with nothing a header parser could split on.
 * @example buildContentDisposition('attachment', 'résumé.csv') // `attachment; filename="r_sum_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`
 */
export function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const safe = sanitizeDownloadFilename(filename);
  const ascii = [...safe].map((char) => (char.charCodeAt(0) > 0x7e ? '_' : char)).join('').replace(/[\\"]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}

const SAFETY_WORDING: Readonly<Record<RenderMode, readonly string[]>> = Object.freeze({
  sandboxed_html: [
    'The AI wrote this report, and it may run its own scripts in your browser.',
    'It is shown in a sealed frame: it cannot read or change the rest of this app, and it cannot send anything over the network.',
    'That protection covers showing the report only. The Python script that made it ran on your computer with this app\'s access.',
  ],
  sandboxed_pdf: [
    'The AI\'s script produced this PDF.',
    'It is shown in a sealed frame that cannot reach the rest of this app or the network. If your browser will not show a PDF there, download it instead.',
  ],
  table: ['Cells are shown exactly as the file holds them, as plain text. Nothing in them is run.'],
  image: ['The picture is shown as an image. Nothing in it is run.'],
  markdown: ['The text is formatted without running anything; any HTML in it is shown as text.'],
  text: ['The file is shown as plain text. Nothing in it is run.'],
  download_only: ['This file is not shown in the app. Download it to open it.'],
});

/**
 * The caveat shown above an artifact's preview. THE ONLY place it is worded.
 *
 * @param renderMode How the artifact is shown.
 * @returns Sentences to render verbatim, in order.
 * @example describeArtifactSafety('sandboxed_html')[0] // 'The AI wrote this report, …'
 */
export function describeArtifactSafety(renderMode: RenderMode): string[] {
  return [...SAFETY_WORDING[renderMode]];
}
