import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@automate/core';
import { getVerificationConfig } from '../../config/env';

describe('getVerificationConfig', () => {
  it('uses the provisional D14 defaults', () => {
    expect(getVerificationConfig({})).toEqual({ verificationTimeoutMs: 300_000, lintTimeoutMs: 60_000, securityTimeoutMs: 120_000, scriptRunTimeoutMs: 900_000, maxRunOutputBytes: 1_048_576, maxReviewFeedbackChars: 2_000 });
  });
  it('reads every override', () => {
    expect(getVerificationConfig({ AUTOMATE_VERIFICATION_TIMEOUT_MS: '1000', AUTOMATE_LINT_TIMEOUT_MS: '2000', AUTOMATE_SECURITY_TIMEOUT_MS: '3000', AUTOMATE_SCRIPT_RUN_TIMEOUT_MS: '4000', AUTOMATE_MAX_RUN_OUTPUT_BYTES: '5000', AUTOMATE_MAX_REVIEW_FEEDBACK_CHARS: '600' })).toEqual({ verificationTimeoutMs: 1000, lintTimeoutMs: 2000, securityTimeoutMs: 3000, scriptRunTimeoutMs: 4000, maxRunOutputBytes: 5000, maxReviewFeedbackChars: 600 });
  });
  it.each([['AUTOMATE_VERIFICATION_TIMEOUT_MS', '0'], ['AUTOMATE_LINT_TIMEOUT_MS', 'soon'], ['AUTOMATE_MAX_RUN_OUTPUT_BYTES', '-1'], ['AUTOMATE_MAX_REVIEW_FEEDBACK_CHARS', '2001']])('rejects %s=%s by name', (name, value) => {
    expect(() => getVerificationConfig({ [name]: value })).toThrow(ConfigurationError);
    expect(() => getVerificationConfig({ [name]: value })).toThrow(name);
  });
});
