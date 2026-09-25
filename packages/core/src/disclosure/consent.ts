// A consent covers exactly one payload digest, one provider, and one model;
// widening it is a decision for a person, not a default.

/** The public, browser-safe consent fields used by the policy evaluator. */
export interface DisclosureConsentView {
  readonly id: number;
  readonly payloadDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly scopeContext: boolean;
  readonly scopeDiagnostics: boolean;
  readonly revokedAt: string | null;
}

/** Why an approval cannot authorize a requested transmission. */
export type ConsentStaleness = 'none' | 'digest' | 'model' | 'scope' | 'revoked';

/** What a caller needs authorization to transmit. */
export interface RequiredConsent {
  readonly payloadDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly kind: 'context' | 'diagnostics';
}

/**
 * Return the first policy reason a consent does not cover a transmission.
 *
 * @param consent Existing approval, or null when none exists.
 * @param required Exact recipient, payload, and scope being requested.
 * @returns `none` when covered, otherwise the highest-priority stale reason.
 * @example evaluateConsent(consent, required) === 'none'
 */
export function evaluateConsent(
  consent: DisclosureConsentView | null,
  required: RequiredConsent,
): ConsentStaleness {
  if (consent?.revokedAt) return 'revoked';
  if (!consent) return 'digest';
  if (consent.provider !== required.provider || consent.model !== required.model) return 'model';
  if (consent.payloadDigest !== required.payloadDigest) return 'digest';
  const granted = required.kind === 'context' ? consent.scopeContext : consent.scopeDiagnostics;
  return granted ? 'none' : 'scope';
}
