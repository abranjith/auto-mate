// ---------------------------------------------------------------------------
// The artifact type policy (FEAT-109 TASK-001, D12).
//
// This module is THE single source for what an artifact type is, which file
// extensions it may carry, which MIME type the application serves it as, and
// how it is shown. The server's registrar derives every stored `extension`,
// `mime_type`, and `render_mode` from here; the client never re-decides any of
// them. Nothing is ever sniffed from content, and the manifest's own word for
// a MIME type is never read.
//
// The nine types themselves are memory's manifest artifact model and are
// defined once, in `contracts/generation-api.ts`, where FEAT-107's
// `contract_outputs` check already enforces them. This module re-exports that
// list rather than typing it a second time.
//
// Browser-safe: no Node built-ins.
// ---------------------------------------------------------------------------

import { ARTIFACT_TYPES, type ArtifactType } from '../contracts/generation-api';

export { ARTIFACT_TYPES };
export type { ArtifactType };

/** How the client shows an artifact. Stored per row so the server and the client cannot disagree. */
export const RENDER_MODES = ['table', 'image', 'markdown', 'text', 'sandboxed_html', 'sandboxed_pdf', 'download_only'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** One type's posture: its extension allowlist (lowercase, with the dot), the MIME type for each, and its renderer. */
export interface ArtifactTypePolicy {
  readonly extensions: readonly string[];
  readonly mimeTypes: Readonly<Record<string, string>>;
  readonly renderMode: RenderMode;
  /** Whether `GET /api/artifacts/:id/preview` (the capped text head) applies. Tables page through `/rows` instead. */
  readonly previewable: boolean;
}

const HTML_MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8' } as const;

/**
 * Every type's policy. Frozen: a new type is a deliberate edit here, in the
 * shared type list, and in the tests that pin both.
 *
 * `image` admits png, jpeg, webp, and gif and deliberately NOT svg: an SVG is
 * a document that can carry script, and nothing in `SCRIPT_DEPENDENCY_SET`
 * needs to produce one. The omission is a decision, not an oversight.
 */
export const ARTIFACT_TYPE_POLICY: Readonly<Record<ArtifactType, ArtifactTypePolicy>> = Object.freeze({
  csv: { extensions: ['.csv'], mimeTypes: { '.csv': 'text/csv; charset=utf-8' }, renderMode: 'table', previewable: false },
  xlsx: { extensions: ['.xlsx'], mimeTypes: { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, renderMode: 'table', previewable: false },
  json: { extensions: ['.json'], mimeTypes: { '.json': 'application/json; charset=utf-8' }, renderMode: 'text', previewable: true },
  text: { extensions: ['.txt', '.log'], mimeTypes: { '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' }, renderMode: 'text', previewable: true },
  markdown: { extensions: ['.md', '.markdown'], mimeTypes: { '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8' }, renderMode: 'markdown', previewable: true },
  html: { extensions: ['.html', '.htm'], mimeTypes: HTML_MIME, renderMode: 'sandboxed_html', previewable: false },
  'plotly-html': { extensions: ['.html', '.htm'], mimeTypes: HTML_MIME, renderMode: 'sandboxed_html', previewable: false },
  image: { extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif'], mimeTypes: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }, renderMode: 'image', previewable: false },
  pdf: { extensions: ['.pdf'], mimeTypes: { '.pdf': 'application/pdf' }, renderMode: 'sandboxed_pdf', previewable: false },
});

/**
 * The type an UNDECLARED file is registered as, by extension. `html` rather
 * than `plotly-html` for an HTML file nobody described: the two render
 * identically, and claiming "Plotly" for an unlabelled file would be a guess.
 */
const INFERRED_TYPE: Readonly<Record<string, ArtifactType>> = Object.freeze(
  Object.fromEntries((['csv', 'xlsx', 'json', 'text', 'markdown', 'html', 'image', 'pdf'] as const).flatMap((type) => ARTIFACT_TYPE_POLICY[type].extensions.map((extension) => [extension, type]))),
);

/** Why a file cannot become an artifact. */
export type ArtifactTypeRefusal = 'unknown_type' | 'no_extension' | 'extension_not_allowed';

/** A resolved type and the lowercase extension (with its dot) the stored file will carry, or a typed refusal. */
export type ArtifactTypeResolution =
  | { readonly ok: true; readonly type: ArtifactType; readonly extension: string }
  | { readonly ok: false; readonly reason: ArtifactTypeRefusal };

/**
 * The lowercase extension of a model-authored filename, with its dot, following `path.extname`:
 * a name that is only a leading dot (`.csv`) has none.
 *
 * @param filename A display name; never treated as a path.
 * @returns For example `.csv`, or an empty string.
 * @example extensionOf('Report.CSV') // '.csv'
 */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Whether a string is one of the nine artifact types.
 *
 * @param value Any string, for example a manifest's `type`.
 * @returns True for a member of `ARTIFACT_TYPES`.
 * @example isArtifactType('plotly-html') // true
 */
export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/**
 * Resolve a file's artifact type against the policy.
 *
 * A declared type is accepted only when the file's extension is in that type's
 * allowlist; an undeclared file (`declaredType` null) is typed by extension.
 *
 * @param declaredType The manifest's type, or null for a file nobody declared.
 * @param filename The model-authored filename; only its extension is read.
 * @returns The type and extension, or why the file cannot register.
 * @example resolveArtifactType('csv', 'summary.csv') // { ok: true, type: 'csv', extension: '.csv' }
 * @example resolveArtifactType('image', 'payload.svg') // { ok: false, reason: 'extension_not_allowed' }
 */
export function resolveArtifactType(declaredType: string | null, filename: string): ArtifactTypeResolution {
  if (declaredType !== null && !isArtifactType(declaredType)) return { ok: false, reason: 'unknown_type' };
  const extension = extensionOf(filename);
  if (!extension) return { ok: false, reason: 'no_extension' };
  if (declaredType === null) {
    const inferred = INFERRED_TYPE[extension];
    return inferred ? { ok: true, type: inferred, extension } : { ok: false, reason: 'extension_not_allowed' };
  }
  return ARTIFACT_TYPE_POLICY[declaredType].extensions.includes(extension) ? { ok: true, type: declaredType, extension } : { ok: false, reason: 'extension_not_allowed' };
}

function policyFor(type: ArtifactType, extension: string): ArtifactTypePolicy {
  const policy = ARTIFACT_TYPE_POLICY[type];
  if (!policy || !policy.extensions.includes(extension)) throw new RangeError(`"${extension}" is not an allowed extension for artifact type "${type}".`);
  return policy;
}

/**
 * The MIME type the application serves a stored artifact as.
 *
 * @param type The artifact's type.
 * @param extension The stored extension, lowercase with its dot.
 * @returns The one MIME type the policy lists for that pair.
 * @throws RangeError for a pair outside the policy.
 * @example mimeTypeFor('image', '.png') // 'image/png'
 */
export function mimeTypeFor(type: ArtifactType, extension: string): string {
  return policyFor(type, extension).mimeTypes[extension]!;
}

/**
 * How a stored artifact is shown.
 *
 * @param type The artifact's type.
 * @param extension The stored extension, lowercase with its dot.
 * @returns The renderer the client must use.
 * @throws RangeError for a pair outside the policy.
 * @example renderModeFor('plotly-html', '.html') // 'sandboxed_html'
 */
export function renderModeFor(type: ArtifactType, extension: string): RenderMode {
  return policyFor(type, extension).renderMode;
}
