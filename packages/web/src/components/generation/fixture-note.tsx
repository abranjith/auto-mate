import type { SyntheticFixture } from '@automate/core';
import { ds } from '../../design-system/tokens';

/** The honesty line. A test must fail if a refactor softens or drops it. */
export function fixtureSentence(rowCount: number | null, sampleRowCount: number | null): string {
  const rows = rowCount === null ? 'synthetic rows' : `${rowCount.toLocaleString()} synthetic rows`;
  const samples = sampleRowCount === null ? 'the sample rows you approved' : `the ${sampleRowCount.toLocaleString()} sample row${sampleRowCount === 1 ? '' : 's'} you approved`;
  return `Tested against ${rows} built from your column descriptions and ${samples}. Your real file has not been read yet.`;
}

/**
 * What the tests ran against, rendered on every attempt, with an expander for
 * the synthetic preview. Preview cells are the person's own approved data or
 * invented values: text only, and a leading `=`, `+`, `-`, or `@` stays literal.
 */
export function FixtureNote({ fixtures }: { fixtures?: readonly SyntheticFixture[] }) {
  const first = fixtures?.[0];
  return (
    <div className={ds.stackTight}>
      <p className={ds.fixtureNote}>{fixtureSentence(first?.rowCount ?? null, first?.sampleRowCount ?? null)}</p>
      {fixtures?.length ? (
        <details className={ds.receipt}>
          <summary>Show the test data</summary>
          {fixtures.map((fixture) => fixture.preview.map((table, index) => (
            <div key={`${fixture.id}-${index}`} className={ds.tableScroll}>
              <p className={ds.hint}>{fixture.fileName}{table.sheetName ? ` — ${table.sheetName}` : ''}: first {table.rows.length} of {fixture.rowCount} rows</p>
              <table className={ds.dataTable}>
                <thead className={ds.tableHead}><tr>{table.header.map((name, column) => <th key={column} className={ds.tableHeaderCell}>{name}</th>)}</tr></thead>
                <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} className={ds.tableCell}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )))}
        </details>
      ) : null}
    </div>
  );
}
