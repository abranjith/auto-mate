// Verification barrel (FEAT-107): the only module routes and the composition root import.
export { createVerificationStack } from './verification-stack';
export type { VerificationStack, VerificationStackDependencies } from './verification-stack';
export { VerificationService } from './verification-service';
export type { VerificationServiceDependencies, VerifyOptions } from './verification-service';
export { RunIntentService } from './run-intent-service';
export { ApprovalService } from './approval-service';
export { ReviewService } from './review-service';
export { ExecutionStateWriter } from './execution-state-writer';
export { UvRuntimeProbe, PROBE_SCRIPT } from './runtime-probe';
export type { RuntimeProbe, ProbedRuntime } from './runtime-probe';
export { VerifyEnvironment, VERIFICATION_TOOL_SET, renderBanditConfig, renderBanditIni } from './verify-env';
export { presentVerification } from './presenters';
