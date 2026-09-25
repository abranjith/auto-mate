import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clarification } from '@automate/core';
import { ClarificationCard } from '../../../components/conversation/clarification-card';

afterEach(cleanup);
const pending: Clarification = { id: 1, executionId: 2, source: 'agent', callId: 'c', status: 'pending', declineReason: null, askedAt: 'now', settledAt: null, questions: [{ id: 3, position: 0, findingKey: null, impact: 'meaning', promptText: '<img src=x onerror=alert(1)> Which?', rationale: 'It changes the result.', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], proposedDefault: 'a', answer: null, answerSource: null, answeredAt: null }] };

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
    const { rerender } = render(<ClarificationCard clarification={{ ...pending, status: 'answered', settledAt: 'later', questions: [{ ...pending.questions[0]!, answer: 'b', answerSource: 'seeded', answeredAt: 'later' }] }} />);
    expect(screen.getByText(/carried over/)).toBeTruthy();
    rerender(<ClarificationCard clarification={{ ...pending, status: 'declined', declineReason: 'question_limit', settledAt: 'later' }} />);
    expect(screen.getByText(/question limit.*used: a/i)).toBeTruthy();
  });
});
