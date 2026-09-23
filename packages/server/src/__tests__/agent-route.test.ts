import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  AgentAuthUnavailableError, AgentConfigResponseSchema, ConnectionTestResponseSchema, DEFAULT_AGENT_CONFIG,
  ERROR_CODES, ProviderCatalogResponseSchema,
} from '@automate/core';
import pino from 'pino';
import { createApp } from '../app';
import { AgentConfigStore, runAgentSmoke, type AgentSmokeOptions, type AgentSmokeReport, type ProviderCatalogEntry } from '../agent/index';
import { StubPiSession } from '../agent/adapters/pi/testing/stub-pi-session';
import { ensureAppDirectories, getAppPaths, type AppPaths } from '../config/app-paths';

/** Anything that must never appear in an API response. */
const KEY_SHAPES = /sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+|"(?:apiKey|api_key|token|secret)"\s*:/i;

const logger = pino({ level: 'silent' });
const servers: Server[] = [];
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A catalog entry stub, the shape the probe would return. */
function entry(patch: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry {
  return {
    id: 'anthropic', label: 'Anthropic', credentialAvailable: true, credentialSource: 'managed',
    models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }, { id: 'claude-opus-5', label: 'Claude Opus 5' }],
    ...patch,
  };
}

/** A completed smoke report stub. */
function report(patch: Partial<AgentSmokeReport> = {}): AgentSmokeReport {
  return {
    sessionId: 'session-1',
    logPath: '/data/agent-sessions/connection-test/session-1.jsonl',
    result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } },
    events: [
      { type: 'tool_started', callId: 'c1', tool: 'status', input: {}, at: '2026-09-22T12:00:00.000Z' },
      { type: 'tool_finished', callId: 'c1', tool: 'status', output: 'ok', isError: false, at: '2026-09-22T12:00:01.000Z' },
      { type: 'assistant_text', text: 'The runtime is healthy.', at: '2026-09-22T12:00:02.000Z' },
    ],
    statusToolInvoked: true,
    authSource: 'managed',
    environment: { agentDir: '/data/pi', authPath: '/data/pi/auth.json', modelsPath: '/data/pi/models.json', sessionStagingDir: '/data/pi/sessions', settingsSource: 'in-memory', systemPrompt: 'prompt', appendSystemPrompt: [], extensions: [], skills: [], prompts: [], themes: [], contextFiles: [] },
    promptVersion: 'agent-smoke-v1',
    ...patch,
  };
}

/** Boot the app against a temp data root, with the probe and smoke runner stubbed. */
async function boot(overrides: {
  providers?: ProviderCatalogEntry[];
  smoke?: (options: AgentSmokeOptions) => Promise<AgentSmokeReport>;
} = {}): Promise<{ paths: AppPaths; store: AgentConfigStore; url: string }> {
  const root = mkdtempSync(join(tmpdir(), 'automate-route-'));
  temporary.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  const store = new AgentConfigStore({ paths, logger });
  const app = createApp({
    logger, dataRoot: paths.root, version: '0.1.0', paths, getSchemaVersion: () => '1',
    agent: {
      configStore: store,
      probe: () => Promise.resolve(overrides.providers ?? [entry()]),
      runSmoke: overrides.smoke ?? (() => Promise.resolve(report())),
    },
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return { paths, store, url: `http://127.0.0.1:${address.port}` };
}

/** Issue one request and return the status, body, and correlation id. */
async function call(url: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, { headers: { 'content-type': 'application/json' }, ...init });
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, never> & { error: Record<string, string> };
  return { status: response.status, body, text, correlationId: response.headers.get('x-correlation-id') };
}

describe('GET /api/agent/config', () => {
  it('returns 200 with a schema-valid body', async () => {
    const { url } = await boot();
    const { status, body } = await call(url, '/api/agent/config');
    expect(status).toBe(200);
    expect(Value.Check(AgentConfigResponseSchema, body)).toBe(true);
    expect(body).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });
  it('contains no key-shaped string', async () => {
    const { url } = await boot();
    expect((await call(url, '/api/agent/config')).text).not.toMatch(KEY_SHAPES);
  });
  it('reflects a saved selection', async () => {
    const { url, store } = await boot();
    store.save({ ...DEFAULT_AGENT_CONFIG, model: 'claude-opus-5' });
    expect((await call(url, '/api/agent/config')).body).toMatchObject({ model: 'claude-opus-5' });
  });
});

describe('PUT /api/agent/config', () => {
  const put = (url: string, payload: unknown) => call(url, '/api/agent/config', { method: 'PUT', body: JSON.stringify(payload) });
  const valid = { provider: 'anthropic', model: 'claude-opus-5', thinking: 'high', auth: { mode: 'managed' } };

  it('persists a valid body and returns it with a fresh updatedAt', async () => {
    const { url, store } = await boot();
    const { status, body } = await put(url, valid);
    expect(status).toBe(200);
    expect(body).toMatchObject({ model: 'claude-opus-5', version: 1 });
    expect(body.updatedAt).not.toBe(DEFAULT_AGENT_CONFIG.updatedAt);
    expect(store.load().model).toBe('claude-opus-5');
  });
  it('returns 400 with AGENT_MODEL_NOT_FOUND and lists the known ids', async () => {
    const { url } = await boot();
    const { status, body } = await put(url, { ...valid, model: 'nope' });
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: ERROR_CODES.AGENT_MODEL_NOT_FOUND });
    expect(String(body.error.message)).toContain('claude-sonnet-5');
  });
  it('returns 400 with AGENT_CONFIG_INVALID for a personal-pi path that does not exist', async () => {
    const { url } = await boot();
    const { status, body } = await put(url, { ...valid, auth: { mode: 'personal-pi', authPath: join(tmpdir(), 'no-such-auth.json') } });
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: ERROR_CODES.AGENT_CONFIG_INVALID });
    expect(String(body.error.message)).toMatch(/does not exist/);
  });
  it('accepts a personal-pi path that does exist', async () => {
    const { url, paths } = await boot();
    const personal = join(paths.root, 'personal-auth.json');
    writeFileSync(personal, '{}');
    const { status, body } = await put(url, { ...valid, auth: { mode: 'personal-pi', authPath: personal } });
    expect(status).toBe(200);
    expect(body.auth).toEqual({ mode: 'personal-pi', authPath: personal });
  });
  it.each([
    ['an unknown field', { ...valid, apiKey: 'sk-ant-secret' }],
    ['managed with an authPath', { ...valid, auth: { mode: 'managed', authPath: '/x' } }],
    ['personal-pi without an authPath', { ...valid, auth: { mode: 'personal-pi' } }],
    ['an empty model', { ...valid, model: '' }],
    ['a client-supplied updatedAt', { ...valid, updatedAt: '2026-01-01T00:00:00.000Z' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, payload) => {
    const { url } = await boot();
    const { status, body } = await put(url, payload);
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });
  it('carries a correlation id in the error envelope', async () => {
    const { url } = await boot();
    const { body, correlationId } = await put(url, { ...valid, model: '' });
    expect(body.error.correlationId).toBe(correlationId);
    expect(String(body.error.correlationId)).toHaveLength(36);
  });
});

