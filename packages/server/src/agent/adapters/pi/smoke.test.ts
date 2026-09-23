import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CreateAgentSessionOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AgentAuthUnavailableError, type AgentEvent } from '@automate/core';
import pino from 'pino';
import type { ModelRuntimeFactory } from './environment';
import { AGENT_SMOKE_PROMPT_VERSION, createStatusTool, runAgentSmoke, type AgentSmokeOptions } from './smoke';
import { StubPiSession, assistantMessage as assistant, rawEvent as raw } from './testing/stub-pi-session';

const logger = pino({ level: 'silent' });
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A runtime stub that knows one model and one credential status. */
function stubRuntimeFactory(status: { configured: boolean; source?: string } = { configured: true, source: 'stored' }): ModelRuntimeFactory {
  return () => Promise.resolve({
    getProviderAuthStatus: () => status,
    getModels: () => [{ id: 'claude-sonnet-5' }],
    getModel: (_provider: string, id: string) => (id === 'claude-sonnet-5' ? { id } : undefined),
  } as unknown as ModelRuntime);
}

/** The scripted batch of a successful smoke run: one status tool round trip and a reply. */
function successScript() {
  return [[
    raw({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'status', args: {} }),
    raw({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'status', result: '{"ok":true}', isError: false }),
    raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'The runtime is healthy.' } }),
    raw({ type: 'turn_end', message: assistant({ usage: { input: 40, output: 8 } }), toolResults: [] }),
    raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'stop' })] }),
  ]];
}

/** Smoke options against a temp data root, with the session factory injected. */
function smokeOptions(session: StubPiSession, patch: Partial<AgentSmokeOptions> = {}): AgentSmokeOptions & { root: string; sessionOptions: CreateAgentSessionOptions[] } {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-smoke-'));
  temporary.push(root);
  const sessionOptions: CreateAgentSessionOptions[] = [];
  return {
    root,
    sessionOptions,
    piDir: path.join(root, 'pi'),
    authPath: path.join(root, 'pi', 'auth.json'),
    modelsPath: path.join(root, 'pi', 'models.json'),
    sessionStagingDir: path.join(root, 'pi', 'sessions'),
    sessionDir: path.join(root, 'agent-sessions', 'smoke'),
    executionId: 'smoke',
    cwd: root,
    model: { provider: 'anthropic', id: 'claude-sonnet-5' },
    logger,
    overrides: {
      createSession: (options) => { sessionOptions.push(options); return Promise.resolve({ session }); },
      createModelRuntime: stubRuntimeFactory(),
    },
    ...patch,
  };
}

