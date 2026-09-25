// An approval covers exactly one code digest, one runtime fingerprint, and one
// displayed intent; widening it is a decision for a person, not a default.
// Deliberately the same contract shape as FEAT-105's `evaluateConsent`, so the
// two gates explain themselves in the same words.

/** The stored approval fields the evaluator reads. */
export interface ApprovalView {
  readonly contentDigest: string;
  readonly runtimeFingerprint: string;
  readonly intentDigest: string;
  readonly decision: 'approved' | 'cancelled';
}

/** What a run needs authorization for. */
export interface RequiredApproval {
  readonly contentDigest: string;
  readonly runtimeFingerprint: string;
  readonly intentDigest: string;
}

/** Why an approval does not cover a run; `none` means it does. */
export type ApprovalStaleness = 'none' | 'digest' | 'runtime' | 'intent' | 'cancelled';

/**
 * Return the first reason an approval does not cover a run.
 *
 * @param approval The stored decision, or null when none exists.
 * @param required The exact code, runtime, and intent about to run.
 * @returns `none` when covered; otherwise `cancelled` first, then `digest`, `runtime`, `intent`. A missing approval is `digest`.
 * @example evaluateApproval(approval, required) === 'none'
 */
export function evaluateApproval(approval: ApprovalView | null, required: RequiredApproval): ApprovalStaleness {
  if (approval?.decision === 'cancelled') return 'cancelled';
  if (!approval) return 'digest';
  if (approval.contentDigest !== required.contentDigest) return 'digest';
  if (approval.runtimeFingerprint !== required.runtimeFingerprint) return 'runtime';
  if (approval.intentDigest !== required.intentDigest) return 'intent';
  return 'none';
}