describe('GET /api/agent/providers', () => {
  it('returns the catalog in a schema-valid envelope', async () => {
    const { url } = await boot({ providers: [entry(), entry({ id: 'openai', label: 'OpenAI', credentialAvailable: false, credentialSource: 'unavailable', models: [], remediation: 'Set OPENAI_API_KEY.' })] });
    const { status, body } = await call(url, '/api/agent/providers');
    expect(status).toBe(200);
    expect(Value.Check(ProviderCatalogResponseSchema, body)).toBe(true);
    expect((body.providers as unknown as ProviderCatalogEntry[]).map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
  });
  it('never returns a credential value', async () => {
    const { url } = await boot();
    expect((await call(url, '/api/agent/providers')).text).not.toMatch(KEY_SHAPES);
  });
});

describe('POST /api/agent/test-connection', () => {
  const post = (url: string) => call(url, '/api/agent/test-connection', { method: 'POST' });

  it('returns ok true with the event counts for a successful session', async () => {
    const { url } = await boot();
    const { status, body } = await post(url);
    expect(status).toBe(200);
    expect(Value.Check(ConnectionTestResponseSchema, body)).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.statusToolInvoked).toBe(true);
    expect(body.eventCounts).toEqual({ tool_started: 1, tool_finished: 1, assistant_text: 1 });
    expect(body.authSource).toBe('managed');
  });
  it('returns ok false with the typed code for an unresolvable credential', async () => {
    const { url } = await boot({ smoke: () => Promise.reject(new AgentAuthUnavailableError('anthropic', 'the managed credential store', 'Set ANTHROPIC_API_KEY.')) });
    const { status, body } = await post(url);
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: ERROR_CODES.AGENT_AUTH_UNAVAILABLE });
    expect(String(body.error.message)).toContain('ANTHROPIC_API_KEY');
  });
  it('returns ok false when the session runs but does not complete', async () => {
    const { url } = await boot({ smoke: () => Promise.resolve(report({ result: { outcome: 'failed', stopReason: 'error', usage: { turns: 1 } }, statusToolInvoked: false })) });
    const { body } = await post(url);
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: ERROR_CODES.AGENT_PROVIDER_UNAVAILABLE });
  });
  it('closes the session even when the run rejects', async () => {
    // The real runAgentSmoke runs here, backed by a stub SDK session whose
    // prompt rejects. Its `finally` must still dispose the session.
    const session = new StubPiSession([], () => Promise.reject(new Error('the provider dropped the connection')));
    const { url } = await boot({
      smoke: (options) => runAgentSmoke({
        ...options,
        overrides: {
          createSession: () => Promise.resolve({ session }),
          createModelRuntime: () => Promise.resolve({
            getProviderAuthStatus: () => ({ configured: true, source: 'stored' }),
            getModels: () => [{ id: 'claude-sonnet-5' }],
            getModel: () => ({ id: 'claude-sonnet-5' }),
          } as never),
        },
      }),
    });
    const { status, body } = await post(url);
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(session.disposeCount).toBe(1);
  });
  it('returns 500 with a correlation id for an unexpected failure', async () => {
    const { url } = await boot({ smoke: () => Promise.reject(new Error('an unexpected internal fault')) });
    const { status, body, correlationId } = await post(url);
    expect(status).toBe(500);
    expect(body.error).toMatchObject({ code: ERROR_CODES.INTERNAL_ERROR, correlationId });
    expect(String(body.error.message)).not.toContain('an unexpected internal fault');
  });
  it('never returns a credential value', async () => {
    const { url } = await boot();
    expect((await post(url)).text).not.toMatch(KEY_SHAPES);
  });
  it('uses the saved selection rather than anything in the request', async () => {
    const seen: string[] = [];
    const { url, store } = await boot({ smoke: (options) => { seen.push(options.model.id); return Promise.resolve(report()); } });
    store.save({ ...DEFAULT_AGENT_CONFIG, model: 'claude-opus-5' });
    const { body } = await post(url);
    expect(body.model).toBe('claude-opus-5');
    expect(seen).toEqual(['claude-opus-5']);
  });
});
