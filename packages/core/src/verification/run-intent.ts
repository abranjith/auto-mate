// ---------------------------------------------------------------------------
// The run intent (FEAT-107 TASK-001/010).
//
// Everything the approval gate shows a person, as one object, and the digest
// an approval binds to. A person approves what they SAW: the server rebuilds
// this object when the decision arrives and rejects a digest that no longer
// matches, the same mechanism FEAT-105 uses for a disclosure payload.
//
// `RUN_INTENT_CAVEATS` is the ONLY place the gate's warnings exist. They are
// application-authored and must be rendered verbatim — tests compare strings,
// so softening a sentence in a component fails the build. None may describe
// anything here as a security boundary: this preview has none (D03).
// ---------------------------------------------------------------------------

import { canonicalStringify } from '../disclosure/canonical-json';
import { sha256Hex } from '../generation/sha256';
import type { ArtifactType } from '../contracts/generation-api';
import type { CheckKey, CheckStatus } from './verification';

/** The sentences the gate must display, in this order, verbatim. */
export const RUN_INTENT_CAVEATS = [
  'The checks and tests ran on synthetic rows shaped like your file, not on your file itself. Passing them is evidence about the code\'s shape, not proof it will work on your data.',
  'The script is handed a copy of your file, so the original is not the file it opens. The copy guards against a buggy script; it is not a security boundary.',
  'This preview runs generated code without an isolation boundary, with the same access this application has. Nothing here prevents it from reaching other files on this computer.',
] as const;

/** One input the script will read. `originalFilename` is a display label, never a path. */
export interface RunIntentInput {
  readonly uploadId: number;
  readonly originalFilename: string;
  readonly byteSize: number;
  readonly shortSha256: string;
  readonly sheets: readonly string[];
}

/** One output the script says it will write. Model output: untrusted, rendered as text. */
export interface RunIntentOutput {
  readonly filename: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly description: string;
}

/** One check as the gate shows it. */
export interface RunIntentCheck {
  readonly checkKey: CheckKey;
  readonly status: CheckStatus;
  readonly isBlocking: boolean;
  readonly summary: string;
}

/** Everything the gate displays. The digest of this exact object is what an approval binds to. */
export interface RunIntent {
  readonly executionId: number;
  readonly codeVersion: { readonly id: number; readonly shortDigest: string; readonly contentDigest: string; readonly fileCount: number; readonly lineCount: number; readonly entrypoint: string };
  readonly verificationRunId: number;
  /** The agent's own description. Model output: untrusted, rendered as text. */
  readonly summary: string | null;
  readonly inputs: readonly RunIntentInput[];
  readonly outputs: readonly RunIntentOutput[];
  readonly checks: readonly RunIntentCheck[];
  readonly verdict: string;
  readonly blockingCount: number;
  readonly advisoryCount: number;
  readonly tests: { readonly total: number | null; readonly passed: number | null; readonly fixtureRowCount: number | null };
  readonly runtime: { readonly fingerprint: string; readonly description: string; readonly packages: readonly { readonly name: string; readonly version: string }[] };
  readonly caveats: readonly string[];
}

/**
 * Digest the exact intent a person is shown.
 *
 * @param intent The intent object, as rendered.
 * @returns Lowercase hex SHA-256 over its canonical JSON; any changed field changes it.
 * @example buildIntentDigest(intent).length // 64
 */
export function buildIntentDigest(intent: RunIntent): string {
  return sha256Hex(canonicalStringify(intent));
}
