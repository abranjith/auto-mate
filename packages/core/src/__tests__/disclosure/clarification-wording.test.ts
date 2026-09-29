import { describe, expect, it } from 'vitest';
import { answerKind, answerText, CLARIFICATION_STYLE_RULES, FOLLOW_UP_GUIDANCE } from '../../disclosure/clarification-wording';

const options = [{ value: 'single_html', label: 'A single web page' }];
const question = { answer: 'single_html', answerSource: 'user' as const, options };

describe('clarification wording', () => {
  it('keeps shared question rules plain and free of technical syntax', () => {
    expect(CLARIFICATION_STYLE_RULES).toMatch(/plain/);
    expect(CLARIFICATION_STYLE_RULES).toMatch(/not a programmer/);
    // The tool's required identifier is the sole exception to the prose rule.
    expect(CLARIFICATION_STYLE_RULES.replace('request_clarification', '')).not.toMatch(new RegExp('[`/_]'));
    expect(FOLLOW_UP_GUIDANCE).toContain('followUpOf');
  });
  it('identifies exact choices and displays their labels', () => {
    expect(answerKind(question)).toBe('choice');
    expect(answerText(question)).toBe('A single web page');
    expect(answerKind({ ...question, answer: 'Single_html' })).toBe('own_words');
    expect(answerText({ ...question, answer: 'Single_html' })).toBe('Single_html');
  });
  it('identifies typed, carried, default, and unanswered values', () => {
    expect(answerKind({ ...question, answer: 'My own answer' })).toBe('own_words');
    expect(answerKind({ ...question, options: null })).toBe('own_words');
    expect(answerKind({ ...question, answerSource: 'default' })).toBe('default');
    expect(answerKind({ ...question, answerSource: 'seeded' })).toBe('seeded');
    expect(answerKind({ ...question, answer: null })).toBeNull();
    expect(answerText({ ...question, answer: null })).toBeNull();
  });
});
