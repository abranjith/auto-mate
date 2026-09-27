import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { REPAIR_INSTRUCTIONS_PREFACE, renderMappingInstructions, type CompatibilityReport as Report, type InputContract, type RepairMapping, type UploadResponse } from '@automate/core';
import { MappingForm, initialMapping } from '../../../components/saved/mapping-form';
import { InstructionPreview } from '../../../components/saved/instruction-preview';
import { CompatibilityReport } from '../../../components/saved/compatibility-report';
import { AsOfField } from '../../../components/saved/as-of-field';
import { CodeVersionCard } from '../../../components/generation/code-version-card';

afterEach(cleanup);
const HOSTILE = '<img src=x onerror=alert(1)>';
const asOf = { at: 1, date: '2026-09-26', timeZone: 'UTC', source: 'now' as const };
const finding = (overrides: Partial<Report['findings'][number]>): Report['findings'][number] => ({ code: 'column_missing', severity: 'blocking', inputPosition: 0, sheet: 'Sheet1', column: 'Amount', expected: 'decimal', found: null, suggestion: null, ...overrides });
const report = (findings: Report['findings'], status: Report['status'] = 'incompatible'): Report => ({ version: 1, templateId: 1, revisionNumber: 1, contractDigest: 'a'.repeat(64), status, inputs: [], findings, rules: { applied: 0, notNeeded: 0, conflicts: 0, unrecorded: 0 }, runtime: { revision: 'a', current: null, changes: [] }, asOf });
const upload = (columns: string[]): UploadResponse => ({ upload: { id: 30 }, profiles: [{ sheetName: 'Sheet1', sheetIndex: 0, columns: columns.map((name, position) => ({ name, position })) }] } as unknown as UploadResponse);
const contract: InputContract = { version: 1, inputs: [], rules: [], notes: [] };

function Harness({ value: initial, uploads }: { value: Report; uploads: UploadResponse[] }) {
  const [mapping, setMapping] = useState<RepairMapping>(initialMapping(initial));
  return <><MappingForm report={initial} uploads={uploads} value={mapping} onChange={setMapping} /><InstructionPreview mapping={mapping} contract={contract} /></>;
}

describe('MappingForm and InstructionPreview', () => {
  it('asks in work terms with plain type words, preselects the suggestion, and previews the exact core sentences', async () => {
    const user = userEvent.setup();
    const value = report([finding({ suggestion: 'amount' }), finding({ column: 'Region', expected: 'string', suggestion: null })]);
    const { container } = render(<Harness value={value} uploads={[upload(['amount', 'Total', 'Area'])]} />);
    expect(screen.getByText(/The saved task used a column called “Amount” \(numbers\) in file 1 › Sheet1/)).toBeTruthy();
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects.map((select) => select.value)).toEqual(['amount', '']);
    expect(screen.getAllByRole('option', { name: "None — it isn't in this file" })).toHaveLength(2);
    await user.selectOptions(selects[1]!, 'Area');
    const expected = renderMappingInstructions({ columns: [{ inputPosition: 0, sheet: 'Sheet1', expected: 'Amount', use: 'amount' }, { inputPosition: 0, sheet: 'Sheet1', expected: 'Region', use: 'Area' }], sheets: [], decisions: [], note: null }, contract);
    expect(container.querySelector('pre')!.textContent).toBe(expected);
    expect(expected.startsWith(REPAIR_INSTRUCTIONS_PREFACE)).toBe(true);
  });

  it('renders hostile column and sheet names as literal text', () => {
    const { container } = render(<Harness value={report([finding({ column: HOSTILE, sheet: '<script>x</script>' })])} uploads={[upload([HOSTILE])]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
  });
});

describe('CompatibilityReport', () => {
  it('shows blockers and warnings in work terms and leaves information out', () => {
    render(<CompatibilityReport report={report([finding({}), finding({ code: 'extra_columns', severity: 'info', column: null, found: '2' }), finding({ code: 'runtime_unknown', severity: 'advisory', column: null, sheet: null, inputPosition: -1 })])} />);
    expect(screen.getByText('This file needs choices or repair before it can run.')).toBeTruthy();
    expect(screen.getByText('A required column is missing')).toBeTruthy();
    expect(screen.getByText('The Python environment is not ready')).toBeTruthy();
    expect(screen.queryByText('There are extra columns')).toBeNull();
    expect(document.body.textContent).not.toMatch(/column_missing|runtime_unknown/);
  });
});

describe('AsOfField', () => {
  it('shows today in words, caps the picker at today, and reports a chosen date', async () => {
    const user = userEvent.setup(); const onChange = vi.fn();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    const { rerender } = render(<AsOfField date={null} onChange={onChange} zone="UTC" />);
    expect(screen.getByText(/^Run as of today \(\d{1,2} [A-Z][a-z]{2} \d{4}\) · UTC$/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Choose another date' }));
    const input = screen.getByLabelText('Date') as HTMLInputElement;
    expect(input.max).toBe(today);
    rerender(<AsOfField date="2026-08-31" onChange={onChange} zone="UTC" />);
    expect(screen.getByText('Run as of 31 Aug 2026 · UTC')).toBeTruthy();
  });
});

describe('CodeVersionCard', () => {
  it('labels a version copied from a saved task by its revision, not as an attempt', () => {
    const event = { seq: 1, type: 'code_version_sealed' as const, codeVersionId: 5, attempt: 1, digest: 'a'.repeat(64), files: [{ path: 'main.py', role: 'script' as const, byteSize: 10, lineCount: 2 }], at: '2026-09-26T10:00:00.000Z' };
    const { rerender } = render(<CodeVersionCard event={event} load={vi.fn()} savedRevisionNumber={2} />);
    expect(screen.getByText(/From saved task revision 2/)).toBeTruthy();
    expect(screen.queryByText(/Attempt 1/)).toBeNull();
    rerender(<CodeVersionCard event={event} load={vi.fn()} />);
    expect(screen.getByText(/Attempt 1/)).toBeTruthy();
  });
});
