import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PROFILE_NOTE_CODES, type ProfileNote } from '@automate/core';
import { ProfilePanel, rowsText } from '../../../components/ingestion/profile-panel';
import { noteText } from '../../../components/ingestion/profile-notes';
import { looksLikeFormula } from '../../../components/ingestion/sample-rows-table';
import { statsText } from '../../../components/ingestion/column-table';
import { column, table, uploadResponse } from './upload-fixtures';

afterEach(cleanup);

describe('ProfilePanel', () => {
  it('renders every column with its type and empty-cell count, and says nothing was sent', () => {
    render(<ProfilePanel upload={uploadResponse()} />);
    const columns = within(screen.getByRole('region', { name: 'Columns' }));
    expect(columns.getByText('amount')).toBeTruthy();
    expect(columns.getByText('city')).toBeTruthy();
    expect(columns.getByText('decimal')).toBeTruthy();
    expect(columns.getAllByText('3')).not.toHaveLength(0);
    expect(screen.getByText('Everything shown here was computed on this computer. Nothing has been sent anywhere.')).toBeTruthy();
    expect(screen.getByText(/40,118 rows · 2 columns/)).toBeTruthy();
  });

  it('renders four sheet tabs, marks the hidden one, and switches content on click', async () => {
    const user = userEvent.setup();
    const sheets = ['North', 'South', 'Secret', 'Empty'].map((name, index) =>
      table({ sheetName: name, sheetIndex: index, isHidden: name === 'Secret', rowCount: index + 1, columns: [column({ name: `${name.toLowerCase()}_col` })], sampleRows: [['1']] }),
    );
    render(<ProfilePanel upload={uploadResponse(sheets, { format: 'xlsx' })} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['North', 'South', 'Secret (hidden)', 'Empty']);
    expect(screen.getByText(/4 sheets/)).toBeTruthy();
    expect(screen.getAllByText('north_col').length).toBeGreaterThan(0);
    await user.click(tabs[2]!);
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByText('secret_col').length).toBeGreaterThan(0);
    expect(screen.queryByText('north_col')).toBeNull();
  });

  it('shows the scan-limit wording and never a bare capped number', () => {
    render(<ProfilePanel upload={uploadResponse([table({ rowCount: 1_000_000, rowCountExact: false })])} />);
    expect(screen.getByText(/1,000,000\+ rows \(scan limit reached\)/)).toBeTruthy();
    expect(screen.queryByText(/1,000,000 rows/)).toBeNull();
    expect(rowsText(table({ rowCount: 1, rowCountExact: true }))).toBe('1 row');
  });

  it('shows "many" and no values at all for a high-cardinality column, even if values leaked into the data', () => {
    const leaky = column({ position: 0, name: 'customer_email', inferredType: 'string', isHighCardinality: true, distinctCount: null, topValues: [{ value: 'LEAKED-SECRET@example.com', count: 2 }], stats: null });
    const { container } = render(<ProfilePanel upload={uploadResponse([table({ columns: [leaky], sampleRows: [['[sampled]']] })])} />);
    expect(within(screen.getByRole('region', { name: 'Columns' })).getByText('many')).toBeTruthy();
    expect(container.textContent).not.toContain('LEAKED-SECRET');
  });

  it('renders frequent values for a low-cardinality column', () => {
    render(<ProfilePanel upload={uploadResponse()} />);
    expect(screen.getByText('Most common: Paris (4)')).toBeTruthy();
  });

  it('renders the ambiguous-date note with both candidate formats', () => {
    const note: ProfileNote = { code: 'ambiguous_date_format', column: 'order_date', formats: ['DD/MM/YYYY', 'MM/DD/YYYY'] };
    const dates = column({ name: 'order_date', inferredType: 'date', stats: { kind: 'temporal', min: '2024-01-02', max: '2026-09-12', detectedFormat: 'DD/MM/YYYY', ambiguous: true, alternateFormat: 'MM/DD/YYYY' } });
    render(<ProfilePanel upload={uploadResponse([table({ columns: [dates], notes: [note], sampleRows: [['01/02/2024']] })])} />);
    const notes = within(screen.getByRole('list', { name: 'Things to know about this table' }));
    expect(notes.getByText(/could be day\/month or month\/day \(DD\/MM\/YYYY or MM\/DD\/YYYY\)\. We will ask/)).toBeTruthy();
    expect(screen.getByText('2024-01-02 → 2026-09-12 · DD/MM/YYYY or MM/DD/YYYY?')).toBeTruthy();
  });

  it('shows a renamed duplicate column\'s original name and a mixed column\'s confidence', () => {
    const columns = [column({ name: 'amount' }), column({ position: 1, name: 'amount_2', originalName: 'amount', isMixedType: true, typeConfidence: 0.999 })];
    render(<ProfilePanel upload={uploadResponse([table({ columns, sampleRows: [['1', '2']] })])} />);
    expect(screen.getByText(/renamed from amount/)).toBeTruthy();
    expect(screen.getByText('decimal · mixed (99.9% fit)')).toBeTruthy();
  });

  it('renders hostile cells as literal text: no script, no image, no link, no formula', () => {
    const hostile = ['<script>alert(1)</script>', '=HYPERLINK("http://evil","x")', '<img src=x onerror=alert(1)>', '@SUM(A1)'];
    const columns = hostile.map((_, position) => column({ position, name: `c${position}` }));
    const { container } = render(<ProfilePanel upload={uploadResponse([table({ columns, sampleRows: [hostile] })])} />);
    const samples = screen.getByRole('region', { name: 'Sample rows' });
    for (const value of hostile) expect(within(samples).getByText(value)).toBeTruthy();
    expect(container.querySelector('script, img, a, iframe')).toBeNull();
    expect(within(samples).getByText('=HYPERLINK("http://evil","x")').getAttribute('title')).toMatch(/not run as a formula/);
  });

  it('marks a truncated cell', () => {
    const cut = `${'x'.repeat(199)}…`;
    render(<ProfilePanel upload={uploadResponse([table({ columns: [column()], sampleRows: [[cut]] })])} />);
    expect(screen.getByText(cut).getAttribute('title')).toMatch(/Cut to 200 characters/);
  });

  it('explains a table with column names but no data rows instead of rendering a blank panel', () => {
    render(<ProfilePanel upload={uploadResponse([table({ rowCount: 0, sampleRows: [] })])} />);
    expect(screen.getByText('This table has column names but no data rows yet.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Sample rows' })).toBeNull();
  });

  it('explains an empty sheet', () => {
    render(<ProfilePanel upload={uploadResponse([table({ columns: [], columnCount: 0, rowCount: 0, sampleRows: [], notes: [{ code: 'empty_sheet' }] })], { format: 'xlsx' })} />);
    expect(screen.getByText('There is no table on this sheet.')).toBeTruthy();
    expect(screen.getByText('This sheet has no table.')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('has plain-English wording for every note code', () => {
    for (const code of PROFILE_NOTE_CODES) {
      const { container } = render(<p>{noteText({ code, column: 'x', columns: ['x_2'], count: 2, limit: 5, formats: ['A', 'B'] })}</p>);
      expect(container.textContent?.length).toBeGreaterThan(10);
      cleanup();
    }
  });

  it('flags formula-like cells but not signed numbers', () => {
    expect(['=A1', '@x', '+cmd', '-x'].map(looksLikeFormula)).toEqual([true, true, true, true]);
    expect(['-5', '+1.5', '-.5', 'text', ''].map(looksLikeFormula)).toEqual([false, false, false, false, false]);
  });

  it('formats statistics by kind', () => {
    expect(statsText({ kind: 'numeric', min: 0, max: 9812.4, mean: 1.234, stddev: null, median: 2, p25: 1, p75: 3, approximate: true })).toBe('0 – 9,812.4 · mean 1.23 · median 2 (estimated)');
    expect(statsText({ kind: 'string', minLength: 1, maxLength: 42, meanLength: 5 })).toBe('length 1–42');
    expect(statsText(null)).toBe('');
  });
});
