import { expect, it, vi } from 'vitest';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import { getHealth } from '../../api/api-client';

const payload = { status: 'ok', version: '0.1.0', uptimeSeconds: 1, database: { connected: true, schemaVersion: '1' }, dataRoot: '/tmp/automate' };

it('returns schema-validated data and sends a correlation id', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
  expect(await getHealth(fetcher)).toEqual(payload);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/health');
  expect(fetcher.mock.calls[0]?.[1].headers['x-correlation-id']).toBeTruthy();
});

it('decodes a server error with its code and correlation id', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Bad input.', correlationId: 'abc' } }), { status: 400 }));
  await expect(getHealth(fetcher)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', correlationId: 'abc' });
});

it('distinguishes connection errors and does not surface raw response bodies', async () => {
  await expect(getHealth(vi.fn().mockRejectedValue(new Error('socket secret')))).rejects.toMatchObject({ code: ERROR_CODES.CONNECTION_ERROR });
  const fetcher = vi.fn().mockResolvedValue(new Response('raw secret', { status: 500 }));
  try { await getHealth(fetcher); } catch (cause) {
    expect(cause).toBeInstanceOf(AutoMateError);
    expect((cause as Error).message).not.toContain('raw secret');
  }
});
