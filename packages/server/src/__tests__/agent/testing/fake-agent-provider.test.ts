/**
 * Behavioural contract for the agent seam.
 *
 * The `describe.each` block runs the SAME assertions against the in-memory
 * double and the real stub-backed `PiSession`, so the double cannot quietly
 * drift from the implementation the rest of the codebase will meet in
 * production.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent, AgentRunResult, AgentSession, AgentSessionOptions } from '@automate/core';
import pino from 'pino';
import { PiAgentProvider } from '../../../agent/adapters/pi/provider';
import { StubPiSession } from '../../../agent/adapters/pi/testing/stub-pi-session';
import { FakeAgentProvider, FakeAgentSession } from '../../../agent/testing/fake-agent-provider';

const logger = pino({ level: 'silent' });
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const TEXT_EVENT: AgentEvent = { type: 'assistant_text', text: 'hello', at: '2026-09-22T12:00:00.000Z' };
const TOOL_EVENT: AgentEvent = { type: 'tool_started', callId: 'c1', tool: 'status', input: {}, at: '2026-09-22T12:00:00.000Z' };
const TURN_EVENT: AgentEvent = { type: 'turn_finished', usage: { turns: 1, inputTokens: 5 }, at: '2026-09-22T12:00:00.000Z' };
const SECOND_TURN_EVENT: AgentEvent = { type: 'turn_finished', usage: { turns: 1 }, at: '2026-09-22T12:00:00.000Z' };
const RESULT: AgentRunResult = { outcome: 'completed', stopReason: 'stop', usage: { turns: 1, inputTokens: 5 } };
const SECOND_RESULT: AgentRunResult = { outcome: 'completed', stopReason: 'stop', usage: { turns: 2 } };

/** Base session options shared by both implementations. */
function sessionOptions(root: string): AgentSessionOptions {
  return {
    executionId: 'exec-1',
    sessionDir: path.join(root, 'agent-sessions', 'exec-1'),
    cwd: root,
    model: { provider: 'anthropic', id: 'claude-sonnet-5' },
    auth: { mode: 'managed' },
    systemPrompt: 'The Auto-Mate system prompt.',
  };
}

/** Open a scripted `FakeAgentSession`. */
async function openFake(): Promise<AgentSession> {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-fake-'));
  temporary.push(root);
  const provider = new FakeAgentProvider([
    { events: [TOOL_EVENT, TEXT_EVENT, TURN_EVENT], result: RESULT },
    { events: [TEXT_EVENT, SECOND_TURN_EVENT, SECOND_TURN_EVENT], result: SECOND_RESULT },
  ]);
  return provider.open(sessionOptions(root));
}

/** Open a real `PiSession` backed by a stub SDK session scripted to the same behaviour. */
async function openReal(): Promise<AgentSession> {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-real-'));
  temporary.push(root);
  const raw = (event: Record<string, unknown>) => event as never;
  const assistant = (fields: Record<string, unknown> = {}) => ({ role: 'assistant', ...fields });
  const session = new StubPiSession([
    [
      raw({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'status', args: {} }),
      raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
      raw({ type: 'turn_end', message: assistant({ usage: { input: 5 } }), toolResults: [] }),
    ],
    [
      raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
      raw({ type: 'turn_end', message: assistant(), toolResults: [] }),
      raw({ type: 'turn_end', message: assistant(), toolResults: [] }),
    ],
  ]);
  const provider = new PiAgentProvider({
    piDir: path.join(root, 'pi'),
    modelsPath: path.join(root, 'pi', 'models.json'),
    sessionStagingDir: path.join(root, 'pi', 'sessions'),
    resolveAuthPath: () => path.join(root, 'pi', 'auth.json'),
    logger,
    createSession: () => Promise.resolve({ session }),
    createModelRuntime: () => Promise.resolve({
      getProviderAuthStatus: () => ({ configured: true, source: 'stored' }),
      getModels: () => [{ id: 'claude-sonnet-5' }],
      getModel: () => ({ id: 'claude-sonnet-5' }),
    } as never),
  });
  return provider.open(sessionOptions(root));
}

