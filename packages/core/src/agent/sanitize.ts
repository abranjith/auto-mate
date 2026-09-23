// ---------------------------------------------------------------------------
// Boundary sanitizer for payloads crossing the agent seam (FEAT-102 TASK-002).
//
// Scope: this governs what crosses the seam OUTWARD (provider SDK -> the
// application, its logs, and the browser). Deciding what user data may be sent
// INWARD (application -> model) is FEAT-105's disclosure policy. Neither
// substitutes for the other.
//
// Honest limits: only the exact-match scrub is a guarantee. The shape-based
// pass is a heuristic — a credential split across two streamed deltas, or one
// with no recognizable shape, can slip through it. Describe it as a heuristic
// everywhere it is documented.
//
// The module is pure: no Node built-ins, no I/O, deterministic. `packages/web`
// imports it, so it must stay browser-safe.
// ---------------------------------------------------------------------------

const REDACTED = '[redacted]';

/** Default cap on a single sanitized text value, in characters. */
const DEFAULT_MAX_TEXT_LENGTH = 32 * 1024;

/** Shape-based credential patterns. Heuristics — never a guarantee. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:authorization|x-api-key|api[_-]?key|access[_-]?token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
];

/**
 * Absolute paths in POSIX (`/usr/x`) and Windows (`C:\Users\x`) form, including
 * JSON-escaped separators. The lookbehind keeps the pass idempotent (`~/x` is
 * already scrubbed) and keeps relative paths (`data/input.csv`) intact.
 */
const ABSOLUTE_PATH = /(?<![~\w])(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'<>|*?]+)/g;

/** Options for {@link createSanitizer}. */
export interface SanitizerOptions {
  /** Resolved secret values the server currently holds. The only hard guarantee. */
  readonly knownSecrets?: readonly string[];
  /** Home directory to collapse to `~`. */
  readonly homeDir?: string;
  /** Workspace directory whose paths stay intact. */
  readonly workspaceDir?: string;
  /** Character cap before truncation. Defaults to 32 KiB. */
  readonly maxTextLength?: number;
}

/** The two sanitizing functions every payload crossing the seam passes through. */
export interface Sanitizer {
  /** Sanitize a text fragment. @param text Untrusted text. @returns Redacted, path-scrubbed, size-capped text. @example sanitizeText('the key is sk-ant-0123456789abcdef') */
  sanitizeText(text: string): string;
  /** Sanitize a structured payload. @param payload Untrusted value of any shape. @returns The sanitized value, re-parsed as JSON when redaction left it valid, otherwise sanitized text. @example sanitizePayload({ headers: { authorization: 'Bearer abc' } }) */
  sanitizePayload(payload: unknown): unknown;
}

/** Replace every occurrence of a known secret. This pass is the only hard guarantee. */
function scrubKnownSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => current.split(secret).join(REDACTED), text);
}

/** Replace substrings that look like credentials. Heuristic by construction. */
function scrubCredentialShapes(text: string): string {
  return CREDENTIAL_SHAPES.reduce((current, pattern) => current.replace(pattern, REDACTED), text);
}

/** Collapse every separator run to `/` so one directory has one spelling. */
function toForwardSlashes(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
}

/** Normalize separators and case so two spellings of one directory compare equal. */
function normalizePath(value: string): string {
  return toForwardSlashes(value).toLowerCase();
}

/**
 * Collapse the home directory to `~` and replace every other path outside the
 * workspace, so neither the UI nor the log leaks the developer's directory
 * layout. Paths inside the workspace are left intact — they are the subject of
 * the work, not incidental host detail.
 */
function scrubPaths(text: string, homeDir: string | undefined, workspaceDir: string | undefined): string {
  const home = homeDir ? normalizePath(homeDir) : undefined;
  const workspace = workspaceDir ? normalizePath(workspaceDir) : undefined;
  if (home === undefined && workspace === undefined) return text;
  return text.replace(ABSOLUTE_PATH, (match) => {
    const forward = toForwardSlashes(match);
    const normalized = forward.toLowerCase();
    if (workspace !== undefined && (normalized === workspace || normalized.startsWith(`${workspace}/`))) return match;
    if (home !== undefined && (normalized === home || normalized.startsWith(`${home}/`))) return `~${forward.slice(home.length)}`;
    return '<path>';
  });
}

/** Cap a value's length with an explicit, countable marker. */
function truncate(text: string, maxTextLength: number): string {
  if (text.length <= maxTextLength) return text;
  return `${text.slice(0, maxTextLength)}… [truncated ${text.length - maxTextLength} characters]`;
}

/** Serialize any value to text without throwing on cycles or unserializable members. */
function stringify(payload: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(payload, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function') return '[function]';
      return value;
    });
    return serialized ?? String(payload);
  } catch {
    return String(payload);
  }
}

/**
 * Build the sanitizer used wherever a provider payload crosses the seam.
 *
 * Four passes run in order: exact-match scrub of the known secrets, shape-based
 * redaction, path scrubbing, then bounded truncation.
 *
 * @param options Known secrets, the home and workspace directories, and the size cap.
 * @returns A deterministic `{ sanitizeText, sanitizePayload }` pair that performs no I/O.
 * @example createSanitizer({ knownSecrets: [resolvedKey], homeDir, workspaceDir }).sanitizeText(toolOutput)
 */
export function createSanitizer(options: SanitizerOptions = {}): Sanitizer {
  const secrets = (options.knownSecrets ?? []).filter((secret) => typeof secret === 'string' && secret.length > 0);
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

  const sanitizeText = (text: string): string => {
    if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
    const scrubbed = scrubCredentialShapes(scrubKnownSecrets(text, secrets));
    return truncate(scrubPaths(scrubbed, options.homeDir, options.workspaceDir), maxTextLength);
  };

  const sanitizePayload = (payload: unknown): unknown => {
    if (payload === undefined || payload === null) return payload;
    if (typeof payload === 'string') return sanitizeText(payload);
    const sanitized = sanitizeText(stringify(payload));
    try {
      return JSON.parse(sanitized) as unknown;
    } catch {
      // Redaction or truncation broke JSON validity: emit sanitized text
      // instead. Consumers treat the value as `unknown` either way.
      return sanitized;
    }
  };

  return { sanitizeText, sanitizePayload };
}
