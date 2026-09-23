import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CreateAgentSessionOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AgentAuthUnavailableError, AgentModelNotFoundError, AgentSessionStartFailedError, type AgentEvent, type AgentSessionOptions } from '@automate/core';
import pino from 'pino';
import type { ModelRuntimeFactory } from './environment';
import { PiAgentProvider, type PiSessionFactory } from './provider';
import { StubPiSession, assistantMessage as assistant, rawEvent as raw } from './testing/stub-pi-session';

const logger = pino({ level: 'silent' });
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A runtime stub that knows one provider's models and reports one credential status. */
function stubRuntimeFactory(options: { models?: string[]; status?: { configured: boolean; source?: string } } = {}): ModelRuntimeFactory {
  const ids = options.models ?? ['claude-sonnet-5', 'claude-opus-5'];
  const status = options.status ?? { configured: true, source: 'stored' };
  const runtime = {
    getProviderAuthStatus: () => status,
    getModels: (provider?: string) => ids.map((id) => ({ id, provider: provider ?? 'anthropic' })),
    getModel: (_provider: string, id: string) => (ids.includes(id) ? { id, provider: 'anthropic' } : undefined),
  } as unknown as ModelRuntime;
  return () => Promise.resolve(runtime);
}

/** A provider wired entirely to stubs, plus the captured factory calls. */
function harness(overrides: {
  session?: StubPiSession;
  createSession?: PiSessionFactory;
  runtime?: ModelRuntimeFactory;
  customTools?: { name: string }[];
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-provider-'));
  temporary.push(root);
  const session = overrides.session ?? new StubPiSession();
  const sessionOptions: CreateAgentSessionOptions[] = [];
  const createSession: PiSessionFactory = overrides.createSession ?? ((options) => {
    sessionOptions.push(options);
    return Promise.resolve({ session });
  });
  const provider = new PiAgentProvider({
    piDir: path.join(root, 'pi'),
    modelsPath: path.join(root, 'pi', 'models.json'),
    sessionStagingDir: path.join(root, 'pi', 'sessions'),
    resolveAuthPath: () => path.join(root, 'pi', 'auth.json'),
    logger,
    createSession,
    createModelRuntime: overrides.runtime ?? stubRuntimeFactory(),
    ...(overrides.customTools !== undefined ? { customTools: overrides.customTools as never } : {}),
  });
  const open = (patch: Partial<AgentSessionOptions> = {}): Promise<import('@automate/core').AgentSession> => provider.open({
    executionId: 'exec-1',
    sessionDir: path.join(root, 'agent-sessions', 'exec-1'),
    cwd: root,
    model: { provider: 'anthropic', id: 'claude-sonnet-5', thinking: 'high' },
    auth: { mode: 'managed' },
    systemPrompt: 'The Auto-Mate system prompt.',
    ...patch,
  });
  return { root, session, sessionOptions, provider, open };
}

describe('PiAgentProvider.open', () => {
  it('returns a session carrying the SDK session id, the final log path, and the auth source', async () => {
    const { root, open } = harness();
    const session = await open();
    expect(session.id).toBe('session-stub-1');
    expect(session.logPath.startsWith(path.join(root, 'agent-sessions', 'exec-1'))).toBe(true);
    expect(session.authSource).toBe('managed');
    await session.close();
  });
  it('reports personal-pi as the auth source when that mode is configured', async () => {
    const { root, open } = harness();
    const session = await open({ auth: { mode: 'personal-pi', authPath: path.join(root, 'auth.json') } });
    expect(session.authSource).toBe('personal-pi');
    await session.close();
  });
  it('raises AgentAuthUnavailableError naming the sources tried', async () => {
    const { open } = harness({ runtime: stubRuntimeFactory({ status: { configured: false } }) });
    await expect(open()).rejects.toThrow(AgentAuthUnavailableError);
    await expect(open()).rejects.toThrow(/managed credential store/);
    await expect(open()).rejects.toThrow(/environment variable/);
    // A user-facing message names the source, never the host's directory layout.
    await expect(open()).rejects.not.toThrow(/[A-Za-z]:[\\/]|\/(?:home|Users|tmp)\//);
  });
  it('raises AgentModelNotFoundError listing the known ids', async () => {
    const { open } = harness();
    await expect(open({ model: { provider: 'anthropic', id: 'claude-nope' } })).rejects.toThrow(AgentModelNotFoundError);
    await expect(open({ model: { provider: 'anthropic', id: 'claude-nope' } })).rejects.toThrow(/claude-sonnet-5/);
  });
  it('says so plainly when a provider has no registered models at all', async () => {
    const { open } = harness({ runtime: stubRuntimeFactory({ models: [] }) });
    await expect(open({ model: { provider: 'anthropic', id: 'x' } })).rejects.toThrow(/No models are registered/);
  });
  it('raises AgentSessionStartFailedError for an unknown thinking level rather than dropping it', async () => {
    const { open } = harness();
    await expect(open({ model: { provider: 'anthropic', id: 'claude-sonnet-5', thinking: 'ultra' } })).rejects.toThrow(AgentSessionStartFailedError);
    await expect(open({ model: { provider: 'anthropic', id: 'claude-sonnet-5', thinking: 'ultra' } })).rejects.toThrow(/ultra/);
  });
  it('raises AgentSessionStartFailedError with a sanitized reason when the factory throws', async () => {
    const { open } = harness({ createSession: () => Promise.reject(new Error('refused at sk-ant-api03-AbCdEf0123456789XyZ')) });
    await expect(open()).rejects.toThrow(AgentSessionStartFailedError);
    await expect(open()).rejects.not.toThrow(/sk-ant-api03/);
  });
  it('disables every built-in tool and registers an empty allowlist when no custom tools are supplied', async () => {
    const { sessionOptions, open } = harness();
    await open();
    expect(sessionOptions[0]?.noTools).toBe('all');
    expect(sessionOptions[0]?.tools).toEqual([]);
    expect(sessionOptions[0]?.customTools).toEqual([]);
  });
  it('makes the allowlist exactly the supplied tool names', async () => {
    const { sessionOptions, open } = harness({ customTools: [{ name: 'status' }, { name: 'write_script' }] });
    await open();
    expect(sessionOptions[0]?.noTools).toBe('all');
    expect(sessionOptions[0]?.tools).toEqual(['status', 'write_script']);
  });
  it('passes the pinned runtime, session manager, settings, and resource loader to the SDK', async () => {
    const { sessionOptions, open } = harness();
    await open();
    const options = sessionOptions[0];
    expect(options?.modelRuntime).toBeDefined();
    expect(options?.sessionManager).toBeDefined();
    expect(options?.settingsManager).toBeDefined();
    expect(options?.resourceLoader).toBeDefined();
    expect(options?.thinkingLevel).toBe('high');
  });
  it('omits thinkingLevel entirely when none is configured', async () => {
    const { sessionOptions, open } = harness();
    await open({ model: { provider: 'anthropic', id: 'claude-sonnet-5' } });
    expect(sessionOptions[0] && 'thinkingLevel' in sessionOptions[0]).toBe(false);
  });
});

describe('PiSession.run', () => {
  it('returns completed with usage aggregated across two turns', async () => {
    const session = new StubPiSession([[
      raw({ type: 'turn_end', message: assistant({ usage: { input: 100, output: 20, cost: { total: 0.001 } } }), toolResults: [] }),
      raw({ type: 'turn_end', message: assistant({ usage: { input: 50, output: 10, cost: { total: 0.0005 } } }), toolResults: [] }),
      raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'stop' })] }),
    ]]);
    const { open } = harness({ session });
    const live = await open();
    const result = await live.run('go');
    expect(result.outcome).toBe('completed');
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ turns: 2, inputTokens: 150, outputTokens: 30, costUsd: 0.0015 });
    await live.close();
  });
  it('sums only the fields the provider reported and never materializes a zero', async () => {
    const session = new StubPiSession([[raw({ type: 'turn_end', message: assistant({ usage: { input: 7 } }), toolResults: [] })]]);
    const { open } = harness({ session });
    const live = await open();
    expect((await live.run('go')).usage).toEqual({ turns: 1, inputTokens: 7 });
    await live.close();
  });
  it('returns failed with a failed event when prompt rejects, and does not reject', async () => {
    const session = new StubPiSession([], () => Promise.reject(new Error('the provider is overloaded')));
    const { open } = harness({ session });
    const live = await open();
    const events: AgentEvent[] = [];
    live.subscribe((event) => events.push(event));
    const result = await live.run('go');
    expect(result.outcome).toBe('failed');
    expect(events.map((event) => event.type)).toEqual(['failed']);
    expect(events[0]).toMatchObject({ type: 'failed', error: { code: 'AGENT_PROVIDER_UNAVAILABLE' } });
    await live.close();
  });
  it('returns failed when the provider emits a terminal error event', async () => {
    const session = new StubPiSession([[raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'error', errorMessage: 'exhausted retries' })] })]]);
    const { open } = harness({ session });
    const live = await open();
    const result = await live.run('go');
    expect(result.outcome).toBe('failed');
    expect(result.stopReason).toBe('error');
    await live.close();
  });
  it('returns aborted after abort()', async () => {
    const session = new StubPiSession([], async (stub) => { await Promise.resolve(); expect(stub.abortCount).toBeGreaterThan(0); });
    const { open } = harness({ session });
    const live = await open();
    const running = live.run('go');
    await live.abort();
    expect((await running).outcome).toBe('aborted');
    await live.close();
  });
  it('rejects when called after close, because that is caller misuse', async () => {
    const { open } = harness();
    const live = await open();
    await live.close();
    await expect(live.run('go')).rejects.toThrow(AgentSessionStartFailedError);
  });
  it('starts each run with a fresh usage tracker', async () => {
    const turn = raw({ type: 'turn_end', message: assistant({ usage: { input: 5 } }), toolResults: [] });
    const session = new StubPiSession([[turn], [turn]]);
    const { open } = harness({ session });
    const live = await open();
    expect((await live.run('one')).usage).toEqual({ turns: 1, inputTokens: 5 });
    expect((await live.run('two')).usage).toEqual({ turns: 1, inputTokens: 5 });
    expect(session.prompts).toEqual(['one', 'two']);
    await live.close();
  });
});

