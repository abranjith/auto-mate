import { afterEach, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { HealthResponseSchema, ValidationError } from '@automate/core';
import pino from 'pino';
import type { Server } from 'node:http';
import { createApp } from '../app';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function request(path: string, getSchemaVersion = () => '1', headers?: HeadersInit) {
  const app = createApp({ logger: pino({ level: 'silent' }), dataRoot: '/private/root', version: '0.1.0', getSchemaVersion,
    configureRoutes: (router) => {
      router.get('/api/validation-test', () => { throw new ValidationError('Invalid request.'); });
      router.get('/api/unknown-test', () => { throw new Error('Secret /private/root'); });
    },
  });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe('HTTP application', () => {
  it('returns a schema-valid health response', async () => {
    const { response, body } = await request('/api/health');
    expect(response.status).toBe(200);
    expect(Value.Check(HealthResponseSchema, body)).toBe(true);
  });
  it('reports degraded health when metadata fails', async () => {
    const { body } = await request('/api/health', () => { throw new Error('database unavailable'); });
    expect(body).toMatchObject({ status: 'degraded', database: { connected: false, schemaVersion: 'unknown' } });
  });
  it('maps validation errors and preserves an incoming correlation id', async () => {
    const { response, body } = await request('/api/validation-test', () => '1', { 'x-correlation-id': 'client-123' });
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', correlationId: 'client-123' } });
    expect(response.headers.get('x-correlation-id')).toBe('client-123');
  });
  it('hides unknown error details and returns its generated correlation id', async () => {
    const { response, body } = await request('/api/unknown-test');
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
    expect(JSON.stringify(body)).not.toMatch(/Secret|private|stack/);
    expect((body.error as { correlationId: string }).correlationId).toBe(response.headers.get('x-correlation-id'));
  });
  it('returns a consistent not-found envelope', async () => {
    const { response, body } = await request('/api/nope');
    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
