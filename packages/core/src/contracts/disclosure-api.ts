import { Type, type Static } from '@sinclair/typebox';
import { MAX_ANSWER_CHARS, MAX_QUESTION_OPTIONS } from '../disclosure/limits';

const Id = Type.Integer({ minimum: 1 });
const NullableDate = Type.Union([Type.String(), Type.Null()]);
export const FindingOptionSchema = Type.Object({ value: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) });
export const PreflightDecisionSchema = Type.Object({ findingKey: Type.String({ minLength: 1 }), choice: Type.String({ minLength: 1 }) });
export const DisclosureAckSchema = Type.Object({ consentId: Id, payloadDigest: Type.String({ pattern: '^[0-9a-f]{64}$' }) });
export const DisclosureFindingSchema = Type.Object({ findingKey: Type.String(), impact: Type.Union([Type.Literal('data_loss'), Type.Literal('meaning')]), question: Type.String(), rationale: Type.String(), options: Type.Array(FindingOptionSchema, { maxItems: MAX_QUESTION_OPTIONS }), proposedDefault: Type.String() });
export const AppliedDefaultSchema = Type.Object({ findingKey: Type.String(), label: Type.String(), value: Type.String(), options: Type.Optional(Type.Array(FindingOptionSchema, { maxItems: MAX_QUESTION_OPTIONS })), demoted: Type.Boolean() });
export const DisclosurePreviewResponseSchema = Type.Object({ uploadIds: Type.Array(Id), text: Type.String(), digest: Type.String({ pattern: '^[0-9a-f]{64}$' }), byteSize: Type.Integer({ minimum: 0 }), provider: Type.String(), model: Type.String(), truncations: Type.Array(Type.String()), required: Type.Array(DisclosureFindingSchema), defaults: Type.Array(AppliedDefaultSchema), notices: Type.Array(Type.Object({ findingKey: Type.String(), text: Type.String() })) });
export const GrantConsentRequestSchema = Type.Object({ uploadIds: Type.Array(Id, { minItems: 1, uniqueItems: true }), payloadDigest: Type.String({ pattern: '^[0-9a-f]{64}$' }), scopeDiagnostics: Type.Boolean() });
export const ConsentResponseSchema = Type.Object({ id: Id, payloadDigest: Type.String({ pattern: '^[0-9a-f]{64}$' }), provider: Type.String(), model: Type.String(), byteSize: Type.Integer({ minimum: 0 }), scopeContext: Type.Boolean(), scopeDiagnostics: Type.Boolean(), grantedAt: Type.String() });
export const TransmissionReceiptSchema = Type.Object({ id: Id, executionId: Id, consentId: Id, kind: Type.Union([Type.Literal('context'), Type.Literal('diagnostics')]), payloadDigest: Type.String(), payloadSnapshot: Type.Union([Type.String(), Type.Null()]), byteSize: Type.Integer({ minimum: 0 }), summary: Type.Unknown(), provider: Type.String(), model: Type.String(), at: Type.String() });
export const ClarificationQuestionSchema = Type.Object({ id: Id, position: Type.Integer({ minimum: 0 }), findingKey: Type.Union([Type.String(), Type.Null()]), impact: Type.Union([Type.Literal('data_loss'), Type.Literal('meaning')]), promptText: Type.String(), rationale: Type.String(), options: Type.Union([Type.Array(FindingOptionSchema, { maxItems: MAX_QUESTION_OPTIONS }), Type.Null()]), proposedDefault: Type.String(), answer: Type.Union([Type.String(), Type.Null()]), answerSource: Type.Union([Type.Literal('user'), Type.Literal('default'), Type.Literal('seeded'), Type.Null()]), answeredAt: NullableDate });
export const ClarificationSchema = Type.Object({ id: Id, executionId: Id, source: Type.Union([Type.Literal('preflight'), Type.Literal('agent')]), callId: Type.Union([Type.String(), Type.Null()]), status: Type.Union([Type.Literal('pending'), Type.Literal('answered'), Type.Literal('declined'), Type.Literal('cancelled'), Type.Literal('interrupted')]), declineReason: Type.Union([Type.Literal('question_limit'), Type.Literal('waiting_capacity'), Type.Null()]), askedAt: Type.String(), settledAt: NullableDate, questions: Type.Array(ClarificationQuestionSchema) });
export const ClarificationAnswerRequestSchema = Type.Object({ answers: Type.Array(Type.Object({ questionId: Id, value: Type.String({ minLength: 1, maxLength: MAX_ANSWER_CHARS }) }), { minItems: 1 }) });
export const ClarificationListResponseSchema = Type.Object({ clarifications: Type.Array(ClarificationSchema) });
export const DisclosureReceiptResponseSchema = Type.Object({ transmissions: Type.Array(TransmissionReceiptSchema) });

export type DisclosurePreviewResponse = Static<typeof DisclosurePreviewResponseSchema>;
export type GrantConsentRequest = Static<typeof GrantConsentRequestSchema>;
export type ConsentResponse = Static<typeof ConsentResponseSchema>;
export type TransmissionReceipt = Static<typeof TransmissionReceiptSchema>;
export type Clarification = Static<typeof ClarificationSchema>;
export type ClarificationQuestion = Static<typeof ClarificationQuestionSchema>;
export type ClarificationAnswerRequest = Static<typeof ClarificationAnswerRequestSchema>;
export type PreflightDecision = Static<typeof PreflightDecisionSchema>;
