import { describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '@automate/core';
import type { ModelRuntimeFactory } from './environment';
import { probeProviders, type ProbeProvidersOptions } from './credential-probe';

/** Anything that looks like a credential in a serialized payload. */
const KEY_SHAPES = /sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+|"(?:apiKey|api_key|token|secret|credential)"\s*:/i;

/** A runtime stub returning fixed providers, models, and credential statuses. */
function stubFactory(spec: {
  providers?: string[];
  models?: Record<string, { id: string; name?: string }[]>;
  status?: Record<string, { configured: boolean; source?: string }>;
  throwOn?: 'create' | 'providers' | 'models' | 'status';
}): ModelRuntimeFactory {
  const providers = spec.providers ?? ['anthropic', 'openai'];
  const runtime = {
    getProviders: () => { if (spec.throwOn === 'providers') throw new Error('unreadable'); return providers.map((id) => ({ id })); },
    getModels: (id: string) => { if (spec.throwOn === 'models') throw new Error('unreadable'); return spec.models?.[id] ?? []; },
    getProviderAuthStatus: (id: string) => { if (spec.throwOn === 'status') throw new Error('auth.json is corrupt'); return spec.status?.[id] ?? { configured: false }; },
  } as unknown as ModelRuntime;
  return () => (spec.throwOn === 'create' ? Promise.reject(new Error('the credential store is unreadable')) : Promise.resolve(runtime));
}

/** Probe options against a pinned temp-style path set. */
function options(factory: ModelRuntimeFactory, config: AgentConfig = DEFAULT_AGENT_CONFIG, platform: NodeJS.Platform = 'linux'): ProbeProvidersOptions {
  return { authPath: '/data/pi/auth.json', modelsPath: '/data/pi/models.json', config, platform, createModelRuntime: factory };
}

describe('provider credential probe', () => {
  it('reports a managed credential as available with source managed', async () => {
    const entries = await probeProviders(options(stubFactory({ status: { anthropic: { configured: true, source: 'stored' } } })));
    const anthropic = entries.find((entry) => entry.id === 'anthropic');
    expect(anthropic?.credentialAvailable).toBe(true);
    expect(anthropic?.credentialSource).toBe('managed');
    expect(anthropic?.remediation).toBeUndefined();
  });
  it('reports the same stored credential as personal-pi under that mode', async () => {
    const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, auth: { mode: 'personal-pi', authPath: '/home/dev/.pi/auth.json' } };
    const entries = await probeProviders(options(stubFactory({ status: { anthropic: { configured: true, source: 'stored' } } }), config));
    expect(entries.find((entry) => entry.id === 'anthropic')?.credentialSource).toBe('personal-pi');
  });
  it('reports an environment variable as source environment', async () => {
    const entries = await probeProviders(options(stubFactory({ status: { anthropic: { configured: false, source: 'environment' } } })));
    const anthropic = entries.find((entry) => entry.id === 'anthropic');
    expect(anthropic?.credentialAvailable).toBe(true);
    expect(anthropic?.credentialSource).toBe('environment');
  });
  it('reports a provider with nothing as unavailable with non-empty remediation', async () => {
    const entries = await probeProviders(options(stubFactory({})));
    const anthropic = entries.find((entry) => entry.id === 'anthropic');
    expect(anthropic?.credentialAvailable).toBe(false);
    expect(anthropic?.credentialSource).toBe('unavailable');
    expect(anthropic?.remediation).toContain('ANTHROPIC_API_KEY');
    expect(anthropic?.remediation?.length ?? 0).toBeGreaterThan(20);
  });
  it('gives a per-OS remediation command', async () => {
    const posix = await probeProviders(options(stubFactory({}), DEFAULT_AGENT_CONFIG, 'linux'));
    const windows = await probeProviders(options(stubFactory({}), DEFAULT_AGENT_CONFIG, 'win32'));
    expect(posix[0]?.remediation).toContain('export ');
    expect(windows[0]?.remediation).toContain('setx ');
  });
  it('never tells a person to paste a key into the page', async () => {
    const entries = await probeProviders(options(stubFactory({})));
    for (const entry of entries) expect(entry.remediation).toContain('never asks you to paste a key');
  });

  describe('degradation', () => {
    it('reports every provider as unavailable rather than throwing when the credential store is unreadable', async () => {
      const entries = await probeProviders(options(stubFactory({ throwOn: 'status' })));
      expect(entries).toHaveLength(2);
      for (const entry of entries) expect(entry.credentialSource).toBe('unavailable');
    });
    it('returns an empty catalog rather than throwing when the runtime cannot be constructed', async () => {
      await expect(probeProviders(options(stubFactory({ throwOn: 'create' })))).resolves.toEqual([]);
    });
    it('returns an empty catalog rather than throwing when providers cannot be listed', async () => {
      await expect(probeProviders(options(stubFactory({ throwOn: 'providers' })))).resolves.toEqual([]);
    });
    it('returns an empty model list rather than throwing when models cannot be listed', async () => {
      const entries = await probeProviders(options(stubFactory({ throwOn: 'models' })));
      for (const entry of entries) expect(entry.models).toEqual([]);
    });
  });

  describe('model catalog', () => {
    it('lists the models the runtime knows, preferring the display name', async () => {
      const entries = await probeProviders(options(stubFactory({ models: { anthropic: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }, { id: 'claude-opus-5' }] } })));
      expect(entries.find((entry) => entry.id === 'anthropic')?.models).toEqual([
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
        { id: 'claude-opus-5', label: 'claude-opus-5' },
      ]);
    });
    it('returns an empty array, not undefined, when the runtime knows no models', async () => {
      const entries = await probeProviders(options(stubFactory({})));
      for (const entry of entries) expect(entry.models).toEqual([]);
    });
    it('sorts providers by id and gives each a readable label', async () => {
      const entries = await probeProviders(options(stubFactory({ providers: ['openai', 'anthropic', 'my-local-provider'] })));
      expect(entries.map((entry) => entry.id)).toEqual(['anthropic', 'my-local-provider', 'openai']);
      expect(entries.map((entry) => entry.label)).toEqual(['Anthropic', 'My Local Provider', 'OpenAI']);
    });
  });

  it('serializes with no field capable of holding key material', async () => {
    const entries = await probeProviders(options(stubFactory({
      status: { anthropic: { configured: true, source: 'stored' } },
      models: { anthropic: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
    })));
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(KEY_SHAPES);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['credentialAvailable', 'credentialSource', 'id', 'label', 'models']));
      expect(Object.keys(entry)).not.toContain('apiKey');
      expect(Object.keys(entry)).not.toContain('credential');
    }
  });

  it('completes without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access is forbidden in this test'));
    const calls: Parameters<ModelRuntimeFactory>[0][] = [];
    const factory: ModelRuntimeFactory = (runtimeOptions) => { calls.push(runtimeOptions); return stubFactory({})(runtimeOptions); };
    await probeProviders(options(factory));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls[0]?.allowModelNetwork).toBe(false);
    expect(calls[0]?.authPath).toBe('/data/pi/auth.json');
    fetchSpy.mockRestore();
  });
});
