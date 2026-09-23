import { afterEach, describe, expect, it, vi } from 'vitest';

// `node:fs` is an ESM namespace, so it cannot be spied on in place. The factory
// passes every call through except the rename, which one test makes fail to
// prove the previous valid config survives a failed write.
const failure = vi.hoisted(() => ({ renameSync: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync = (from: string, to: string): void => {
    if (failure.renameSync) throw new Error('the disk is full');
    actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigurationError, DEFAULT_AGENT_CONFIG, ValidationError, type AgentConfig } from '@automate/core';
import pino from 'pino';
import { ensureAppDirectories, getAppPaths, type AppPaths } from '../../../config/app-paths';
import { AgentConfigStore, resolveAuthPath } from '../../../agent/config/agent-config-store';

const logger = pino({ level: 'silent' });
const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); });

/** Create an isolated data root with the full directory layout in place. */
function freshRoot(): { paths: AppPaths; store: AgentConfigStore } {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-agent-'));
  temporary.push(root);
  const paths = getAppPaths(root);
  ensureAppDirectories(paths);
  return { paths, store: new AgentConfigStore({ paths, logger }) };
}

describe('agent config store', () => {
  it('returns the defaults and writes nothing when no file exists', () => {
    const { paths, store } = freshRoot();
    expect(store.load()).toEqual(DEFAULT_AGENT_CONFIG);
    expect(existsSync(paths.agentConfigFile)).toBe(false);
  });
  it('round-trips a saved selection exactly', () => {
    const { store } = freshRoot();
    const saved = store.save({ ...DEFAULT_AGENT_CONFIG, model: 'claude-opus-5', thinking: 'max' });
    expect(store.load()).toEqual(saved);
    expect(saved.model).toBe('claude-opus-5');
  });
  it('stamps a fresh updatedAt on every save', () => {
    const { store } = freshRoot();
    const saved = store.save({ ...DEFAULT_AGENT_CONFIG });
    expect(saved.updatedAt).not.toBe(DEFAULT_AGENT_CONFIG.updatedAt);
    expect(new Date(saved.updatedAt).toISOString()).toBe(saved.updatedAt);
  });
  it('round-trips the personal-pi opt-in with its path', () => {
    const { store } = freshRoot();
    const saved = store.save({ ...DEFAULT_AGENT_CONFIG, auth: { mode: 'personal-pi', authPath: path.join(tmpdir(), 'auth.json') } });
    expect(store.load().auth).toEqual(saved.auth);
  });
  it('leaves no temporary file behind on success', () => {
    const { paths, store } = freshRoot();
    store.save({ ...DEFAULT_AGENT_CONFIG });
    expect(readdirSync(paths.configDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
  it('never writes credential material into the document', () => {
    const { paths, store } = freshRoot();
    store.save({ ...DEFAULT_AGENT_CONFIG });
    expect(readFileSync(paths.agentConfigFile, 'utf8')).not.toMatch(/sk-|api[_-]?key|bearer/i);
  });

  describe('validation', () => {
    it.each([
      ['an unknown auth mode', { auth: { mode: 'keychain' } }, 'auth'],
      ['personal-pi without a path', { auth: { mode: 'personal-pi' } }, 'auth'],
      ['managed with a path', { auth: { mode: 'managed', authPath: '/x' } }, 'auth'],
      ['an empty model', { model: '' }, 'model'],
      ['an empty provider', { provider: '' }, 'provider'],
    ])('rejects %s on load, naming the field', (_label, patch, field) => {
      const { paths, store } = freshRoot();
      writeFileSync(paths.agentConfigFile, JSON.stringify({ ...DEFAULT_AGENT_CONFIG, ...patch }));
      expect(() => store.load()).toThrow(ConfigurationError);
      expect(() => store.load()).toThrow(new RegExp(field));
    });
    it('raises rather than crashing on truncated JSON', () => {
      const { paths, store } = freshRoot();
      writeFileSync(paths.agentConfigFile, '{"provider":"anthropic",');
      expect(() => store.load()).toThrow(ConfigurationError);
    });
    it('rejects an invalid selection on save', () => {
      const { store } = freshRoot();
      expect(() => store.save({ ...DEFAULT_AGENT_CONFIG, model: '' } as AgentConfig)).toThrow(ConfigurationError);
    });
    it('leaves the previous valid file intact when a write fails', () => {
      const { paths, store } = freshRoot();
      const good = store.save({ ...DEFAULT_AGENT_CONFIG, model: 'claude-sonnet-5' });
      failure.renameSync = true;
      try {
        expect(() => store.save({ ...DEFAULT_AGENT_CONFIG, model: 'claude-opus-5' })).toThrow(ConfigurationError);
      } finally { failure.renameSync = false; }
      expect(store.load()).toEqual(good);
      expect(readdirSync(paths.configDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('resolveAuthPath', () => {
    it('returns the managed store path by default', () => {
      const { paths } = freshRoot();
      expect(resolveAuthPath(DEFAULT_AGENT_CONFIG, paths)).toBe(paths.piAuthFile);
    });
    it('returns the configured path for personal-pi', () => {
      const { paths } = freshRoot();
      const personal = path.join(paths.root, 'personal-auth.json');
      writeFileSync(personal, '{}');
      expect(resolveAuthPath({ ...DEFAULT_AGENT_CONFIG, auth: { mode: 'personal-pi', authPath: personal } }, paths)).toBe(personal);
    });
    it('raises in plain English when the personal file is missing', () => {
      const { paths } = freshRoot();
      const missing = path.join(paths.root, 'nope', 'auth.json');
      expect(() => resolveAuthPath({ ...DEFAULT_AGENT_CONFIG, auth: { mode: 'personal-pi', authPath: missing } }, paths)).toThrow(ConfigurationError);
      expect(() => resolveAuthPath({ ...DEFAULT_AGENT_CONFIG, auth: { mode: 'personal-pi', authPath: missing } }, paths)).toThrow(/does not exist/);
    });
  });
});

describe('agent storage layout', () => {
  it('creates config, pi, pi/sessions, and agent-sessions idempotently', () => {
    const { paths } = freshRoot();
    ensureAppDirectories(paths);
    for (const dir of [paths.configDir, paths.piDir, paths.piSessionStagingDir, paths.agentSessionsDir]) expect(existsSync(dir)).toBe(true);
  });
  it('creates the pi directory with mode 0700 on POSIX hosts', async () => {
    const { paths } = freshRoot();
    if (process.platform === 'win32') return;
    const { statSync } = await import('node:fs');
    expect((statSync(paths.piDir).mode & 0o777).toString(8)).toBe('700');
  });
  it('resolves a session directory under agent-sessions', () => {
    const { paths } = freshRoot();
    expect(paths.sessionDirFor('exec-1')).toBe(path.join(paths.agentSessionsDir, 'exec-1'));
  });
  it('rejects a traversing execution id', () => {
    const { paths } = freshRoot();
    expect(() => paths.sessionDirFor('../escape')).toThrow(ValidationError);
    expect(() => paths.sessionDirFor(path.resolve(tmpdir(), 'outside'))).toThrow(ValidationError);
  });
});
