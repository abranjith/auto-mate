// ---------------------------------------------------------------------------
// The FEAT-104 ingestion fixture corpus: deliberately awkward but realistic
// files, GENERATED here rather than checked in as opaque binaries, so every
// byte of every fixture is reviewable in this file.
//
// Not a test file: `ingestion-e2e.test.ts` writes the corpus to a temporary
// directory and drives each fixture through the real route → intake →
// profile → persist → payload path.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProfileNoteCode, TableProfile } from '@automate/core';
import { writeLargeWorkbook, writeStreamingWorkbook } from '../../support/workbook-fixtures';

/** What a fixture must produce: a typed error, or profiles that satisfy a check. */
export type Expectation =
  | { readonly error: string }
  | { readonly tables: number; readonly check?: (profiles: readonly TableProfile[]) => void; readonly notes?: readonly ProfileNoteCode[] };

export interface Fixture {
  readonly name: string;
  readonly file: string;
  readonly expect: Expectation;
  /** Generated at run time and too big to rebuild per test. */
  readonly large?: boolean;
}

const lines = (...rows: string[]) => `${rows.join('\n')}\n`;
const cities = ['Paris', 'Oslo', 'Lima', 'Quito', 'Accra'];

function cleanCsv(): string {
  const rows = Array.from({ length: 1_200 }, (_, index) => `${index + 1},${(index * 3.25).toFixed(2)},${cities[index % 5]},customer${index}@example.com`);
  return lines('id,amount,city,email', ...rows);
}

function footerCsv(): string {
  const rows = Array.from({ length: 30 }, (_, index) => `${index + 1},${index * 10}`);
  return `${lines('id,amount', ...rows, 'Total,4350')}\n\n`;
}

function ambiguousDatesCsv(): string {
  const rows = Array.from({ length: 24 }, (_, index) => `${String((index % 12) + 1).padStart(2, '0')}/${String((index % 11) + 1).padStart(2, '0')}/2026,${index}`);
  return lines('order_date,units', ...rows);
}

