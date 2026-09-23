import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../errors/error-codes';
import { ValidationError } from '../../errors/index';
import {
  EXECUTION_STATUSES,
  TRANSITIONS,
  applyTransition,
  canTransition,
  isTerminal,
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

  it('keeps terminal and future feature states absorbing', () => {
    expect(EXECUTION_STATUSES.filter(isTerminal)).toEqual([
      'completed',
      'failed',
      'aborted',
    ]);
    expect(TRANSITIONS.verifying).toEqual([]);
    expect(TRANSITIONS.executing).toEqual([]);
    expect(TRANSITIONS.waiting).toEqual([]);
  });
});
