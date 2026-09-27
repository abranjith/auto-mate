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
//
// The OUTPUT rules (FEAT-109) exist because of how results are shown: a
// generated report renders in a sandboxed frame with no network access, so it
// must be self-contained — Plotly inlined, images embedded as data: URIs —
// and every file must use an extension its declared type allows, never .svg.
// ---------------------------------------------------------------------------

import { ARTIFACT_TYPES } from '../contracts/generation-api';
import { ARTIFACT_TYPE_POLICY } from '../artifacts/artifact-type';
import { SCRIPT_MAX_OUTPUT_FILE_BYTES } from '../execution/runtime-limits';
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
export const AS_OF_RULE = "The run's business date is in AUTOMATE_AS_OF_DATE (YYYY-MM-DD) and the exact moment in AUTOMATE_AS_OF (ISO 8601 with offset), in the time zone AUTOMATE_TIMEZONE. Use them wherever the task needs 'today' or 'now' — never datetime.now(), date.today(), or pandas' 'now'/'today' — so the task gives the same answer when it is run again.";
export const RERUNNABLE_TESTS_RULE = 'Tests must compute the results they expect from the input they read, never from literal values in the sample rows, so this task can be checked again against another file.';

const PLATFORM_NAMES: Readonly<Record<string, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** Each type with the extensions it may use, for example `image (.png, .jpg, .jpeg, .webp, .gif)`. */
function describeExtensions(): string {
  return ARTIFACT_TYPES.map((type) => `${type} (${ARTIFACT_TYPE_POLICY[type].extensions.join(', ')})`).join('; ');
}

/**
 * The output rules the rendering of results depends on (FEAT-109). Application
 * text; documented verbatim in the results docs, and a test ties the two.
 */
export const OUTPUT_CONTRACT_RULES: readonly string[] = Object.freeze([
  `Declare every output file in the manifest with one of the types above, and give it an extension that type allows: ${describeExtensions()}. Never write .svg files.`,
  "Write self-contained files. Results are shown in a sealed frame with no network access, so a Plotly figure must be written with write_html and include_plotlyjs=True, never 'cdn', or the chart renders empty; and an HTML report must embed its images as data: URIs rather than refer to other files, because a downloaded report travels alone.",
  `Keep every output file under ${Math.floor(SCRIPT_MAX_OUTPUT_FILE_BYTES / 1_048_576)} MB.`,
  'When you draw a chart, also write the numbers behind it as a csv, so they are available as data.',
  'Only this Python script is run: shell scripts are not executed, and a generated report cannot reach the network when it is shown.',
]);

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
    `3. Write every output file into the directory in the environment variable AUTOMATE_OUTPUT_DIR, and write ${MANIFEST_FILENAME} there too, declaring every output: {"artifacts": [{"filename": "...", "type": "...", "title": "...", "description": "..."}]}. "filename" is a plain file name with no directory. "type" is one of: ${types}.`,
    ...OUTPUT_CONTRACT_RULES.map((rule) => `   - ${rule}`),
    '4. Put the work in a script (usually main.py) that runs when executed directly. Write pytest tests with write_test that exercise it against the files in AUTOMATE_INPUT_DIR, then call run_tests.',
    `5. You have ${context.attemptLimit} test run${context.attemptLimit === 1 ? '' : 's'}. Each run_tests call uses one; failures come back filtered, with unrecognized lines withheld. When run_tests refuses, or the tests pass, call finalize_script once with the entrypoint, a plain-English summary, the input columns the script needs, and every declared output. Then stop.`,
    `6. ${SYNTHETIC_DATA_WARNING}`,
    `7. ${AS_OF_RULE}`,
    `8. ${RERUNNABLE_TESTS_RULE}`,
  ].join('\n');
}
