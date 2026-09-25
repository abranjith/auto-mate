import { describe, expect, it } from 'vitest';
import { canonicalStringify, evaluateConsent } from '../../disclosure/index';

describe('canonical disclosure consent', () => {
  it('sorts nested object keys while preserving arrays, unicode, null, and omission semantics', () => {
    const left = { z: [{ b: 'é', a: null }], ignored: undefined, a: 1 };
    const right = { a: 1, z: [{ a: null, b: 'é' }] };
    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
    expect(canonicalStringify(left)).toBe('{"a":1,"z":[{"a":null,"b":"é"}]}');
  });

  it('handles a thousand keys and rejects cycles', () => {
    expect(canonicalStringify(Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`k${index}`, index])))).toContain('"k999":999');
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(/circular/i);
  });

  it('evaluates revoked, model, digest, and scope mismatch in policy order', () => {
    const consent = { id: 1, payloadDigest: 'a', provider: 'p', model: 'm', scopeContext: true, scopeDiagnostics: false, revokedAt: null };
    expect(evaluateConsent(consent, { payloadDigest: 'a', provider: 'p', model: 'm', kind: 'context' })).toBe('none');
    expect(evaluateConsent(consent, { payloadDigest: 'b', provider: 'p', model: 'm', kind: 'context' })).toBe('digest');
    expect(evaluateConsent(consent, { payloadDigest: 'a', provider: 'p', model: 'new', kind: 'context' })).toBe('model');
    expect(evaluateConsent(consent, { payloadDigest: 'a', provider: 'p', model: 'm', kind: 'diagnostics' })).toBe('scope');
    expect(evaluateConsent({ ...consent, revokedAt: 'now' }, { payloadDigest: 'b', provider: 'x', model: 'x', kind: 'diagnostics' })).toBe('revoked');
  });
});
