import type { InferredType } from '../contracts/upload-api';

export type TypeCompatibility = 'same' | 'advisory' | 'blocking';

/** Every declared/found pair is deliberate; adding a profiler type requires updating this table. */
export const TYPE_COMPATIBILITY: Readonly<Record<InferredType, Readonly<Record<InferredType, TypeCompatibility>>>> = {
  integer: { integer: 'same', decimal: 'advisory', boolean: 'advisory', date: 'blocking', datetime: 'blocking', string: 'blocking', empty: 'advisory' },
  decimal: { integer: 'advisory', decimal: 'same', boolean: 'blocking', date: 'blocking', datetime: 'blocking', string: 'blocking', empty: 'advisory' },
  boolean: { integer: 'advisory', decimal: 'blocking', boolean: 'same', date: 'blocking', datetime: 'blocking', string: 'blocking', empty: 'advisory' },
  date: { integer: 'blocking', decimal: 'blocking', boolean: 'blocking', date: 'same', datetime: 'advisory', string: 'blocking', empty: 'advisory' },
  datetime: { integer: 'blocking', decimal: 'blocking', boolean: 'blocking', date: 'advisory', datetime: 'same', string: 'blocking', empty: 'advisory' },
  string: { integer: 'advisory', decimal: 'advisory', boolean: 'advisory', date: 'advisory', datetime: 'advisory', string: 'same', empty: 'advisory' },
  empty: { integer: 'advisory', decimal: 'advisory', boolean: 'advisory', date: 'advisory', datetime: 'advisory', string: 'advisory', empty: 'same' },
};

/** Compare a declared column type to a newly profiled column type.
 * @param declared Type the accepted code declared or previously saw.
 * @param found Type inferred from the new file.
 * @returns Whether the pair is equal, advisory, or blocking.
 * @example compareColumnType('integer', 'decimal')
 */
export function compareColumnType(declared: InferredType, found: InferredType): TypeCompatibility {
  return TYPE_COMPATIBILITY[declared][found];
}
