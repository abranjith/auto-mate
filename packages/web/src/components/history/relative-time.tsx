/** Locale-aware relative time with a precise timestamp on hover. */
export function RelativeTime({ at }: { at: string }) {
  const minutes = Math.round((Date.parse(at) - Date.now()) / 60_000);
  const abs = Math.abs(minutes);
  const unit = abs < 60 ? 'minute' : abs < 1_440 ? 'hour' : 'day';
  const value = unit === 'minute' ? minutes : unit === 'hour' ? Math.round(minutes / 60) : Math.round(minutes / 1_440);
  return <time dateTime={at} title={new Date(at).toLocaleString()}>{new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit)}</time>;
}
