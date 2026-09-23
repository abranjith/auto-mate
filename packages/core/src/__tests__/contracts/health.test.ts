import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorSchema, HealthResponseSchema } from '../../contracts/health';

describe('shared HTTP contracts', () => {
  const valid = { status: 'ok', version: '0.1.0', uptimeSeconds: 2, database: { connected: true, schemaVersion: '1' }, dataRoot: '/tmp/automate' };
  it('accepts a valid health response', () => expect(Value.Check(HealthResponseSchema, valid)).toBe(true));
  it('rejects unknown status', () => expect(Value.Check(HealthResponseSchema, { ...valid, status: 'broken' })).toBe(false));
  it('rejects missing schema version', () => expect(Value.Check(HealthResponseSchema, { ...valid, database: { connected: true } })).toBe(false));
  it('accepts errors with and without a correlation id', () => {
    expect(Value.Check(ApiErrorSchema, { error: { code: 'X', message: 'Oops' } })).toBe(true);
    expect(Value.Check(ApiErrorSchema, { error: { code: 'X', message: 'Oops', correlationId: 'cid' } })).toBe(true);
  });
});
