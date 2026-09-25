import type { DisclosurePayload, DisclosedTable, Truncation } from '../contracts/upload-api';

const cleanCell = (value: string) => value.replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('|', '\\|');
const truncationText = (item: Truncation) => `${item.step}${item.sheetIndex === undefined ? '' : ` on sheet ${item.sheetIndex + 1}`}${item.kept === undefined ? '' : ` (kept ${item.kept})`}${item.omitted === undefined ? '' : ` (omitted ${item.omitted})`}`;

function renderTable(table: DisclosedTable): string[] {
  const lines = [`Table: ${table.sheetName ?? `Sheet ${table.sheetIndex + 1}`}`, `Rows: ${table.rowCount}${table.rowCountExact ? '' : '+'}; columns: ${table.columnCount}; header: ${table.hasHeader ? 'yes' : 'no'}`];
  for (const column of table.columns) {
    const stats = column.stats === null ? 'none' : JSON.stringify(column.stats);
    lines.push(`Column ${column.position + 1}: ${cleanCell(column.name)} | type=${column.inferredType} | confidence=${column.typeConfidence} | nulls=${column.nullCount} | blanks=${column.blankCount} | distinct=${column.distinctCount ?? 'high-cardinality'} | stats=${stats}`);
  }
  if (table.sampleRows.length > 0) {
    lines.push('Sample rows:');
    lines.push(table.columns.map((column) => cleanCell(column.name)).join(' | '));
    lines.push(...table.sampleRows.map((row) => row.map(cleanCell).join(' | ')));
  }
  if (table.notes.length > 0) lines.push('Notes:', ...table.notes.map((note) => `- ${note.code}${note.column ? ` (${cleanCell(note.column)})` : ''}${note.count === undefined ? '' : `: ${note.count}`}`));
  if (table.omittedColumnCount > 0) lines.push(`Omitted columns: ${table.omittedColumnCount}`);
  return lines;
}

/**
 * Render bounded payloads as the exact deterministic text shown and sent.
 *
 * @param payloads Approved FEAT-104 payloads.
 * @returns Stable plain text with no locale- or clock-dependent values.
 * @example renderDisclosureText([payload]).startsWith('File 1:')
 */
export function renderDisclosureText(payloads: readonly DisclosurePayload[]): string {
  const lines: string[] = [];
  payloads.forEach((payload, index) => {
    if (index > 0) lines.push('');
    lines.push(`File ${index + 1}: ${payload.file.name}`, `Format: ${payload.file.format}; size: ${payload.file.byteSize} bytes; sha256: ${payload.file.sha256}`, `Encoding: ${payload.file.encoding ?? 'not applicable'}`);
    payload.tables.forEach((table, tableIndex) => { if (tableIndex > 0) lines.push(''); lines.push(...renderTable(table)); });
    lines.push(payload.truncations.length === 0 ? 'Omissions: none.' : `Omissions: ${payload.truncations.map(truncationText).join('; ')}.`);
  });
  return lines.join('\n');
}
