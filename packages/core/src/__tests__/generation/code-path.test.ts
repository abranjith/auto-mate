import { describe, expect, it } from 'vitest';
import { validateCodePath } from '../../generation/code-path';
import { InvalidCodePathError } from '../../errors/generation-errors';
import { AutoMateError } from '../../errors/automate-error';

function rejection(path: string, role: 'script' | 'test' | 'support' = 'script'): InvalidCodePathError {
  try {
    validateCodePath(path, role);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidCodePathError);
    return error as InvalidCodePathError;
  }
  throw new Error(`expected ${JSON.stringify(path)} to be rejected`);
}

describe('validateCodePath', () => {
  it.each([
    ['main.py', 'script', 'main.py'],
    ['lib/helpers.py', 'script', 'lib/helpers.py'],
    ['test_main.py', 'test', 'test_main.py'],
    ['main_test.py', 'test', 'main_test.py'],
    ['tests/test_io.py', 'test', 'tests/test_io.py'],
    ['./lib//helpers.py', 'script', 'lib/helpers.py'],
    ['./main.py', 'script', 'main.py'],
    ['support_code.py', 'support', 'support_code.py'],
    ['output.py', 'script', 'output.py'],
  ] as const)('accepts %j as %s and normalizes it to %j', (path, role, expected) => {
    expect(validateCodePath(path, role)).toBe(expected);
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['/main.py', 'absolute'],
    ['C:\\x.py', 'forward slashes'],
    ['C:/x.py', 'drive letter'],
    ['c:main.py', 'drive letter'],
    ['../x.py', '`..`'],
    ['a/../../b.py', '`..`'],
    ['lib/../main.py', '`..`'],
    ['a\\b.py', 'forward slashes'],
    ['main.txt', 'not a Python file'],
    ['main', 'not a Python file'],
    ['.py', 'letters, digits'],
    ['', 'empty'],
    ['./', 'empty'],
    [`${'a'.repeat(197)}.py`, '128 characters'],
    ['a/b/c/d.py', 'levels deep'],
    ['a/b/c.py', 'levels deep'],
    ['main\u0000.py', 'control characters'],
    ['main\n.py', 'control characters'],
    ['my file.py', 'letters, digits'],
    ['lib:stream.py', 'letters, digits'],
    ['con.py', 'reserved by Windows'],
    ['NUL/x.py', 'reserved by Windows'],
    ['lpt1.py', 'reserved by Windows'],
    ['output/x.py', 'where the script writes its results'],
    ['Output/x.py', 'where the script writes its results'],
  ])('rejects %j (%s)', (path, reason) => {
    expect(rejection(path).message).toContain(reason);
  });

  it('keeps test naming and script naming apart so pytest collects exactly the tests', () => {
    expect(rejection('test_x.py', 'script').message).toContain('reserved for tests');
    expect(rejection('x_test.py', 'support').message).toContain('reserved for tests');
    expect(rejection('main.py', 'test').message).toContain('test_<name>.py');
    expect(rejection('lib/helpers.py', 'test').message).toContain('test_<name>.py');
  });

  it('raises a stable-coded application error with no stack on the wire', () => {
    const error = rejection('../x.py');
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error.code).toBe('INVALID_CODE_PATH');
    expect(JSON.stringify(error.toJSON())).not.toContain('stack');
  });

  it('never echoes a control character back to the model and caps an echoed path', () => {
    expect(rejection('a\u0007b.py').message).not.toContain('\u0007');
    expect(rejection(`${'z'.repeat(300)}.txt`).message.length).toBeLessThan(250);
  });
});