describe.each([
  ['FakeAgentSession', openFake],
  ['PiSession', openReal],
])('agent session contract: %s', (_name, open) => {
  it('exposes an id, a log path, and an auth source', async () => {
    const session = await open();
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);
    expect(path.isAbsolute(session.logPath.replace(/\//g, path.sep))).toBe(true);
    expect(['managed', 'personal-pi', 'environment']).toContain(session.authSource);
    await session.close();
  });
  it('emits its scripted events in order and returns the run result', async () => {
    const session = await open();
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));
    const result = await session.run('first');
    expect(events.map((event) => event.type)).toEqual(['tool_started', 'assistant_text', 'turn_finished']);
    expect(result.outcome).toBe('completed');
    expect(result.usage.turns).toBe(1);
    expect(result.usage.inputTokens).toBe(5);
    await session.close();
  });
  it('uses the second scripted batch on a second run', async () => {
    const session = await open();
    await session.run('first');
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));
    const result = await session.run('second');
    expect(events.map((event) => event.type)).toEqual(['assistant_text', 'turn_finished', 'turn_finished']);
    expect(result.usage.turns).toBe(2);
    await session.close();
  });
  it('stops delivering to a listener after it unsubscribes', async () => {
    const session = await open();
    const events: AgentEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    await session.run('first');
    const seen = events.length;
    expect(seen).toBeGreaterThan(0);
    unsubscribe();
    await session.run('second');
    expect(events).toHaveLength(seen);
    await session.close();
  });
  it('lets the remaining listeners receive an event when one throws', async () => {
    const session = await open();
    const received: string[] = [];
    session.subscribe(() => { throw new Error('the consumer exploded'); });
    session.subscribe((event) => received.push(event.type));
    await expect(session.run('first')).resolves.toBeDefined();
    expect(received.length).toBeGreaterThan(0);
    await session.close();
  });
  it('resolves abort() before any run', async () => {
    const session = await open();
    await expect(session.abort()).resolves.toBeUndefined();
    await session.close();
  });
  it('is idempotent on a second close', async () => {
    const session = await open();
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });
  it('rejects run() after close, because that is caller misuse', async () => {
    const session = await open();
    await session.close();
    await expect(session.run('after close')).rejects.toThrow();
  });
});

describe('FakeAgentProvider', () => {
  it('records the open options and hands out one session per call', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-fake-'));
    temporary.push(root);
    const provider = new FakeAgentProvider();
    await provider.open(sessionOptions(root));
    await provider.open(sessionOptions(root));
    expect(provider.opened).toHaveLength(2);
    expect(provider.opened[0]?.executionId).toBe('exec-1');
    expect(provider.sessions.map((session) => session.id)).toEqual(['fake-session-1', 'fake-session-2']);
  });
  it('reports personal-pi as the auth source for that mode', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-fake-'));
    temporary.push(root);
    const session = await new FakeAgentProvider().open({ ...sessionOptions(root), auth: { mode: 'personal-pi', authPath: '/home/dev/.pi/auth.json' } });
    expect(session.authSource).toBe('personal-pi');
  });
  it('rejects open() with the configured startup failure', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-fake-'));
    temporary.push(root);
    const provider = new FakeAgentProvider([], new Error('no credential'));
    await expect(provider.open(sessionOptions(root))).rejects.toThrow('no credential');
  });
  it('counts prompts, aborts, and closes for assertions', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-fake-'));
    temporary.push(root);
    const provider = new FakeAgentProvider([{ events: [], result: RESULT }]);
    const session = (await provider.open(sessionOptions(root))) as FakeAgentSession;
    await session.run('one');
    await session.abort();
    await session.close();
    await session.close();
    expect(session.prompts).toEqual(['one']);
    expect(session.abortCount).toBe(1);
    expect(session.closeCount).toBe(1);
  });
  it('returns an aborted outcome for a run after abort()', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-fake-'));
    temporary.push(root);
    const provider = new FakeAgentProvider([{ events: [], result: RESULT }, { events: [], result: RESULT }]);
    const session = (await provider.open(sessionOptions(root))) as FakeAgentSession;
    await session.abort();
    expect((await session.run('after abort')).outcome).toBe('aborted');
  });
  it('returns an idle result when the script is exhausted', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-fake-'));
    temporary.push(root);
    const session = await new FakeAgentProvider().open(sessionOptions(root));
    expect(await session.run('unscripted')).toEqual({ outcome: 'completed', stopReason: 'stop', usage: { turns: 0 } });
  });
});
