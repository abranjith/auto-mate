import type { ClarificationQuestion } from '../contracts/disclosure-api';

/** Rules shared by every prompt that may ask a person a question. */
export const CLARIFICATION_STYLE_RULES = 'Ask through request_clarification only when ambiguity changes the meaning of the task or risks losing data; decide cosmetic details yourself using a stated default. Write every question, rationale, and option label in plain, everyday English for someone who is not a programmer: no code, file paths, variable names, internal identifiers, or technical jargon. Keep each question to one short sentence and each option label to a few words. Always include a rationale and a proposed default.';

/** Tell the agent when another question helps after an answer in the person's own words. */
export const FOLLOW_UP_GUIDANCE = "Some answers are in the person's own words. If one is unclear, contradicts itself or the task, or cannot work for this task, ask one short follow-up through request_clarification with followUpOf set to that questionId, in plain English, saying what you need. If an answer is clear, continue without restating it.";

/**
 * Describe how an answer was given without storing another database value.
 * @param question A question with its stored answer and available choices.
 * @returns The answer's source and form, or null when unanswered.
 * @example answerKind({ answer: 'yes', answerSource: 'user', options: [{ value: 'yes', label: 'Yes' }] }) // 'choice'
 */
export function answerKind(question: Pick<ClarificationQuestion, 'answer' | 'answerSource' | 'options'>): ClarificationQuestion['answerKind'] {
  if (question.answer === null || question.answerSource === null) return null;
  if (question.answerSource !== 'user') return question.answerSource;
  return question.options?.some(({ value }) => value === question.answer) ? 'choice' : 'own_words';
}

/**
 * Show a choice's readable label or the person's original answer.
 * @param question A question with its stored answer and available choices.
 * @returns Readable answer text, or null when unanswered.
 * @example answerText({ answer: 'yes', answerSource: 'user', options: [{ value: 'yes', label: 'Yes' }] }) // 'Yes'
 */
export function answerText(question: Pick<ClarificationQuestion, 'answer' | 'answerSource' | 'options'>): string | null {
  if (question.answer === null) return null;
  return answerKind(question) === 'choice' ? question.options?.find(({ value }) => value === question.answer)?.label ?? question.answer : question.answer;
}
