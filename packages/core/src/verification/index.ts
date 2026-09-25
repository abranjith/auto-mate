// Verification barrel (FEAT-107). Pure, browser-safe logic only: no Node
// built-ins, no I/O, no provider SDK.
export { VERIFICATION_TIMEOUT_MS, LINT_TIMEOUT_MS, SECURITY_TIMEOUT_MS, MAX_RUN_OUTPUT_BYTES, MAX_REVIEW_FEEDBACK_CHARS, MAX_FINDINGS_PER_CHECK } from './limits';
export { CHECK_KEYS, CHECK_STATUSES, FINDING_SEVERITIES, FINDING_CONFIDENCES, VERIFICATION_STATUSES, summarizeVerification } from './verification';
export type { CheckKey, CheckStatus, FindingSeverity, FindingConfidence, VerificationStatus, VerificationFindingView, VerificationCheckView, VerificationRunView } from './verification';
export { BLOCKING_CHECK_KEYS, BLOCKING_RUFF_RULE_PREFIXES, BLOCKING_RUFF_RULE_CODES, BLOCKING_BANDIT_SEVERITY, BLOCKING_BANDIT_CONFIDENCE, isBlockingFinding, isBlockingCheck, decideGate } from './gate-policy';
export type { PolicyFinding, PolicyCheck, GateDecision } from './gate-policy';
export { computeRuntimeFingerprint, describeRuntimeChange, describeRuntime, normalizeRuntimeDetail } from './runtime-fingerprint';
export type { RuntimeDetail, RuntimePackage } from './runtime-fingerprint';
export { RUN_INTENT_CAVEATS, buildIntentDigest } from './run-intent';
export type { RunIntent, RunIntentInput, RunIntentOutput, RunIntentCheck } from './run-intent';
export { evaluateApproval } from './approval';
export type { ApprovalView, RequiredApproval, ApprovalStaleness } from './approval';
export { parseOutputManifest, reconcileOutputs, isPlainFilename } from './manifest';
export type { OutputManifest, ManifestEntry, OutputReconciliation } from './manifest';
export { REVIEW_VERDICTS, feedbackProblem } from './review';
export type { ReviewVerdict, ReviewDecision } from './review';
