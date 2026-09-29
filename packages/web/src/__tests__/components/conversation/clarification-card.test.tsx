import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clarification } from '@automate/core';
import { ClarificationCard } from '../../../components/conversation/clarification-card';

afterEach(cleanup);
const pending: Clarification = { id: 1, executionId: 2, source: 'agent', callId: 'c', status: 'pending', declineReason: null, askedAt: 'now', settledAt: null, questions: [{ id: 3, position: 0, findingKey: null, impact: 'meaning', promptText: '<img src=x onerror=alert(1)> Which?', rationale: 'It changes the result.', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], proposedDefault: 'a', answer: null, answerSource: null, answerKind: null, followUpOfQuestionId: null, answeredAt: null }] };

describe('ClarificationCard', () => {
  it('renders model output as text and submits the complete batch once', async () => {
    const user = userEvent.setup();
    const answer = vi.fn().mockResolvedValue({ ...pending, status: 'answered' });
    const { container } = render(<ClarificationCard clarification={pending} onAnswer={answer} />);
    expect(screen.getByText(/<img src=x/).textContent).toContain('<img');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/ignored.*use:.*a/i)).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'A' }));
    await user.click(screen.getByRole('button', { name: /send answers/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith(1, { answers: [{ questionId: 3, value: 'a' }] }));
  });

  it('labels seeded answers and explains declined defaults', () => {
    const { rerender } = render(<ClarificationCard clarification={{ ...pending, status: 'answered', settledAt: 'later', questions: [{ ...pending.questions[0]!, answer: 'b', answerSource: 'seeded', answerKind: 'seeded', answeredAt: 'later' }] }} />);
    expect(screen.getByText(/carried over/)).toBeTruthy();
    rerender(<ClarificationCard clarification={{ ...pending, status: 'declined', declineReason: 'question_limit', settledAt: 'later' }} />);
    expect(screen.getByText(/question limit.*used: a/i)).toBeTruthy();
  });

  it('lets the person type an answer and switch back to an offered choice', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue({ ...pending, status: 'answered' });
    render(<ClarificationCard clarification={pending} onAnswer={onAnswer} />);
    await user.click(screen.getByRole('radio', { name: 'Something else…' }));
    const input = screen.getByRole('textbox', { name: 'Your answer' });
    expect(screen.getByRole('button', { name: 'Send answers' }).hasAttribute('disabled')).toBe(true);
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: 'Send answers' }).hasAttribute('disabled')).toBe(true);
    await user.type(input, 'My own idea');
    await user.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledWith(1, { answers: [{ questionId: 3, value: 'My own idea' }] });
  });

  it('keeps option values named other distinct from the typed-answer control', async () => {
    const user = userEvent.setup();
    const withOther = { ...pending, questions: [{ ...pending.questions[0]!, options: [{ value: 'other', label: 'Other option' }, { value: 'something_else', label: 'Another option' }] }] };
    render(<ClarificationCard clarification={withOther} />);
    await user.click(screen.getByRole('radio', { name: 'Something else…' }));
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Other option' }));
    expect(screen.queryByRole('textbox', { name: 'Your answer' })).toBeNull();
  });

  it('posts once on a double click and enables retry after an error', async () => {
    const user = userEvent.setup();
    let reject!: (reason: Error) => void;
    const onAnswer = vi.fn().mockImplementationOnce(() => new Promise((_resolve, rejectAnswer) => { reject = rejectAnswer; })).mockResolvedValue({ ...pending, status: 'answered' });
    render(<ClarificationCard clarification={pending} onAnswer={onAnswer} />);
    await user.click(screen.getByRole('radio', { name: 'A' }));
    await user.dblClick(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    reject(new Error('Please try again.'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Please try again.'));
    await user.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it('shows readable settled answers and a follow-up lead-in', () => {
    const parent = { ...pending.questions[0]!, answer: 'a', answerSource: 'user' as const, answerKind: 'choice' as const, promptText: 'Which format?' };
    const child = { ...parent, id: 4, promptText: 'What should it include?', answer: 'A short summary', options: null, answerKind: 'own_words' as const, followUpOfQuestionId: parent.id };
    const settled = { ...pending, status: 'answered' as const, questions: [child] };
    const { rerender } = render(<ClarificationCard clarification={settled} questionById={new Map([[parent.id, parent]])} />);
    expect(screen.getByText(/Following up on “Which format\?” — you said “A”/)).toBeTruthy();
    expect(screen.getByText(/“A short summary” \(in your words\)/)).toBeTruthy();
    rerender(<ClarificationCard clarification={settled} questionById={new Map()} />);
    expect(screen.queryByText(/Following up/)).toBeNull();
  });
});
