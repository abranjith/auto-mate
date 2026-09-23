import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentAuthSelection } from '@automate/core';
import { createPiEnvironment, resolveAuthSource, type ModelRuntimeFactory, type PiEnvironmentOptions } from './environment';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A runtime stub. Only credential status is consulted, and no network is ever reached. */
function stubRuntime(status: { configured: boolean; source?: string }): ModelRuntime {
  return { getProviderAuthStatus: () => status } as unknown as ModelRuntime;
}

/** Record the options handed to `ModelRuntime.create` without constructing a real one. */
function spyFactory(status: { configured: boolean; source?: string } = { configured: true, source: 'stored' }) {
  const calls: Parameters<ModelRuntimeFactory>[0][] = [];
  const factory: ModelRuntimeFactory = (options) => { calls.push(options); return Promise.resolve(stubRuntime(status)); };
  return { calls, factory };
}

/** An isolated data root with pinned Pi paths and a separate project directory. */
function sandbox(): { root: string; piDir: string; cwd: string; options: (overrides?: Partial<PiEnvironmentOptions>) => PiEnvironmentOptions } {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-env-'));
  temporary.push(root);
  const piDir = path.join(root, 'pi');
  const cwd = path.join(root, 'project');
  mkdirSync(piDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const options = (overrides: Partial<PiEnvironmentOptions> = {}): PiEnvironmentOptions => ({
    piDir,
    authPath: path.join(piDir, 'auth.json'),
    modelsPath: path.join(piDir, 'models.json'),
    sessionStagingDir: path.join(piDir, 'sessions'),
    cwd,
    systemPrompt: 'The Auto-Mate system prompt.',
    provider: 'anthropic',
    auth: { mode: 'managed' },
    createModelRuntime: spyFactory().factory,
    ...overrides,
  });
  return { root, piDir, cwd, options };
}

/** Plant a full set of ambient Pi resources in a directory that Pi would normally discover. */
function plantAmbientResources(agentDir: string, projectDir: string): void {
  for (const base of [agentDir, path.join(projectDir, '.pi')]) {
    mkdirSync(path.join(base, 'skills', 'planted-skill'), { recursive: true });
    writeFileSync(path.join(base, 'skills', 'planted-skill', 'SKILL.md'), '---\nname: planted-skill\ndescription: Should never load.\n---\n\nPlanted.\n');
    mkdirSync(path.join(base, 'prompts'), { recursive: true });
    writeFileSync(path.join(base, 'prompts', 'planted-prompt.md'), '---\nname: planted-prompt\n---\nPlanted.\n');
    mkdirSync(path.join(base, 'themes'), { recursive: true });
    writeFileSync(path.join(base, 'themes', 'planted-theme.json'), JSON.stringify({ name: 'planted-theme', colors: {} }));
    mkdirSync(path.join(base, 'extensions'), { recursive: true });
    writeFileSync(path.join(base, 'extensions', 'planted-extension.js'), 'export default () => ({ name: "planted-extension" });\n');
    writeFileSync(path.join(base, 'settings.json'), JSON.stringify({ quietStartup: false, enableAnalytics: true }));
  }
  writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Planted project instructions\n\nShould never load.\n');
  writeFileSync(path.join(agentDir, 'AGENTS.md'), '# Planted user instructions\n\nShould never load.\n');
}

describe('pinned pi environment', () => {
  it('constructs every path under the injected data directory and none under the real home', async () => {
    const { root, options } = sandbox();
    const enumeration = (await createPiEnvironment(options())).enumerate();
    for (const candidate of [enumeration.agentDir, enumeration.authPath, enumeration.modelsPath, enumeration.sessionStagingDir]) {
      expect(candidate.startsWith(root)).toBe(true);
      expect(candidate.startsWith(path.join(homedir(), '.automate'))).toBe(false);
      expect(candidate.startsWith(path.join(homedir(), '.pi'))).toBe(false);
    }
  });

  it('reports zero ambient resources even with settings, an extension, a skill, a theme, and an AGENTS.md planted in both the pinned dir and the project', async () => {
    const { piDir, cwd, options } = sandbox();
    plantAmbientResources(piDir, cwd);
    const enumeration = (await createPiEnvironment(options())).enumerate();
    expect(enumeration.extensions).toEqual([]);
    expect(enumeration.skills).toEqual([]);
    expect(enumeration.prompts).toEqual([]);
    expect(enumeration.themes).toEqual([]);
    expect(enumeration.contextFiles).toEqual([]);
    expect(enumeration.systemPrompt).toBe('The Auto-Mate system prompt.');
    expect(enumeration.appendSystemPrompt).toEqual([]);
  });

  it('reports settings as in-memory, never read from disk', async () => {
    const { piDir, cwd, options } = sandbox();
    plantAmbientResources(piDir, cwd);
    const environment = await createPiEnvironment(options());
    expect(environment.enumerate().settingsSource).toBe('in-memory');
    // The planted settings.json sets quietStartup false and defaultProjectTrust
    // to something permissive; the in-memory values win because nothing is read.
    expect(environment.settingsManager.getQuietStartup()).toBe(true);
    expect(environment.settingsManager.getDefaultProjectTrust()).toBe('never');
    expect(environment.settingsManager.getSessionDir()).toBe(path.join(piDir, 'sessions'));
  });

  it('changes the auth path and nothing else for the personal-pi opt-in', async () => {
    const { options } = sandbox();
    const managed = (await createPiEnvironment(options())).enumerate();
    const personalPath = path.join(tmpdir(), 'personal-pi-auth.json');
    const auth: AgentAuthSelection = { mode: 'personal-pi', authPath: personalPath };
    const personal = (await createPiEnvironment(options({ auth, authPath: personalPath }))).enumerate();
    expect(personal.authPath).toBe(personalPath);
    expect(personal.authPath).not.toBe(managed.authPath);
    expect(personal.agentDir).toBe(managed.agentDir);
    expect(personal.modelsPath).toBe(managed.modelsPath);
    expect(personal.sessionStagingDir).toBe(managed.sessionStagingDir);
    expect(personal.systemPrompt).toBe(managed.systemPrompt);
    expect([personal.extensions, personal.skills, personal.prompts, personal.themes, personal.contextFiles]).toEqual([[], [], [], [], []]);
  });

  it('hands allowModelNetwork false to the runtime factory', async () => {
    const { options } = sandbox();
    const spy = spyFactory();
    const opts = options({ createModelRuntime: spy.factory });
    await createPiEnvironment(opts);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.allowModelNetwork).toBe(false);
    expect(spy.calls[0]?.authPath).toBe(opts.authPath);
    expect(spy.calls[0]?.modelsPath).toBe(opts.modelsPath);
  });

  it('passes an abort signal through to the runtime factory', async () => {
    const { options } = sandbox();
    const spy = spyFactory();
    const controller = new AbortController();
    await createPiEnvironment(options({ createModelRuntime: spy.factory, signal: controller.signal }));
    expect(spy.calls[0]?.signal).toBe(controller.signal);
  });

  it('performs no network access while constructing the environment', async () => {
    const { options } = sandbox();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access is forbidden in this test'));
    await createPiEnvironment(options());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('auth source resolution', () => {
  it.each([
    ['stored', 'managed', 'managed'],
    ['stored', 'personal-pi', 'personal-pi'],
    ['runtime', 'managed', 'managed'],
    ['environment', 'managed', 'environment'],
    ['fallback', 'managed', 'environment'],
    ['models_json_key', 'managed', 'managed'],
    ['models_json_command', 'managed', 'managed'],
  ] as const)('maps source %s under mode %s to %s', (source, mode, expected) => {
    expect(resolveAuthSource(stubRuntime({ configured: true, source }), 'anthropic', mode)).toBe(expected);
  });
  it('reports unavailable when nothing is configured and no source is labelled', () => {
    expect(resolveAuthSource(stubRuntime({ configured: false }), 'anthropic', 'managed')).toBe('unavailable');
  });
  it('reports the stored vocabulary when configured without a labelled source', () => {
    expect(resolveAuthSource(stubRuntime({ configured: true }), 'anthropic', 'managed')).toBe('managed');
    expect(resolveAuthSource(stubRuntime({ configured: true }), 'anthropic', 'personal-pi')).toBe('personal-pi');
  });
  it('reports unavailable rather than throwing when the credential store is unreadable', () => {
    const broken = { getProviderAuthStatus: () => { throw new Error('auth.json is corrupt'); } } as unknown as ModelRuntime;
    expect(resolveAuthSource(broken, 'anthropic', 'managed')).toBe('unavailable');
  });
  it('carries the resolved source onto the constructed environment', async () => {
    const { options } = sandbox();
    const environment = await createPiEnvironment(options({ createModelRuntime: spyFactory({ configured: true, source: 'environment' }).factory }));
    expect(environment.authSource).toBe('environment');
  });
});
