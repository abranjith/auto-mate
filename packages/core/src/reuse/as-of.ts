import { Type, type Static } from '@sinclair/typebox';
import { ValidationError } from '../errors/index';

export const AS_OF_ENV_NAMES = ['AUTOMATE_AS_OF', 'AUTOMATE_AS_OF_DATE', 'AUTOMATE_TIMEZONE'] as const;
export const AsOfSchema = Type.Object({ at: Type.Integer(), date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), timeZone: Type.String(), source: Type.Union([Type.Literal('now'), Type.Literal('chosen'), Type.Literal('copied')]) }, { additionalProperties: false });
export type AsOf = Static<typeof AsOfSchema>;

/** Validate a time zone using the platform's IANA database.
 * @param zone IANA time zone name or UTC.
 * @returns Whether the runtime accepts the zone.
 * @example isSupportedTimeZone('Europe/London')
 */
export function isSupportedTimeZone(zone: string): boolean {
  if (zone === 'UTC' || Intl.supportedValuesOf('timeZone').includes(zone)) return true;
  // ICU lists canonical names (often Asia/Calcutta) but accepts aliases such as Asia/Kolkata.
  try { return Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone.length > 0; }
  catch { return false; }
}

function parts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const values = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const read = (name: string) => Number(values.find((value) => value.type === name)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') };
}

function localDate(ms: number, zone: string): string {
  const { year, month, day } = parts(ms, zone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function zoneOffset(ms: number, zone: string): number {
  const value = parts(ms, zone);
  const localAsUtc = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  return Math.round((localAsUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

function localMidnightUtc(date: string, zone: string): number {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day);
  let instant = localAsUtc - zoneOffset(localAsUtc, zone) * 60_000;
  instant = localAsUtc - zoneOffset(instant, zone) * 60_000;
  return instant;
}

/** Resolve a run's calendar date and instant in a named zone.
 * @param options Current epoch milliseconds, time zone, and optional chosen date.
 * @returns The pinned instant, calendar date, zone, and source.
 * @example resolveAsOf({ nowMs: Date.now(), timeZone: 'UTC' })
 */
export function resolveAsOf({ nowMs, timeZone, chosenDate }: { readonly nowMs: number; readonly timeZone: string; readonly chosenDate?: string | null }): AsOf {
  if (!isSupportedTimeZone(timeZone)) throw new ValidationError(`Unsupported time zone: ${timeZone}.`);
  if (!Number.isFinite(nowMs)) throw new ValidationError('The current time is invalid.');
  const today = localDate(nowMs, timeZone);
  if (!chosenDate) return { at: Math.floor(nowMs / 1000), date: today, timeZone, source: 'now' };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(chosenDate);
  if (!match || new Date(`${chosenDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== chosenDate || chosenDate > today)
    throw new ValidationError('Choose a real date that is not in the future.');
  const [year, month, day] = match.slice(1).map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
  const at = Math.floor(localMidnightUtc(next, timeZone) / 1000) - 1;
  return { at, date: chosenDate, timeZone, source: 'chosen' };
}

/** Environment entries passed unchanged to Python processes.
 * @param asOf The run's pinned date and instant.
 * @returns The three AUTOMATE_AS_OF environment entries.
 * @example asOfEnvironment(resolveAsOf({ nowMs: Date.now(), timeZone: 'UTC' }))
 */
export function asOfEnvironment(asOf: AsOf): Record<(typeof AS_OF_ENV_NAMES)[number], string> {
  const offset = zoneOffset(asOf.at * 1000, asOf.timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const suffix = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const p = parts(asOf.at * 1000, asOf.timeZone);
  const time = [p.hour, p.minute, p.second].map((n) => String(n).padStart(2, '0')).join(':');
  return { AUTOMATE_AS_OF: `${asOf.date}T${time}${suffix}`, AUTOMATE_AS_OF_DATE: asOf.date, AUTOMATE_TIMEZONE: asOf.timeZone };
}
