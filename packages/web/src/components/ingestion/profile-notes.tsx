import type { ReactNode } from 'react';
import type { ProfileNote } from '@automate/core';
import { ds } from '../../design-system/tokens';

const count = (value: number | undefined) => (value ?? 0).toLocaleString('en-US');
const Name = ({ children }: { children: ReactNode }) => <code className={ds.inlineCode}>{children}</code>;

/**
 * Put one structured finding into plain English with a concrete next step.
 * Column names are rendered as text inside `<code>`; nothing here is markup from the file.
 */
export function noteText(note: ProfileNote): ReactNode {
  switch (note.code) {
    case 'ambiguous_date_format':
      return (
        <>
          Dates in <Name>{note.column}</Name> could be day/month or month/day ({note.formats?.join(' or ')}). We will ask before interpreting them.
        </>
      );
    case 'mixed_type_column':
      return (
        <>
          <Name>{note.column}</Name> has {count(note.count)} values that do not match the rest of the column. They will be pointed out rather than guessed at.
        </>
      );
    case 'duplicate_headers_renamed':
      return <>Some column names repeat, so {count(note.count)} were renamed ({note.columns?.join(', ')}). The original names are kept beside them.</>;
    case 'no_header_detected':
      return <>No header row was found, so the columns are named column_1, column_2, and so on. If the first row holds names, say so in your task description.</>;
    case 'row_cap_reached':
      return <>Only the first {count(note.limit)} rows were scanned, so the row count is a minimum.</>;
    case 'leading_blank_rows_skipped':
      return <>{count(note.count)} title or blank rows above the table were skipped.</>;
    case 'ragged_rows':
      return <>{count(note.count)} rows have a different number of values from the rest — often a total or footer row.</>;
    case 'blank_rows':
      return <>{count(note.count)} blank rows were found and not counted as data.</>;
    case 'encoding_guessed':
      return <>The text encoding was guessed as {note.formats?.[0]}. If accented letters look wrong, save the file as UTF-8 and attach it again.</>;
    case 'hidden_sheet':
      return <>This sheet is hidden in the workbook.</>;
    case 'empty_sheet':
      return <>This sheet has no table.</>;
    case 'sheet_cap_reached':
      return <>Only the first {count(note.limit)} of {count(note.count)} sheets were read.</>;
    case 'merged_cells':
      return <>{count(note.count)} merged cells were found — this sheet may be a formatted report rather than a plain table.</>;
    case 'formula_cells':
      return <>{count(note.count)} cells hold formulas; their last saved results were used.</>;
  }
}

/** The findings a profile recorded instead of silently resolving. */
export function ProfileNotes({ notes }: { notes: readonly ProfileNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className={ds.noteList} aria-label="Things to know about this table">
      {notes.map((note, index) => (
        <li key={`${note.code}-${index}`} className={ds.noteItem}>
          {noteText(note)}
        </li>
      ))}
    </ul>
  );
}
