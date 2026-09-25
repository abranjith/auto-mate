import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  ClarificationAnswerRequestSchema,
  ClarificationSchema,
  ConsentResponseSchema,
  DisclosureAckSchema,
  DisclosurePreviewResponseSchema,
  PreflightDecisionSchema,
  TransmissionReceiptSchema,
} from '../../contracts/disclosure-api';
import { AutoMateError } from '../../errors/automate-error';
import {
  ClarificationInvalidAnswerError,
  ClarificationLimitReachedError,
  ClarificationNotFoundError,
  ClarificationNotPendingError,
  DisclosureConsentRequiredError,
  DisclosureConsentStaleError,
  DisclosureScopeNotGrantedError,
  PreflightDecisionRequiredError,
  WaitingCapacityReachedError,
} from '../../errors/disclosure-errors';

describe('disclosure wire contracts and errors', () => {
  it('round-trips representative API values without changing them', () => {
    const digest = 'a'.repeat(64);
    const cases: readonly [object, unknown][] = [
      [DisclosureAckSchema, { consentId: 1, payloadDigest: digest }],
      [PreflightDecisionSchema, { findingKey: '0:date:kind', choice: 'DD/MM' }],
      [DisclosurePreviewResponseSchema, { uploadIds: [1], text: 'shown', digest, byteSize: 5, provider: 'fake', model: 'model', truncations: [], required: [], defaults: [], notices: [] }],
      [ConsentResponseSchema, { id: 1, payloadDigest: digest, provider: 'fake', model: 'model', byteSize: 5, scopeContext: true, scopeDiagnostics: false, grantedAt: '2026-01-01T00:00:00.000Z' }],
      [TransmissionReceiptSchema, { id: 1, executionId: 1, consentId: 1, kind: 'context', payloadDigest: digest, payloadSnapshot: null, byteSize: 5, summary: {}, provider: 'fake', model: 'model', at: '2026-01-01T00:00:00.000Z' }],
      [ClarificationSchema, { id: 1, executionId: 1, source: 'agent', callId: 'call-1', status: 'pending', declineReason: null, askedAt: '2026-01-01T00:00:00.000Z', settledAt: null, questions: [] }],
      [ClarificationAnswerRequestSchema, { answers: [{ questionId: 1, value: 'answer' }] }],
    ];
    for (const [schema, value] of cases) {
      expect(Value.Check(schema as never, value)).toBe(true);
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it('keeps every disclosure failure typed, stable-coded, and stack-free on the wire', () => {
    const errors = [
      new DisclosureConsentRequiredError(),
      new DisclosureConsentStaleError('old', 'model-a', 'new', 'model-b'),
      new DisclosureScopeNotGrantedError('diagnostics'),
      new PreflightDecisionRequiredError(['Date format']),
      new ClarificationNotFoundError(1),
      new ClarificationNotPendingError(1),
      new ClarificationInvalidAnswerError('Choose an offered value.'),
      new ClarificationLimitReachedError(3),
      new WaitingCapacityReachedError(5),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(AutoMateError);
      expect(error.code).toMatch(/^[A-Z_]+$/);
      expect(error.toJSON()).toEqual({ error: { code: error.code, message: error.message } });
      expect(JSON.stringify(error.toJSON())).not.toContain('stack');
    }
    expect(errors[1]?.message).toContain('model-a');
    expect(errors[1]?.message).toContain('model-b');
  });
});