/** Every fixture, written into `dir`. The 300,001-row workbook is included only when `large` is true. */
export async function writeCorpus(dir: string, large: boolean): Promise<Fixture[]> {
  const put = (name: string, content: string | Uint8Array) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  };
  const fixtures: Fixture[] = [
    { name: 'clean comma CSV', file: put('clean.csv', cleanCsv()), expect: { tables: 1, check: ([p]) => {
      if (p!.delimiter !== ',' || p!.rowCount !== 1_200) throw new Error('clean CSV misread');
      if (!p!.columns[3]!.isHighCardinality) throw new Error('email column should be high-cardinality');
    } } },
    { name: 'European semicolon CSV with comma decimals', file: put('european.csv', lines('id;amount;city', '1;3,50;Paris', '2;4,25;Lyon', '3;12,00;Nice')), expect: { tables: 1, check: ([p]) => {
      if (p!.delimiter !== ';' || p!.columnCount !== 3) throw new Error('semicolon CSV misread');
    } } },
    { name: 'windows-1252 CSV with accented names', file: put('latin1.csv', Buffer.from(lines('id,name', '1,José', '2,Zoë', '3,Françoise'), 'latin1')), expect: { tables: 1, notes: ['encoding_guessed'], check: ([p]) => {
      if (!p!.sampleRows.flat().includes('Françoise')) throw new Error('latin-1 text mis-decoded');
    } } },
    { name: 'UTF-8 BOM CSV', file: put('bom.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines('id,name', '1,Ada'))])), expect: { tables: 1, check: ([p]) => {
      if (p!.columns[0]!.name !== 'id') throw new Error('BOM leaked into the header');
    } } },
    { name: 'CSV with embedded newlines', file: put('newlines.csv', lines('id,comment,n', '1,"first line\nsecond line",2', '2,"plain",3')), expect: { tables: 1, check: ([p]) => {
      if (p!.rowCount !== 2) throw new Error('embedded newline split a row');
    } } },
    { name: 'CSV with a footer total and trailing blank lines', file: put('footer.csv', footerCsv()), expect: { tables: 1, notes: ['blank_rows', 'mixed_type_column'] } },
    { name: 'CSV with duplicate header names', file: put('duplicates.csv', lines('amount,amount,city', '1,2,Paris', '3,4,Oslo')), expect: { tables: 1, notes: ['no_header_detected'] } },
    { name: 'CSV with no header', file: put('noheader.csv', lines('1,2.5,Paris', '2,3.5,Oslo')), expect: { tables: 1, notes: ['no_header_detected'], check: ([p]) => {
      if (p!.columns[0]!.name !== 'column_1') throw new Error('header-less columns not synthesized');
    } } },
    { name: 'CSV whose every day is 12 or less', file: put('ambiguous.csv', ambiguousDatesCsv()), expect: { tables: 1, notes: ['ambiguous_date_format'] } },
    { name: 'tab-separated file', file: put('tabs.tsv', lines('id\tname', '1\tAda', '2\tGrace')), expect: { tables: 1, check: ([p]) => {
      if (p!.delimiter !== '\t') throw new Error('tab delimiter missed');
    } } },
    { name: 'single-column file', file: put('single.csv', lines('name', 'Ada', 'Grace', 'Katherine')), expect: { tables: 1, check: ([p]) => {
      if (p!.columnCount !== 1) throw new Error('single column split');
    } } },
    { name: 'header-only file', file: put('header-only.csv', lines('id,name,city')), expect: { tables: 1, check: ([p]) => {
      if (p!.rowCount !== 0 || p!.columns.map(({ name }) => name).join() !== 'id,name,city') throw new Error('header-only misread');
    } } },
    { name: 'zero-byte file', file: put('empty.csv', ''), expect: { error: 'FILE_EMPTY' } },
    { name: 'legacy .xls', file: put('legacy.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array(504).fill(0)])), expect: { error: 'UNSUPPORTED_FILE_FORMAT' } },
    { name: 'executable', file: put('setup.exe', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff])), expect: { error: 'UNSUPPORTED_FILE_FORMAT' } },
  ];
  const report = path.join(dir, 'report.xlsx');
  await writeStreamingWorkbook(report, [{ name: 'Report', rows: [['Q3 Sales Report'], [], ['region', 'amount'], ['North', 12.5], ['South', 3]], merges: ['A1:B1'] }]);
  fixtures.push({ name: 'workbook with a title above the header', file: report, expect: { tables: 1, notes: ['leading_blank_rows_skipped', 'merged_cells'], check: ([p]) => {
    if (p!.headerRowIndex !== 2) throw new Error('title row taken as header');
  } } });
  const four = path.join(dir, 'four-sheets.xlsx');
  await writeStreamingWorkbook(four, [
    { name: 'North', rows: [['id', 'v'], [1, 2]] },
    { name: 'South', rows: [['id', 'v'], [3, 4]] },
    { name: 'Secret', state: 'hidden', rows: [['id', 'v'], [5, 6]] },
    { name: 'Blank', rows: [] },
  ]);
  fixtures.push({ name: 'four-sheet workbook with a hidden and an empty sheet', file: four, expect: { tables: 4, check: (profiles) => {
    if (!profiles[2]!.isHidden || !profiles[3]!.notes.some(({ code }) => code === 'empty_sheet')) throw new Error('hidden or empty sheet not recorded');
  } } });
  const formulas = path.join(dir, 'formulas.xlsx');
  await writeStreamingWorkbook(formulas, [{ name: 'F', rows: [['Totals'], ['a', 'double'], [2, { formula: 'A3*2', result: 4 }], [3, { formula: 'A4*2', result: 6 }]], merges: ['A1:B1'] }]);
  fixtures.push({ name: 'workbook with formulas and merged cells', file: formulas, expect: { tables: 1, notes: ['formula_cells', 'merged_cells'] } });
  if (large) {
    const big = path.join(dir, 'big.xlsx');
    await writeLargeWorkbook(big, 300_001, true);
    fixtures.push({ name: 'workbook with 300,001 rows', file: big, large: true, expect: { tables: 1, check: ([p]) => {
      if (p!.rowCount !== 300_000) throw new Error('large workbook miscounted');
    } } });
  }
  return fixtures;
}
