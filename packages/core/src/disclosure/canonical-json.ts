/**
 * Serialize JSON-compatible data deterministically.
 *
 * Object keys are sorted, array order is preserved, object properties whose
 * value is `undefined` are omitted, and numbers use JSON's finite-number rule.
 *
 * @param value JSON-compatible input.
 * @returns Canonical JSON with no insignificant whitespace.
 * @example canonicalStringify({ b: 2, a: 1 }) // '{"a":1,"b":2}'
 */
export function canonicalStringify(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) throw new TypeError('Canonical JSON cannot contain circular references.');
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => entry === undefined ? null : normalize(entry));
      const source = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source)
          .sort()
          .filter((key) => source[key] !== undefined)
          .map((key) => [key, normalize(source[key])]),
      );
    } finally {
      seen.delete(item);
    }
  };
  const result = JSON.stringify(normalize(value));
  if (result === undefined) throw new TypeError('Canonical JSON requires a serializable root value.');
  return result;
}
