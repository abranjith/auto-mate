import { describe, expect, it } from 'vitest';
import { ConfigurationError, UPLOAD_LIMIT_DEFAULTS } from '@automate/core';
import { getIngestionConfig } from '../../config/env';

describe('getIngestionConfig', () => {
  it('uses the D14 provisional defaults', () => {
    expect(getIngestionConfig({})).toEqual({
      maxUploadBytes: 50 * 1024 * 1024,
      maxFilesPerTask: 5,
      maxProfileRows: 1_000_000,
      maxColumns: 512,
      parseTimeoutMs: 60_000,
      maxSheets: 20,
      maxInflatedBytes: 1024 * 1024 * 1024,
      stagedUploadTtlHours: 24,
    });
    expect(getIngestionConfig({})).toEqual({ ...UPLOAD_LIMIT_DEFAULTS });
  });

  it('reads every override', () => {
    const config = getIngestionConfig({
      AUTOMATE_MAX_UPLOAD_BYTES: '1000',
      AUTOMATE_MAX_FILES_PER_TASK: '2',
      AUTOMATE_MAX_PROFILE_ROWS: '10',
      AUTOMATE_MAX_COLUMNS: '8',
      AUTOMATE_PARSE_TIMEOUT_MS: '500',
      AUTOMATE_MAX_SHEETS: '3',
      AUTOMATE_MAX_INFLATED_BYTES: '4096',
      AUTOMATE_STAGED_UPLOAD_TTL_HOURS: '1',
    });
    expect(config).toEqual({ maxUploadBytes: 1000, maxFilesPerTask: 2, maxProfileRows: 10, maxColumns: 8, parseTimeoutMs: 500, maxSheets: 3, maxInflatedBytes: 4096, stagedUploadTtlHours: 1 });
  });

  it.each([
    ['AUTOMATE_MAX_UPLOAD_BYTES', 'lots'],
    ['AUTOMATE_MAX_COLUMNS', '0'],
    ['AUTOMATE_PARSE_TIMEOUT_MS', '-5'],
    ['AUTOMATE_MAX_SHEETS', '1.5'],
    ['AUTOMATE_MAX_FILES_PER_TASK', '6'],
  ])('rejects %s=%s and names the variable', (name, value) => {
    expect(() => getIngestionConfig({ [name]: value })).toThrow(ConfigurationError);
    expect(() => getIngestionConfig({ [name]: value })).toThrow(name);
  });

  it('treats a blank value as unset', () => {
    expect(getIngestionConfig({ AUTOMATE_MAX_SHEETS: '  ' }).maxSheets).toBe(20);
  });
});
