import { useId, useState } from 'react';
import { formatBytes, type TableProfile, type UploadResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { ColumnTable } from './column-table';
import { ProfileNotes } from './profile-notes';
import { SampleRowsTable } from './sample-rows-table';
import { SheetTabs } from './sheet-tabs';

/** A row count as a person should read it: a capped count is never presented as a real one. */
export function rowsText(profile: TableProfile): string {
  const rows = profile.rowCount.toLocaleString('en-US');
  if (!profile.rowCountExact) return `${rows}+ rows (scan limit reached)`;
  return `${rows} ${profile.rowCount === 1 ? 'row' : 'rows'}`;
}

function TableDetails({ profile }: { profile: TableProfile }) {
  return (
    <div className={ds.stack}>
      <p className={ds.hint}>
        {rowsText(profile)} · {profile.columnCount.toLocaleString('en-US')} {profile.columnCount === 1 ? 'column' : 'columns'}
      </p>
      <ProfileNotes notes={profile.notes} />
      {profile.columns.length > 0 ? <ColumnTable columns={profile.columns} /> : null}
      {profile.rowCount > 0 ? (
        <SampleRowsTable columns={profile.columns} rows={profile.sampleRows} />
      ) : (
        <p className={ds.statusMuted}>
          {profile.columns.length > 0 ? 'This table has column names but no data rows yet.' : 'There is no table on this sheet.'}
        </p>
      )}
    </div>
  );
}

/**
 * What the application understood about one attached file: its tables, column
 * types, statistics, sample rows, and findings. Everything was computed
 * locally; this panel is not the disclosure review (FEAT-105) and sends nothing.
 */
export function ProfilePanel({ upload }: { upload: UploadResponse }) {
  const [selected, setSelected] = useState(0);
  const panelId = useId();
  const { profiles } = upload;
  const profile = profiles[selected] ?? profiles[0];
  const sheets = upload.upload.format === 'xlsx' ? ` · ${profiles.length} ${profiles.length === 1 ? 'sheet' : 'sheets'}` : '';
  return (
    <section className={ds.profilePanel} aria-label={`What was found in ${upload.upload.originalFilename}`}>
      <p className={ds.localNotice}>Everything shown here was computed on this computer. Nothing has been sent anywhere.</p>
      <p className={ds.hint}>
        {upload.upload.format.toUpperCase()} · {formatBytes(upload.upload.byteSize)}
        {sheets}
      </p>
      {profiles.length > 1 ? <SheetTabs profiles={profiles} selected={selected} panelId={panelId} onSelect={setSelected} /> : null}
      <div id={panelId} role={profiles.length > 1 ? 'tabpanel' : undefined}>
        {profile ? <TableDetails profile={profile} /> : <p className={ds.statusMuted}>No table was found in this file.</p>}
      </div>
    </section>
  );
}
