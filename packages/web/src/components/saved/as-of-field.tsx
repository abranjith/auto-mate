import { useState } from 'react';
import { formatCalendarDate } from '@automate/core';
import { ds } from '../../design-system/tokens';

/** Pick a business date in the local time zone. */
export function AsOfField({ date, onChange, zone }: { date: string | null; onChange: (date: string | null) => void; zone: string }) {
  const [expanded, setExpanded] = useState(false);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (kind: string) => parts.find((item) => item.type === kind)?.value ?? '';
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  return <section className={ds.card}><h3>As-of date</h3><p>{date ? `Run as of ${formatCalendarDate(date)}` : `Run as of today (${formatCalendarDate(today)})`} · {zone}</p>
    <button type="button" className={ds.btnGhost} onClick={() => { setExpanded(!expanded); if (expanded) onChange(null); }}>Choose another date</button>
    {expanded ? <label className={ds.field}>Date<input type="date" className={ds.input} max={today} value={date ?? ''} onChange={(event) => onChange(event.target.value || null)} /></label> : null}
  </section>;
}
