// ---------------------------------------------------------------------------
// The generated-code contract (FEAT-106 TASK-010).
//
// This is the ONLY place the code-generation instructions exist. It is
// application-authored text and enters a prompt solely as
// `assemblePromptContext`'s `application_text` source. It contains no
// absolute path: inputs and outputs are named by environment variable, and
// input files by the stored name the fixture and the real run both use.
//
// The synthetic-data sentence is load-bearing: it is the one a model most
// needs and a refactor most easily drops, so a test asserts it verbatim.
// ---------------------------------------------------------------------------

import { ARTIFACT_TYPES } from '../contracts/generation-api';
import type { FileFormat } from '../contracts/upload-api';

/** One input file as the generated script will find it. */
export interface ContractInputFile {
  /** The stored filename, identical for the synthetic fixture and the real run. */
  readonly filename: string;
  readonly format: FileFormat;
  /** Worksheet names in order, for a workbook; empty for CSV. */
  readonly sheets: readonly string[];
}

export interface CodeContractContext {
  /** `win32`, `darwin`, or `linux`. */
  readonly platform: string;
  /** The Python version the environment uses, for example `3.12.4`, or null when not yet probed. */
  readonly pythonVersion: string | null;
  readonly dependencies: readonly string[];
  readonly inputFiles: readonly ContractInputFile[];
  readonly attemptLimit: number;
  readonly artifactTypes?: readonly string[];
}

/** The manifest file every run writes into `$AUTOMATE_OUTPUT_DIR`. */
export const MANIFEST_FILENAME = 'manifest.json';

/** The sentence that tells the model its test data is synthetic. Asserted verbatim by tests. */
export const SYNTHETIC_DATA_WARNING = 'The data available during testing is synthetic and shaped like the real file, so the code must not assume values it saw, only the schema it was given.';

const PLATFORM_NAMES: Readonly<Record<string, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function describeInputs(files: readonly ContractInputFile[]): string {
  if (files.length === 0) return '- There are no input files.';
  return files.map((file) => `- \`${file.filename}\` (${file.format.toUpperCase()}${file.sheets.length ? `; sheets in order: ${file.sheets.map((sheet) => `"${sheet}"`).join(', ')}` : ''})`).join('\n');
}

/**
 * Render the instructions every generated script and its tests must follow.
 *
 * @param context Platform, Python, dependency set, input files, and the attempt limit.
 * @returns Deterministic application text; identical input yields identical output.
 * @example renderCodeContract({ platform: 'linux', pythonVersion: '3.12.4', dependencies: ['pandas'], inputFiles: [], attemptLimit: 3 })
 */
export function renderCodeContract(context: CodeContractContext): string {
  const types = (context.artifactTypes ?? ARTIFACT_TYPES).join(', ');
  return [
    'CODE CONTRACT — follow every rule below.',
    `1. Write Python only${context.pythonVersion ? ` (Python ${context.pythonVersion})` : ''} for ${PLATFORM_NAMES[context.platform] ?? context.platform}. Use only the standard library and these installed packages: ${context.dependencies.join(', ')}. Do not install packages, do not use the network, and do not write shell scripts.`,
    '2. Read inputs from the directory in the environment variable AUTOMATE_INPUT_DIR, joined with these exact filenames. Never use an absolute path or any other location:',
    describeInputs(context.inputFiles),
    `3. Write every output file into the directory in the environment variable AUTOMATE_OUTPUT_DIR, and write ${MANIFEST_FILENAME} there too, declaring every output: {"artifacts": [{"filename": "...", "type": "...", "title": "...", "description": "..."}]}. "filename" is a plain file name with no directory. "type" is one of: ${types}. A plotly-html report must embed Plotly (include_plotlyjs=True, never 'cdn').`,
    '4. Put the work in a script (usually main.py) that runs when executed directly. Write pytest tests with write_test that exercise it against the files in AUTOMATE_INPUT_DIR, then call run_tests.',
    `5. You have ${context.attemptLimit} test run${context.attemptLimit === 1 ? '' : 's'}. Each run_tests call uses one; failures come back filtered, with unrecognized lines withheld. When run_tests refuses, or the tests pass, call finalize_script once with the entrypoint, a plain-English summary, the input columns the script needs, and every declared output. Then stop.`,
    `6. ${SYNTHETIC_DATA_WARNING}`,
  ].join('\n');
}
