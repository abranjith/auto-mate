import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@automate/core';
import { assertPreflight, runDoctor, uvInstallHint } from './doctor';
import type { ProbeFn } from './tool-probe';

const healthy: ProbeFn = (command, args) => ({ ok: true, version: args.includes('list') ? 'cpython-3.12.1' : command === 'pnpm' ? '11.5.2' : `${command} 1.0` });

describe('environment doctor', () => {
  it('passes when every prerequisite is available', () => {
    const report = runDoctor({ probe: healthy, nodeVersion: 'v24.15.0' });
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(() => assertPreflight(report)).not.toThrow();
  });
  it('rejects an old Node version with the required range', () => {
    const report = runDoctor({ probe: healthy, nodeVersion: 'v22.0.0' });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toContain('>=24.15.0 <25');
    expect(() => assertPreflight(report)).toThrow(ConfigurationError);
  });
  it('rejects a pnpm version below 9', () => {
    const probe: ProbeFn = (command, args) => command === 'pnpm' ? { ok: true, version: '8.15.0' } : healthy(command, args);
    const report = runDoctor({ probe, nodeVersion: 'v24.15.0' });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'pnpm')?.severity).toBe('fatal');
  });
  it('warns but proceeds without uv', () => {
    const probe: ProbeFn = (command, args) => command === 'uv' ? { ok: false } : healthy(command, args);
    const report = runDoctor({ probe, nodeVersion: 'v24.15.0', platform: 'win32' });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'uv')).toMatchObject({ ok: false, severity: 'warning' });
    expect(() => assertPreflight(report)).not.toThrow();
  });
  it('returns platform-specific uv installation hints', () => {
    expect(uvInstallHint('win32')).toContain('winget');
    expect(uvInstallHint('linux')).toContain('curl');
  });
  it('reports a throwing probe instead of crashing', () => {
    const report = runDoctor({ probe: () => { throw new Error('boom'); }, nodeVersion: 'v24.15.0' });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'pnpm')?.ok).toBe(false);
  });
});
