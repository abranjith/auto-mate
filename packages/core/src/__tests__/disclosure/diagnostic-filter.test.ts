import { describe, expect, it } from 'vitest';
import { filterDiagnostics } from '../../disclosure/index';
import valueError from '../../disclosure/__fixtures__/diagnostics/value-error.txt?raw';
import chainedTraceback from '../../disclosure/__fixtures__/diagnostics/chained-traceback.txt?raw';
import syntaxError from '../../disclosure/__fixtures__/diagnostics/syntax-error.txt?raw';
import ruffPytest from '../../disclosure/__fixtures__/diagnostics/ruff-pytest.txt?raw';

const fixtures = { 'value-error': valueError, 'chained-traceback': chainedTraceback, 'syntax-error': syntaxError, 'ruff-pytest': ruffPytest } as const;
const fixture = (name: keyof typeof fixtures) => fixtures[name].trimEnd();

describe('diagnostic filter', () => {
  it('keeps recognized structure, basenames paths, and masks user literals', () => {
    const raw = `Traceback (most recent call last):\n  File "C:\\private\\runner.py", line 12, in parse\n    value = row["secret"]\nValueError: could not convert string to float: 'N/A — see Jane's note'`;
    const result = filterDiagnostics(raw);
    expect(result.text).toContain('runner.py');
    expect(result.text).not.toContain('C:\\private');
    expect(result.text).not.toContain('Jane');
    expect(result.text).not.toContain('value = row');
    expect(result.droppedLineCount).toBeGreaterThan(0);
  });

  it('keeps ruff and pytest lines, masks long numbers, and bounds output', () => {
    const raw = `src/job.py:12:3: F821 Undefined name 'customer_email'\nFAILED tests/test_job.py::test_one - ValueError: record 123456789 failed`;
    const result = filterDiagnostics(raw, { maxBytes: 100 });
    expect(JSON.stringify(result)).not.toContain('customer_email');
    expect(result.checks[0]?.code).toBe('F821');
    expect(result.testFailures[0]).toContain('<num>');
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(100);
  });

  it('drops binary noise and is text-idempotent', () => {
    expect(filterDiagnostics('\u0000\u0001private').text).toBe('');
    const first = filterDiagnostics('ValueError: bad value \'secret\'');
    expect(filterDiagnostics(first.text).text).toBe(first.text);
  });

  it('keeps only allowlisted structure across the captured diagnostic corpus', () => {
    const value = filterDiagnostics(fixture('value-error'));
    expect(value.text).toContain('runner.py');
    expect(value.text).not.toMatch(/Jane|customer_email|Users\\person/);

    const chained = filterDiagnostics(fixture('chained-traceback'));
    expect(chained.frames.map(({ file }) => file)).toEqual(['reader.py', 'main.py']);
    expect(chained.text).not.toMatch(/customer_email|private row|home\/person/);

    const syntax = filterDiagnostics(fixture('syntax-error'));
    expect(syntax.text).toContain('SyntaxError');
    expect(syntax.text).not.toMatch(/print\(|\^/);

    const checks = filterDiagnostics(fixture('ruff-pytest'));
    expect(checks.text).toMatch(/F821|FAILED/);
    expect(checks.text).not.toMatch(/customer_email|private customer row|123456789/);
  });
});
