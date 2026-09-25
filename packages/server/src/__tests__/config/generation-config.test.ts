import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@automate/core';
import { getGenerationConfig } from '../../config/env';

describe('getGenerationConfig', () => {
  it('uses the provisional defaults, with the cost cap off', () => {
    expect(getGenerationConfig({})).toEqual({ maxAttempts: 3, timeoutMs: 600_000, maxCostUsd: 0, testRunTimeoutMs: 120_000, uvSyncTimeoutMs: 300_000, fixtureRowCount: 200, maxScriptBytes: 262_144 });
  });

  it('reads every override', () => {
    expect(getGenerationConfig({ AUTOMATE_MAX_GENERATION_ATTEMPTS: '5', AUTOMATE_GENERATION_TIMEOUT_MS: '60000', AUTOMATE_MAX_GENERATION_COST_USD: '0.75', AUTOMATE_TEST_RUN_TIMEOUT_MS: '5000', AUTOMATE_UV_SYNC_TIMEOUT_MS: '9000', AUTOMATE_FIXTURE_ROW_COUNT: '50', AUTOMATE_MAX_SCRIPT_BYTES: '1024' })).toEqual({ maxAttempts: 5, timeoutMs: 60_000, maxCostUsd: 0.75, testRunTimeoutMs: 5_000, uvSyncTimeoutMs: 9_000, fixtureRowCount: 50, maxScriptBytes: 1_024 });
  });

  it.each([
    ['AUTOMATE_MAX_GENERATION_ATTEMPTS', '0'],
    ['AUTOMATE_MAX_GENERATION_ATTEMPTS', '2.5'],
    ['AUTOMATE_MAX_GENERATION_ATTEMPTS', '21'],
    ['AUTOMATE_GENERATION_TIMEOUT_MS', 'soon'],
    ['AUTOMATE_MAX_GENERATION_COST_USD', '-1'],
    ['AUTOMATE_MAX_GENERATION_COST_USD', 'free'],
    ['AUTOMATE_FIXTURE_ROW_COUNT', '0'],
    ['AUTOMATE_MAX_SCRIPT_BYTES', '-5'],
  ])('rejects %s=%j with a message naming the variable', (name, value) => {
    expect(() => getGenerationConfig({ [name]: value })).toThrow(ConfigurationError);
    expect(() => getGenerationConfig({ [name]: value })).toThrow(name);
  });

  it('treats blank values as unset', () => {
    expect(getGenerationConfig({ AUTOMATE_MAX_GENERATION_ATTEMPTS: '  ', AUTOMATE_MAX_GENERATION_COST_USD: '' }).maxAttempts).toBe(3);
  });
});
