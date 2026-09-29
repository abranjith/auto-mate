import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CLARIFICATION_STYLE_RULES } from '@automate/core';
import { ClarificationToolParameters, createClarificationTool } from '../../disclosure/clarification-tool';
import type { ClarificationService } from '../../disclosure/clarification-service';

const question = { question: 'What time?', rationale: 'Time changes the result.', impact: 'meaning', proposedDefault: 'Noon' };

describe('request_clarification tool', () => {
  it('allows only positive integer parent ids and includes the shared wording', () => {
    expect(Value.Check(ClarificationToolParameters, { questions: [{ ...question, followUpOf: 1 }] })).toBe(true);
    for (const followUpOf of [0, -1, 1.5, '1']) expect(Value.Check(ClarificationToolParameters, { questions: [{ ...question, followUpOf }] })).toBe(false);
    expect(createClarificationTool({} as ClarificationService).description).toContain(CLARIFICATION_STYLE_RULES);
  });
});