describe('PiSession.subscribe', () => {
  it('delivers every mapped event in order and stops on unsubscribe', async () => {
    const session = new StubPiSession([[
      raw({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'status', args: {} }),
      raw({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'status', result: 'ok', isError: false }),
      raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'done' } }),
    ]]);
    const { open } = harness({ session });
    const live = await open();
    const events: AgentEvent[] = [];
    const unsubscribe = live.subscribe((event) => events.push(event));
    await live.run('go');
    expect(events.map((event) => event.type)).toEqual(['tool_started', 'tool_finished', 'assistant_text']);
    unsubscribe();
    session.emit(raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'after' } }));
    expect(events).toHaveLength(3);
    await live.close();
  });
  it('lets the remaining listeners receive an event when one throws', async () => {
    const session = new StubPiSession([[raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })]]);
    const { open } = harness({ session });
    const live = await open();
    const received: string[] = [];
    live.subscribe(() => { throw new Error('the consumer exploded'); });
    live.subscribe((event) => { if (event.type === 'assistant_text') received.push(event.text); });
    await expect(live.run('go')).resolves.toMatchObject({ outcome: 'completed' });
    expect(received).toEqual(['hi']);
    await live.close();
  });
});

describe('PiSession lifecycle', () => {
  it('disposes once across two closes', async () => {
    const session = new StubPiSession();
    const { open } = harness({ session });
    const live = await open();
    await live.close();
    await live.close();
    expect(session.disposeCount).toBe(1);
  });
  it('resolves abort() before any run and after close()', async () => {
    const session = new StubPiSession();
    const { open } = harness({ session });
    const live = await open();
    await expect(live.abort()).resolves.toBeUndefined();
    expect(session.abortCount).toBe(1);
    await live.close();
    await expect(live.abort()).resolves.toBeUndefined();
    expect(session.abortCount).toBe(1);
  });
  it('never logs an event payload, only its type', async () => {
    const lines: string[] = [];
    const capturing = pino({ level: 'debug' }, { write: (line: string) => lines.push(line) });
    const session = new StubPiSession([[raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'a customer name' } })]]);
    const root = mkdtempSync(path.join(tmpdir(), 'automate-log-'));
    temporary.push(root);
    const provider = new PiAgentProvider({
      piDir: path.join(root, 'pi'), modelsPath: path.join(root, 'pi', 'models.json'), sessionStagingDir: path.join(root, 'pi', 'sessions'),
      resolveAuthPath: () => path.join(root, 'pi', 'auth.json'), logger: capturing,
      createSession: () => Promise.resolve({ session }), createModelRuntime: stubRuntimeFactory(),
    });
    const live = await provider.open({ executionId: 'exec-1', sessionDir: path.join(root, 'sessions', 'exec-1'), cwd: root, model: { provider: 'anthropic', id: 'claude-sonnet-5' }, auth: { mode: 'managed' }, systemPrompt: 'prompt' });
    await live.run('go');
    await live.close();
    expect(lines.join('\n')).not.toContain('a customer name');
    expect(lines.join('\n')).toContain('assistant_text');
  });
  it('does not reach the network in any of these tests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access is forbidden in this test'));
    const { open } = harness();
    const live = await open();
    await live.run('go');
    await live.close();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
