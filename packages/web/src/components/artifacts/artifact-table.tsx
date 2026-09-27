// The paged table for CSV and workbook artifacts (FEAT-109 TASK-009). Pages are
// read on the server, so a very large file never becomes a very large fetch.
// Every cell renders as literal text: a leading =, +, -, or @ displays as
// itself, FEAT-104's rule carried to generated output. When the registrar
// counted formula-like cells, one line says how many and that Excel will treat
// them as formulas — the application states it and never rewrites the file.

import { useEffect, useState } from 'react';
import { DEFAULT_TABLE_PAGE_ROWS, type ArtifactView, type TablePage } from '@automate/core';
import { getTablePage } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';
import { looksLikeFormula } from '../ingestion/sample-rows-table';

/** One cell of generated output: a text node only, formula-looking cells marked. */
function Cell({ value }: { value: string }) {
  return looksLikeFormula(value) ? <span className={ds.formulaLike} title="Shown as text. It is not run as a formula.">{value}</span> : <>{value}</>;
}

/** The formula notice: information, not protection. */
export function formulaNotice(artifact: Pick<ArtifactView, 'contentScan'>): string | null {
  const scan = artifact.contentScan;
  if (!scan || scan.formulaCellCount === 0) return null;
  const cells = `${scan.formulaCellCount.toLocaleString('en-US')} cell${scan.formulaCellCount === 1 ? '' : 's'}`;
  const where = scan.rowsAreCapped ? ` in the first ${scan.scannedRows.toLocaleString('en-US')} rows` : '';
  return `${cells}${where} start with =, +, -, or @. Excel will treat ${scan.formulaCellCount === 1 ? 'it' : 'them'} as formulas when you open the file. ${scan.formulaCellCount === 1 ? 'It is' : 'They are'} shown here as plain text, and the file itself has not been changed.`;
}

export function ArtifactTable({ artifact, pageSize = DEFAULT_TABLE_PAGE_ROWS, load = getTablePage }: { artifact: ArtifactView; pageSize?: number; load?: typeof getTablePage }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<TablePage>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setError(undefined);
    load(artifact.id, offset, pageSize).then((result) => { if (live) setPage(result); }, (cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : 'This table could not be shown.'); });
    return () => { live = false; };
  }, [artifact.id, offset, pageSize, load]);
  const notice = formulaNotice(artifact);
  if (error) return <p className={ds.statusDanger} role="alert">{error}</p>;
  if (!page) return <p className={ds.statusMuted}>Loading the table…</p>;
  return (
    <div className={ds.stackTight}>
      {notice ? <p className={ds.formulaNotice}>{notice}</p> : null}
      {page.otherSheets.length > 0 ? <p className={ds.hint}>Showing the first sheet{page.sheet ? <>, “{page.sheet}”</> : null}. The file also has: {page.otherSheets.join(', ')}. Download it to see those.</p> : null}
      <div className={ds.tableScroll}>
        <table className={ds.dataTable}>
          <thead className={ds.tableHead}>
            <tr>{page.columns.map((column, index) => <th key={index} scope="col" className={ds.tableHeaderCell}><Cell value={column} /></th>)}</tr>
          </thead>
          <tbody>
            {page.rows.map((row, rowIndex) => (
              <tr key={page.offset + rowIndex}>{row.map((cell, index) => <td key={index} className={ds.tableCell}><Cell value={cell} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.truncatedCellCount > 0 ? <p className={ds.hint}>Long cells are cut at 200 characters here; the file has them in full.</p> : null}
      {page.scannedRowsCapped ? <p className={ds.hint}>The preview stops after this many rows. Download the file to see the rest.</p> : null}
      <div className={ds.tablePager}>
        <button type="button" className={ds.btnSmall} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
        <span>{page.rows.length === 0 ? 'No rows here' : `Rows ${(page.offset + 1).toLocaleString('en-US')}–${(page.offset + page.rows.length).toLocaleString('en-US')}`}</span>
        <button type="button" className={ds.btnSmall} disabled={!page.hasMore} onClick={() => setOffset(offset + pageSize)}>Next</button>
      </div>
    </div>
  );
}
