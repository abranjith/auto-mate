import { Type } from '@sinclair/typebox';
import { MAX_AGENT_CLARIFICATIONS, MAX_QUESTION_OPTIONS, type AgentToolDefinition } from '@automate/core';
import type { ClarificationService } from './clarification-service';

export const ClarificationToolParameters = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ minLength: 1 }),
    rationale: Type.String({ minLength: 1 }),
    impact: Type.Union([Type.Literal('data_loss'), Type.Literal('meaning')]),
    options: Type.Optional(Type.Array(Type.Object({ value: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) }), { minItems: 1, maxItems: MAX_QUESTION_OPTIONS })),
    proposedDefault: Type.String({ minLength: 1 }),
  }), { minItems: 1, maxItems: MAX_AGENT_CLARIFICATIONS }),
});

/** Build the one application-owned clarification tool for a provider session. */
export function createClarificationTool(service: ClarificationService): AgentToolDefinition<typeof ClarificationToolParameters> {
  return {
    name: 'request_clarification',
    description: 'Ask the person only when ambiguity changes meaning or risks data loss. Include a rationale and the default to use if the application declines.',
    parameters: ClarificationToolParameters,
    execute: (args, context) => service.ask(Number(context.executionId), context.callId, args.questions.map((question) => ({ impact: question.impact, promptText: question.question, rationale: question.rationale, options: question.options ?? null, proposedDefault: question.proposedDefault }))),
  };
}
