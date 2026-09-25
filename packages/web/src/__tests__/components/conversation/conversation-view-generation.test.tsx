import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationEvent, ExecutionSummary } from '@automate/core';
import { ConversationView } from '../../../components/conversation/conversation-view';
import { elidedLabel } from '../../../components/conversation/tool-call-card';
import { GenerationSection, isGenerationRun } from '../../../components/generation/generation-section';

beforeAll(() => import('../../../components/conversation/assistant-message'), 30_000);
afterEach(cleanup);
const at = '2026-09-24T00:00:00.000Z';
const digest = 'f'.repeat(64);
const events: ConversationEvent[] = [
  { seq: 1, type: 'user_prompt', text: 'Total by region', at },
  { seq: 2, type: 'tool_started', callId: 'w1', tool: 'write_script', input: { path: 'main.py', content: { elided: true, byteSize: 4198 } }, at },
  { seq: 3, type: 'tool_finished', callId: 'w1', tool: 'write_script', output: { path: 'main.py' }, isError: false, at },
  { seq: 4, type: 'code_version_sealed', codeVersionId: 1, attempt: 1, digest, files: [{ path: 'main.py', role: 'script', byteSize: 4198, lineCount: 84 }], at },
  { seq: 5, type: 'assistant_text', text: 'Running the tests now.', at },
  { seq: 6, type: 'test_run_finished', attemptId: 1, attempt: 1, outcome: 'failed', refusalReason: null, testsTotal: 3, testsPassed: 2, testsFailed: 1, droppedLineCount: 0, attemptsRemaining: 2, attemptLimit: 3, manifestPresent: false, at },
  { seq: 7, type: 'assistant_text', text: 'Fixing the column name.', at },
  { seq: 8, type: 'generation_settled', outcome: 'finalized', codeVersionId: 1, digest, attemptsUsed: 1, attemptLimit: 3, summary: 'Chose attempt 1 <img src=x onerror=alert(1)>', at },
];

describe('ConversationView with generation events', () => {
  it('renders the three generation kinds in seq order, with a test result between two assistant messages', async () => {
    const { container } = render(<ConversationView events={[...events].reverse()} />);
    await screen.findByText('Running the tests now.');
    await screen.findByText('Fixing the column name.');
    const text = container.textContent ?? '';
    const order = ['Attempt 1 — 1 file, 84 lines', 'Running the tests now.', 'Attempt 1: 1 of 3 tests failed.', 'Fixing the column name.', 'Chose attempt 1'];
    const positions = order.map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders the generation summary as literal text', () => {
    const { container } = render(<ConversationView events={events.slice(-1)} />);
    expect(screen.getByText(/Chose attempt 1 <img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows an elided tool argument as a size, not as an empty object', async () => {
    const user = userEvent.setup();
    render(<ConversationView events={events.slice(1, 3)} />);
    await user.click(screen.getByText(/write_script — finished/));
    expect(screen.getByText(/"content": "wrote 4.1 KiB"/)).toBeTruthy();
    expect(elidedLabel(512)).toBe('wrote 512 bytes');
  });
});

describe('GenerationSection', () => {
  const base: ExecutionSummary = { id: 2, taskId: 1, status: 'generating', provider: 'fake', model: 'fake', usage: {}, startedAt: at, completedAt: null, durationMs: null, error: null, createdAt: at };
  const loadAttempts = vi.fn().mockResolvedValue({ attempts: [], limits: { maxAttempts: 3, timeoutMs: 600_000 } });

  it('does nothing for a text-only run', () => {
    const { container } = render(<GenerationSection execution={base} events={events.slice(0, 1)} loadAttempts={loadAttempts} />);
    expect(container.textContent).toBe('');
    expect(isGenerationRun([{ seq: 1, type: 'disclosure_sent', transmissionId: 1, kind: 'context', provider: 'fake', model: 'fake', byteSize: 1, summary: {}, at }])).toBe(true);
  });

  it('shows progress with the attempt cap while a generation run is active', async () => {
    render(<GenerationSection execution={base} events={events.slice(0, 4)} loadAttempts={loadAttempts} />);
    expect(await screen.findByText('Attempt 1 of 3')).toBeTruthy();
  });

  it('offers the guidance retry once a generation run has failed', async () => {
    const failed = { ...base, status: 'failed' as const, error: { code: 'GENERATION_ATTEMPTS_EXHAUSTED', message: 'Used all 3.' } };
    render(<GenerationSection execution={failed} events={[...events.slice(0, 7), { ...events[7]!, outcome: 'exhausted', summary: 'Used all 3 attempts without getting the tests to pass.' } as ConversationEvent]} loadAttempts={loadAttempts} />);
    await waitFor(() => expect(screen.getByText('Tell me what I got wrong and I\'ll try again.')).toBeTruthy());
    expect(screen.getByText('Used all 3 attempts without getting the tests to pass.')).toBeTruthy();
  });

  it('shows neither progress nor retry for a completed run', () => {
    const { container } = render(<GenerationSection execution={{ ...base, status: 'completed' }} events={events} loadAttempts={loadAttempts} />);
    expect(container.textContent).toBe('');
  });
});
