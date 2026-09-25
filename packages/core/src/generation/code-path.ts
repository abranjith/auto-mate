// A path from a model is user input by another route. This one function is
// shared by the tool boundary and the repository so the two cannot disagree
// about what a safe generated-file path is.

import { InvalidCodePathError } from '../errors/generation-errors';
import type { CodeFileRole } from './code-version';
import { MAX_CODE_PATH_CHARS, MAX_CODE_PATH_DEPTH } from './limits';

const DIRECTORY_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const FILE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*\.py$/;
const TEST_NAME = /^(?:test_[A-Za-z0-9_-]+|[A-Za-z0-9_-]+_test)\.py$/;
// Device names Windows refuses as a file stem in any directory.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// The script's output directory is created by the application inside each attempt.
const RESERVED_DIRECTORIES = new Set(['output']);
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Reject the shapes that could name a file outside the attempt directory. */
function assertRelative(path: string): void {
  if (CONTROL.test(path)) throw new InvalidCodePathError(path, 'paths may not contain control characters.');
  if (path.includes('\\')) throw new InvalidCodePathError(path, 'use forward slashes, for example `lib/helpers.py`.');
  if (/^[A-Za-z]:/.test(path)) throw new InvalidCodePathError(path, 'use a relative path such as `main.py`, not a drive letter.');
  if (path.startsWith('/')) throw new InvalidCodePathError(path, 'use a relative path such as `main.py`, not an absolute one.');
}

/** Enforce the naming rule that decides which files pytest collects. */
function assertRole(path: string, name: string, role: CodeFileRole): void {
  if (role === 'test' && !TEST_NAME.test(name)) throw new InvalidCodePathError(path, 'test files must be named `test_<name>.py` or `<name>_test.py` so pytest collects them.');
  if (role !== 'test' && TEST_NAME.test(name)) throw new InvalidCodePathError(path, 'a name like `test_*.py` is reserved for tests; write it with write_test, or rename the script.');
}

/**
 * Validate and normalize a generated file's path.
 *
 * @param path The model-supplied path, relative to the attempt directory.
 * @param role What the file is for; `test` files must follow pytest's naming, other roles must not.
 * @returns The normalized forward-slash path with `.` and empty segments removed.
 * @throws InvalidCodePathError naming exactly what to change: absolute paths, drive letters, backslashes, `..`, control characters, a non-`.py` file, over 128 characters, or over 2 segments deep.
 * @example validateCodePath('./lib//helpers.py', 'script') // 'lib/helpers.py'
 */
export function validateCodePath(path: string, role: CodeFileRole): string {
  assertRelative(path);
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new InvalidCodePathError(path, '`..` is not allowed; keep every file inside the attempt directory.');
  const normalized = segments.join('/');
  if (normalized === '') throw new InvalidCodePathError(path, 'the path is empty; use a name such as `main.py`.');
  if (normalized.length > MAX_CODE_PATH_CHARS) throw new InvalidCodePathError(path, `paths may be at most ${MAX_CODE_PATH_CHARS} characters.`);
  if (segments.length > MAX_CODE_PATH_DEPTH) throw new InvalidCodePathError(path, `paths may be at most ${MAX_CODE_PATH_DEPTH} levels deep, for example \`lib/helpers.py\`.`);
  const name = segments.at(-1)!;
  if (!name.endsWith('.py')) throw new InvalidCodePathError(path, 'it is not a Python file; use a `.py` path.');
  if (!FILE_SEGMENT.test(name) || !segments.slice(0, -1).every((segment) => DIRECTORY_SEGMENT.test(segment))) throw new InvalidCodePathError(path, 'use only letters, digits, `_`, and `-` in file and directory names.');
  if (segments.some((segment) => WINDOWS_RESERVED.test(segment.replace(/\.py$/, '')))) throw new InvalidCodePathError(path, 'that name is reserved by Windows; choose another.');
  if (segments.length > 1 && RESERVED_DIRECTORIES.has(segments[0]!.toLowerCase())) throw new InvalidCodePathError(path, '`output/` is where the script writes its results; put code in another directory.');
  assertRole(path, name, role);
  return normalized;
}
