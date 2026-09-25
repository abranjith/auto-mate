import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Server } from 'node:http';
import { createApp } from '../app';
import type { RuntimeProvisioner } from '../execution/runtime-provisioner';
import type { ServerConfig } from '../config/env';
import { createTempStore, type TempStore } from './support/ingestion-fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function served() {
  const store: TempStore = createTempStore('automate-runtime-route-');
  cleanup.push(async () => store.dispose());
  const config: ServerConfig = { host: '127.0.0.1', port: 0, logLevel: 'silent', maxConcurrentExecutions: 1, allowedOrigins: [], nodeEnv: 'test' };
  let ready = false;
  const environment = { kind: 'script' as const, status: 'ready' as const, pythonVersion: '3.14.6', uvVersion: 'uv 0.11.32', fingerprint: 'f'.repeat(64), lockDigest: 'l'.repeat(12), packageCount: 1, packages: [{ name: 'pytest', version: '9.1.1' }], preparedAt: '2026-09-25T00:00:00Z', failureReason: null };
  const ensureRuntime = vi.fn(async () => { ready = true; return { row: {} as never, prepared: true }; });
  const provisioner = { getReadiness: (kind: string) => kind === 'script' && ready ? { ready: true, environment, reason: null } : { ready: false, environment: null, reason: 'Not prepared.' }, ensureRuntime } as unknown as RuntimeProvisioner;
  const app = createApp({ logger: pino({ level: 'silent' }), dataRoot: store.root, version: 'test', paths: store.paths, getSchemaVersion: () => '7', serverConfig: config, runtime: { provisioner, platform: 'win32' } });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP address');
  config.port = address.port;
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, route: string, body?: unknown, origin?: string) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text() };
  };
  return { store, call, ensureRuntime };
}

describe('runtime routes', () => {
  it('reports both kinds and platform capabilities without exposing the data root', async () => {
    const { store, call } = await served();
    const before = await call('GET', '/api/runtime');
    expect(before.status).toBe(200);
    expect(before.text).toContain('No memory limit is enforced on Windows.');
    expect(before.text).not.toContain(store.root);
    const prepared = await call('POST', '/api/runtime/prepare', { kind: 'script' });
    expect(prepared.status).toBe(200);
    expect(prepared.text).toContain('3.14.6');
    expect(prepared.text).not.toContain(store.root);
  });

  it('rejects a foreign origin and malformed body before preparation', async () => {
    const { store, call, ensureRuntime } = await served();
    const rejected = await call('POST', '/api/runtime/prepare', { kind: 'script' }, 'https://example.com');
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.text).toContain('ORIGIN_REJECTED');
    expect(rejected.text).not.toContain(store.root);
    const malformed = await call('POST', '/api/runtime/prepare', { kind: 'other' });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(ensureRuntime).not.toHaveBeenCalled();
  });
});
