import { describe, expect, it } from 'vitest';
import { AutoMateError } from './automate-error';
import { ConfigurationError, RepositoryError, ValidationError } from './index';
import { ERROR_CODES } from './error-codes';

describe('application errors', () => {
  it('preserves code and Error inheritance', () => {
    const error = new AutoMateError('EXAMPLE', 'A clear message');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('EXAMPLE');
  });
  it.each([
    [new ValidationError('bad'), ERROR_CODES.VALIDATION_ERROR],
    [new ConfigurationError('bad'), ERROR_CODES.CONFIGURATION_ERROR],
    [new RepositoryError('bad'), ERROR_CODES.REPOSITORY_ERROR],
  ])('subclass %s has its own code', (error, code) => {
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error.code).toBe(code);
  });
  it('omits stack and private details from JSON', () => {
    const error = new AutoMateError('EXAMPLE', 'Safe', { path: '/secret' }, 'cid-1');
    expect(error.toJSON()).toEqual({ error: { code: 'EXAMPLE', message: 'Safe', correlationId: 'cid-1' } });
    expect(JSON.stringify(error)).not.toContain('/secret');
    expect(JSON.stringify(error)).not.toContain('stack');
  });
});
