import { describe, expect, it } from 'vitest';
import { filterDiagnostics } from '../../disclosure/index';

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
});
