import { describe, expect, it } from 'vitest';
import { AutoMateError } from '../../errors/automate-error';
import { TaskHasOpenRunError } from '../../errors/history-errors';

describe('TaskHasOpenRunError', () => {
  it('gives a safe, actionable public error', () => {
    const error = new TaskHasOpenRunError(7, 'awaiting_approval');
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error.code).toBe('TASK_HAS_OPEN_RUN');
    expect(error.message).toContain('Finish or cancel');
    expect(JSON.stringify(error.toJSON())).not.toMatch(/stack|details/);
  });
});
