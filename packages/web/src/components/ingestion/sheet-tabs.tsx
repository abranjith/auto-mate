import type { TableProfile } from '@automate/core';
import { ds } from '../../design-system/tokens';

/** Switch between a workbook's sheets. Hidden sheets are profiled too, and marked. */
export function SheetTabs({
  profiles,
  selected,
  panelId,
  onSelect,
}: {
  profiles: readonly TableProfile[];
  selected: number;
  panelId: string;
  onSelect: (index: number) => void;
}) {
  return (
    <div className={ds.tabList} role="tablist" aria-label="Sheets">
      {profiles.map((profile, index) => (
        <button
          key={profile.sheetIndex}
          type="button"
          role="tab"
          aria-selected={index === selected}
          aria-controls={panelId}
          className={index === selected ? ds.tabActive : ds.tab}
          onClick={() => onSelect(index)}
        >
          {profile.sheetName ?? `Sheet ${profile.sheetIndex + 1}`}
          {profile.isHidden ? ' (hidden)' : ''}
        </button>
      ))}
    </div>
  );
}
