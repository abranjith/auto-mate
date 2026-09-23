import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AGENT_CONFIG_VERSION, AgentConfigSchema, AgentConfigUpdateSchema, DEFAULT_AGENT_CONFIG } from '../../agent/agent-config';

const valid = { ...DEFAULT_AGENT_CONFIG };

/** Drop one key from a document, to assert a field really is required or optional. */
function omit(document: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document).filter(([name]) => name !== key));
}

describe('agent configuration schema', () => {
  it('accepts the built-in defaults', () => {
    expect(Value.Check(AgentConfigSchema, valid)).toBe(true);
    expect(valid.version).toBe(AGENT_CONFIG_VERSION);
    expect(valid.auth.mode).toBe('managed');
  });
  it('defaults to a credential-free document', () => {
    expect(JSON.stringify(DEFAULT_AGENT_CONFIG)).not.toMatch(/key|secret|token/i);
  });
  it('rejects an empty provider or model', () => {
    expect(Value.Check(AgentConfigSchema, { ...valid, provider: '' })).toBe(false);
    expect(Value.Check(AgentConfigSchema, { ...valid, model: '' })).toBe(false);
  });
  it('treats thinking as optional', () => {
    expect(Value.Check(AgentConfigSchema, omit(valid, 'thinking'))).toBe(true);
  });
  it('accepts an unknown thinking level, which the adapter validates at session open', () => {
    expect(Value.Check(AgentConfigSchema, { ...valid, thinking: 'a-level-from-a-newer-sdk' })).toBe(true);
  });
  it('rejects an unknown auth mode', () => {
    expect(Value.Check(AgentConfigSchema, { ...valid, auth: { mode: 'keychain' } })).toBe(false);
  });
  it('requires authPath for personal-pi and rejects it for managed', () => {
    expect(Value.Check(AgentConfigSchema, { ...valid, auth: { mode: 'personal-pi' } })).toBe(false);
    expect(Value.Check(AgentConfigSchema, { ...valid, auth: { mode: 'personal-pi', authPath: '/home/dev/.pi/auth.json' } })).toBe(true);
    expect(Value.Check(AgentConfigSchema, { ...valid, auth: { mode: 'managed', authPath: '/home/dev/.pi/auth.json' } })).toBe(false);
  });
  it('rejects an unknown top-level field', () => {
    expect(Value.Check(AgentConfigSchema, { ...valid, apiKey: 'sk-ant-secret' })).toBe(false);
  });
  it('rejects a missing version or updatedAt', () => {
    expect(Value.Check(AgentConfigSchema, omit(valid, 'version'))).toBe(false);
    expect(Value.Check(AgentConfigSchema, omit(valid, 'updatedAt'))).toBe(false);
  });
});

describe('agent configuration update schema', () => {
  const update = { provider: 'anthropic', model: 'claude-sonnet-5', thinking: 'high', auth: { mode: 'managed' } };
  it('accepts a selection without server-owned fields', () => {
    expect(Value.Check(AgentConfigUpdateSchema, update)).toBe(true);
  });
  it('rejects a client-supplied version or updatedAt', () => {
    expect(Value.Check(AgentConfigUpdateSchema, { ...update, version: 1 })).toBe(false);
    expect(Value.Check(AgentConfigUpdateSchema, { ...update, updatedAt: '2026-09-22T00:00:00.000Z' })).toBe(false);
  });
  it('holds the auth conditional in both directions', () => {
    expect(Value.Check(AgentConfigUpdateSchema, { ...update, auth: { mode: 'personal-pi' } })).toBe(false);
    expect(Value.Check(AgentConfigUpdateSchema, { ...update, auth: { mode: 'managed', authPath: '/x' } })).toBe(false);
  });
});