describe('agent smoke check', () => {
  it('reports a completed run with the status tool invoked and the events in order', async () => {
    const options = smokeOptions(new StubPiSession(successScript()));
    const report = await runAgentSmoke(options);
    expect(report.result.outcome).toBe('completed');
    expect(report.statusToolInvoked).toBe(true);
    expect(report.events.map((event) => event.type)).toEqual(['tool_started', 'tool_finished', 'assistant_text', 'turn_finished']);
    expect(report.result.usage).toEqual({ turns: 1, inputTokens: 40, outputTokens: 8 });
    expect(report.promptVersion).toBe(AGENT_SMOKE_PROMPT_VERSION);
  });
  it('registers the status tool as the only tool', async () => {
    const options = smokeOptions(new StubPiSession(successScript()));
    await runAgentSmoke(options);
    expect(options.sessionOptions[0]?.noTools).toBe('all');
    expect(options.sessionOptions[0]?.tools).toEqual(['status']);
    expect(options.sessionOptions[0]?.customTools?.map((tool) => tool.name)).toEqual(['status']);
  });
  it('reports zero ambient resources in the enumeration', async () => {
    const report = await runAgentSmoke(smokeOptions(new StubPiSession(successScript())));
    expect(report.environment.extensions).toEqual([]);
    expect(report.environment.skills).toEqual([]);
    expect(report.environment.prompts).toEqual([]);
    expect(report.environment.themes).toEqual([]);
    expect(report.environment.contextFiles).toEqual([]);
    expect(report.environment.settingsSource).toBe('in-memory');
    expect(report.environment.systemPrompt).toContain(AGENT_SMOKE_PROMPT_VERSION);
  });
  it('leaves a parseable JSONL at the reported log path', async () => {
    const report = await runAgentSmoke(smokeOptions(new StubPiSession(successScript())));
    expect(existsSync(report.logPath)).toBe(true);
    const contents = readFileSync(report.logPath, 'utf8').trimEnd();
    expect(contents.length).toBeGreaterThan(0);
    expect(() => contents.split('\n').map((line) => JSON.parse(line))).not.toThrow();
  });
  it('carries no credential material in the report', async () => {
    const report = await runAgentSmoke(smokeOptions(new StubPiSession(successScript())));
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+\S+|"(?:apiKey|token|secret)"\s*:/i);
  });

  describe('failure paths', () => {
    it('reports a failed outcome with the typed code and still closes the session', async () => {
      const session = new StubPiSession([[
        raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'error', errorMessage: 'the provider is overloaded' })] }),
      ]]);
      const report = await runAgentSmoke(smokeOptions(session));
      expect(report.result.outcome).toBe('failed');
      expect(report.events.filter((event) => event.type === 'failed')).toHaveLength(1);
      expect((report.events.find((event) => event.type === 'failed') as Extract<AgentEvent, { type: 'failed' }>).error.code).toBe('AGENT_PROVIDER_UNAVAILABLE');
      expect(session.disposeCount).toBe(1);
    });
    it('closes the session even when the prompt rejects', async () => {
      const session = new StubPiSession([], () => Promise.reject(new Error('the connection dropped')));
      const report = await runAgentSmoke(smokeOptions(session));
      expect(report.result.outcome).toBe('failed');
      expect(session.disposeCount).toBe(1);
    });
    it('raises AGENT_AUTH_UNAVAILABLE rather than silently falling back when no credential resolves', async () => {
      const options = smokeOptions(new StubPiSession(successScript()));
      await expect(runAgentSmoke({ ...options, overrides: { ...options.overrides, createModelRuntime: stubRuntimeFactory({ configured: false }) } }))
        .rejects.toThrow(AgentAuthUnavailableError);
    });
    it('raises AGENT_MODEL_NOT_FOUND for an unknown model', async () => {
      const options = smokeOptions(new StubPiSession(successScript()));
      await expect(runAgentSmoke({ ...options, model: { provider: 'anthropic', id: 'claude-nope' } })).rejects.toThrow(/claude-sonnet-5/);
    });
  });

  describe('cancellation', () => {
    it('reports an aborted outcome when the signal fires mid-run', async () => {
      const controller = new AbortController();
      const session = new StubPiSession([], async () => { controller.abort(); await Promise.resolve(); });
      const report = await runAgentSmoke(smokeOptions(session, { signal: controller.signal }));
      expect(report.result.outcome).toBe('aborted');
      expect(session.abortCount).toBeGreaterThan(0);
    });
    it('aborts immediately when the signal is already fired', async () => {
      const controller = new AbortController();
      controller.abort();
      const session = new StubPiSession(successScript());
      const report = await runAgentSmoke(smokeOptions(session, { signal: controller.signal }));
      expect(session.abortCount).toBe(1);
      expect(report.result.outcome).toBe('aborted');
    });
  });

  it('streams each event to the live callback as well as the report', async () => {
    const seen: string[] = [];
    const report = await runAgentSmoke(smokeOptions(new StubPiSession(successScript()), { onEvent: (event) => seen.push(event.type) }));
    expect(seen).toEqual(report.events.map((event) => event.type));
  });
});

describe('the status tool', () => {
  it('is named status and takes no parameters', () => {
    const tool = createStatusTool();
    expect(tool.name).toBe('status');
    expect(tool.label).toBe('Status');
    expect(tool.description.length).toBeGreaterThan(20);
  });
  it('returns the platform and Node version as text content', async () => {
    const result = await createStatusTool().execute('call-1', {}, undefined, undefined, {} as never);
    const [content] = result.content;
    expect(content?.type).toBe('text');
    const parsed = JSON.parse((content as { text: string }).text) as { ok: boolean; platform: string; node: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.platform).toBe(process.platform);
    expect(parsed.node).toBe(process.versions.node);
  });
});
