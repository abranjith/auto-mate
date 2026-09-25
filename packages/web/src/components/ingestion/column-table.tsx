import type { ColumnProfile, ColumnStats } from '@automate/core';
import { ds } from '../../design-system/tokens';

const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Type-appropriate statistics as one line of text. */
export function statsText(stats: ColumnStats | null): string {
  if (stats === null) return '';
  if (stats.kind === 'numeric') {
    const estimate = stats.approximate ? ' (estimated)' : '';
    return `${number(stats.min)} – ${number(stats.max)} · mean ${number(stats.mean)} · median ${number(stats.median)}${estimate}`;
  }
  if (stats.kind === 'temporal') {
    const format = stats.ambiguous && stats.alternateFormat ? `${stats.detectedFormat} or ${stats.alternateFormat}?` : stats.detectedFormat;
    return `${stats.min} → ${stats.max} · ${format}`;
  }
  return `length ${number(stats.minLength)}–${number(stats.maxLength)}`;
}

function typeText(column: ColumnProfile): string {
  if (!column.isMixedType) return column.inferredType;
  return `${column.inferredType} · mixed (${(column.typeConfidence * 100).toFixed(1)}% fit)`;
}

/** Frequent values only for a low-cardinality column; a high-cardinality column shows none, whatever the data says. */
function frequentText(column: ColumnProfile): string {
  if (column.isHighCardinality || !column.topValues || column.topValues.length === 0) return '';
  return `Most common: ${column.topValues.map(({ value, count }) => `${value} (${count.toLocaleString('en-US')})`).join(', ')}`;
}

/** Column names, inferred types, empty-cell counts, distinct counts, and statistics. */
export function ColumnTable({ columns }: { columns: readonly ColumnProfile[] }) {
  return (
    <div className={ds.tableScroll} role="region" aria-label="Columns" tabIndex={0}>
      <table className={ds.dataTable}>
        <thead className={ds.tableHead}>
          <tr>
            {['#', 'Column', 'Type', 'Empty cells', 'Distinct', 'Details'].map((heading) => (
              <th key={heading} scope="col" className={ds.tableHeaderCell}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.position}>
              <td className={ds.tableCell}>{column.position + 1}</td>
              <td className={ds.tableCell}>
                {column.name}
                {column.originalName !== null ? <span className={ds.statusMuted}> (renamed from {column.originalName})</span> : null}
              </td>
              <td className={ds.tableCell}>{typeText(column)}</td>
              <td className={ds.tableCell}>{(column.nullCount + column.blankCount).toLocaleString('en-US')}</td>
              <td className={ds.tableCell}>{column.isHighCardinality ? 'many' : (column.distinctCount ?? 0).toLocaleString('en-US')}</td>
              <td className={ds.tableCell}>
                {statsText(column.stats)}
                {frequentText(column) ? <div className={ds.statusMuted}>{frequentText(column)}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
