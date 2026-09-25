import { describe, expect, it } from 'vitest';
import { filterDiagnostics } from '../../disclosure/diagnostic-filter';

describe('docs-examples', () => {
  it('keeps the documented diagnostics example synchronized with the real filter', () => {
    expect(filterDiagnostics("ValueError: could not convert string to float: 'N/A — see Jane's note'").text).toBe('ValueError: could not convert string to float: <str len=21>');
  });
});
