import { describe, expect, it } from 'vitest';
import { AutoMateError } from './automate-error';
import {
  ExecutionInterruptedError,
  ExecutionLimitReachedError,
  ExecutionNotFoundError,
  ExecutionNotRunningError,
  TaskNotFoundError,
} from './conversation-errors';

describe('conversation errors', () => {
  it('serialize only their stable public fields', () => {
    for (const error of [
      new TaskNotFoundError(1),
      new ExecutionNotFoundError(2),
      new ExecutionNotRunningError(3),
      new ExecutionInterruptedError(4),
      new ExecutionLimitReachedError(),
    ]) {
      expect(error).toBeInstanceOf(AutoMateError);
      expect(error.toJSON()).toEqual({
        error: { code: error.code, message: error.message },
      });
      expect(JSON.stringify(error.toJSON())).not.toContain('stack');
      expect(JSON.stringify(error.toJSON())).not.toContain('details');
    }
  });
});
