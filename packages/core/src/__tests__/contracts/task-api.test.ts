import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CreateTaskRequestSchema } from '../../contracts/task-api';

describe('CreateTaskRequestSchema uploadIds', () => {
  const check = (uploadIds?: unknown) =>
    Value.Check(CreateTaskRequestSchema, uploadIds === undefined ? { prompt: 'go' } : { prompt: 'go', uploadIds });

  it('accepts an absent list, an empty list, and five ids', () => {
    expect(check()).toBe(true);
    expect(check([])).toBe(true);
    expect(check([1, 2, 3, 4, 5])).toBe(true);
  });

  it.each([
    ['six ids', [1, 2, 3, 4, 5, 6]],
    ['a duplicate id', [1, 1]],
    ['a negative id', [-1]],
    ['a zero id', [0]],
    ['a non-integer', [1.5]],
    ['a string id', ['1']],
    ['a non-array', 1],
  ])('rejects %s', (_label, uploadIds) => expect(check(uploadIds)).toBe(false));

  it('still requires a non-blank prompt', () => {
    expect(Value.Check(CreateTaskRequestSchema, { uploadIds: [1] })).toBe(false);
    expect(Value.Check(CreateTaskRequestSchema, { prompt: '   ', uploadIds: [1] })).toBe(false);
  });
});
