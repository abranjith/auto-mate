import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../errors/error-codes';
import { ValidationError } from '../../errors/index';
import {
  EXECUTION_STATUSES,
  TRANSITIONS,
  applyTransition,
  canTransition,
  isTerminal,
  consumesConcurrencySlot,
  survivesRestart,
  PARKED_STATUSES,
  TERMINAL_STATUSES,
} from '../../conversation/execution-state';

describe('execution state machine', () => {
  it('covers the complete status matrix', () => {
    let cases = 0;
    for (const from of EXECUTION_STATUSES)
      for (const to of EXECUTION_STATUSES) {
        expect(canTransition(from, to)).toBe(TRANSITIONS[from].includes(to));
        cases += 1;
      }
    expect(cases).toBe(EXECUTION_STATUSES.length ** 2);
  });

  it('applies legal changes and describes illegal ones', () => {
    expect(applyTransition('pending', 'generating')).toBe('generating');
    expect(() => applyTransition('completed', 'completed')).toThrow(
      ValidationError,
    );
    try {
      applyTransition('completed', 'generating');
    } catch (error) {
      expect(error).toMatchObject({
        code: ERROR_CODES.INVALID_STATE_TRANSITION,
      });
      expect((error as Error).message).toContain('completed');
      expect((error as Error).message).toContain('generating');
    }
  });

  it('keeps the four terminal states absorbing, including self-transitions', () => {
    expect(EXECUTION_STATUSES.filter(isTerminal)).toEqual(['completed', 'failed', 'aborted', 'rejected']);
    for (const terminal of TERMINAL_STATUSES) {
      expect(TRANSITIONS[terminal]).toEqual([]);
      for (const to of EXECUTION_STATUSES) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it('permits exactly the FEAT-107 gate edges', () => {
    expect(TRANSITIONS.generating).toEqual(['waiting', 'verifying', 'completed', 'failed', 'aborted']);
    expect(TRANSITIONS.verifying).toEqual(['awaiting_approval', 'failed', 'aborted']);
    expect(TRANSITIONS.awaiting_approval).toEqual(['executing', 'verifying', 'aborted']);
    expect(TRANSITIONS.awaiting_review).toEqual(['completed', 'rejected', 'aborted']);
    expect(TRANSITIONS.waiting).toEqual(['generating', 'failed', 'aborted']);
    expect(canTransition('verifying', 'executing')).toBe(false);
    expect(canTransition('executing', 'completed')).toBe(false);
    expect(canTransition('awaiting_approval', 'completed')).toBe(false);
  });

  it('names both ends of a rejected gate edge', () => {
    try {
      applyTransition('awaiting_review', 'executing');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ code: ERROR_CODES.INVALID_STATE_TRANSITION });
      expect((error as Error).message).toBe('Execution cannot transition from awaiting_review to executing.');
    }
  });

  it('FEAT-108: executing leads only to review, failure, or abort — changing this is deliberate', () => {
    expect(TRANSITIONS.executing).toEqual(['awaiting_review', 'failed', 'aborted']);
  });

  it('frees the concurrency slot for every parked status', () => {
    for (const status of PARKED_STATUSES) expect(consumesConcurrencySlot(status)).toBe(false);
    for (const status of ['pending', 'generating', 'verifying', 'executing'] as const) expect(consumesConcurrencySlot(status)).toBe(true);
    for (const status of TERMINAL_STATUSES) expect(consumesConcurrencySlot(status)).toBe(false);
  });

  it('lets only the two approval and review gates survive a restart', () => {
    expect(EXECUTION_STATUSES.filter(survivesRestart)).toEqual(['awaiting_approval', 'awaiting_review']);
  });
});
