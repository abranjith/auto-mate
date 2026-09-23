import { describe, expect, it } from 'vitest';
import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';
import {
  AgentAuthUnavailableError, AgentModelNotFoundError, AgentProviderUnavailableError,
  AgentSessionStartFailedError, AgentStartupError,
} from './agent-errors';

const KEY_SHAPES = /sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+/;

describe('agent startup errors', () => {
  it('extends the application error hierarchy', () => {
    const error = new AgentModelNotFoundError('anthropic', 'nope', 'Known anthropic models include: claude-sonnet-5.');
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error).toBeInstanceOf(AgentStartupError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ERROR_CODES.AGENT_MODEL_NOT_FOUND);
  });
  it.each([
    [new AgentModelNotFoundError('anthropic', 'a', 'hint'), ERROR_CODES.AGENT_MODEL_NOT_FOUND],
    [new AgentAuthUnavailableError('anthropic', 'sources', 'fix'), ERROR_CODES.AGENT_AUTH_UNAVAILABLE],
    [new AgentProviderUnavailableError('anthropic', 'timeout'), ERROR_CODES.AGENT_PROVIDER_UNAVAILABLE],
    [new AgentSessionStartFailedError('bad cwd'), ERROR_CODES.AGENT_SESSION_START_FAILED],
  ])('each subclass keeps its own code', (error, code) => {
    expect(error.code).toBe(code);
    expect(error.toAgentError()).toEqual({ code, message: error.message });
  });
  it('names the model that missed and the known alternatives', () => {
    const error = new AgentModelNotFoundError('anthropic', 'claude-nope', 'Known anthropic models include: claude-sonnet-5, claude-opus-5.');
    expect(error.message).toContain('claude-nope');
    expect(error.message).toContain('claude-sonnet-5');
  });
  it('names the credential sources tried without carrying key material', () => {
    const error = new AgentAuthUnavailableError(
      'anthropic',
      'the managed store at the application data root, a personal Pi credential file, ANTHROPIC_API_KEY',
      'Set ANTHROPIC_API_KEY or sign in with the Pi CLI.',
    );
    expect(error.message).toContain('the managed store');
    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(error.message).not.toMatch(KEY_SHAPES);
  });
  it('omits stack and private details from the API envelope', () => {
    const error = new AgentSessionStartFailedError('the provider refused the session');
    expect(error.toJSON()).toEqual({ error: { code: ERROR_CODES.AGENT_SESSION_START_FAILED, message: error.message } });
    expect(Object.keys(error.toJSON().error)).not.toContain('details');
    expect(JSON.stringify(error.toJSON())).not.toContain('stack');
  });
  it('carries a correlation id into the envelope only when one is set', () => {
    const error = new AgentSessionStartFailedError('reason');
    expect(error.toJSON().error.correlationId).toBeUndefined();
  });
});
