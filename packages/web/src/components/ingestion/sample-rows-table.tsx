import { SAMPLE_CELL_MAX_CHARS, TRUNCATION_MARKER, type ColumnProfile } from '@automate/core';
import { ds } from '../../design-system/tokens';

/**
 * Whether a cell would read as a spreadsheet formula (`=`, `@`, or a sign
 * that is not the start of a number). Such cells are shown literally and
 * marked, never interpreted.
 */
export function looksLikeFormula(value: string): boolean {
  return /^[=@]/.test(value) || /^[+-](?![\d.])/.test(value);
}

/**
 * One cell of the person's own file. It is untrusted input to the DOM, so it
 * is rendered as a text node only: no HTML, no Markdown, no links.
 */
function CellText({ value }: { value: string }) {
  if (looksLikeFormula(value)) {
    return (
      <span className={ds.formulaLike} title="Shown as text. It is not run as a formula.">
        {value}
      </span>
    );
  }
  if (value.length === SAMPLE_CELL_MAX_CHARS && value.endsWith(TRUNCATION_MARKER)) {
    return (
      <span className={ds.truncatedCell} title={`Cut to ${SAMPLE_CELL_MAX_CHARS} characters for this preview.`}>
        {value}
      </span>
    );
  }
  return <>{value}</>;
}

/** The sampled rows, scrollable sideways, with the header row kept in view. */
export function SampleRowsTable({ columns, rows }: { columns: readonly ColumnProfile[]; rows: readonly (readonly string[])[] }) {
  return (
    <div className={ds.tableScroll} role="region" aria-label="Sample rows" tabIndex={0}>
      <table className={ds.dataTable}>
        <thead className={ds.tableHead}>
          <tr>
            {columns.map((column) => (
              <th key={column.position} scope="col" className={ds.tableHeaderCell}>
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, index) => (
                <td key={column.position} className={ds.tableCell}>
                  <CellText value={row[index] ?? ''} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
