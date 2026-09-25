import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeRuntimeCapabilities } from '@automate/core';
import { getRuntimeConfig } from '../../config/env';
import {
  PINNED_PYTHON_VERSION,
  SCRIPT_DEPENDENCY_SET,
  VERIFICATION_TOOL_SET,
} from '../../execution/dependency-policy';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);
const read = (name: string) => readFileSync(path.join(root, name), 'utf8');

describe('docs-examples: locked Python runtime', () => {
  it('documents exact interpreter and package pins', () => {
    const page = read('docs/features/python-runtime-execution.md');
    const changelog = read('CHANGELOG.md');
    for (const text of [page, changelog]) {
      expect(text).toContain(PINNED_PYTHON_VERSION);
      for (const { name, version } of [
        ...SCRIPT_DEPENDENCY_SET,
        ...VERIFICATION_TOOL_SET,
      ]) {
        expect(text).toContain(name);
        expect(text).toContain(version);
      }
    }
  });

  it('documents all nine provisional settings with their defaults', () => {
    const settings = getRuntimeConfig({});
    const variables: Record<keyof typeof settings, string> = {
      prepareOnStartup: 'AUTOMATE_RUNTIME_PREPARE_ON_STARTUP',
      scriptRunTimeoutMs: 'AUTOMATE_SCRIPT_RUN_TIMEOUT_MS',
      memoryLimitBytes: 'AUTOMATE_SCRIPT_MEMORY_LIMIT_BYTES',
      maxOutputFileBytes: 'AUTOMATE_SCRIPT_MAX_OUTPUT_FILE_BYTES',
      maxOutputTotalBytes: 'AUTOMATE_SCRIPT_MAX_OUTPUT_TOTAL_BYTES',
      maxOutputFiles: 'AUTOMATE_SCRIPT_MAX_OUTPUT_FILES',
      outputWatchIntervalMs: 'AUTOMATE_OUTPUT_WATCH_INTERVAL_MS',
      prepareTimeoutMs: 'AUTOMATE_RUNTIME_PREPARE_TIMEOUT_MS',
      pythonInstallTimeoutMs: 'AUTOMATE_PYTHON_INSTALL_TIMEOUT_MS',
    };
    for (const text of [
      read('docs/features/python-runtime-execution.md'),
      read('packages/server/README.md'),
    ]) {
      expect(text).toMatch(/provisional/i);
      for (const [key, variable] of Object.entries(variables) as [
        keyof typeof settings,
        string,
      ][]) {
        expect(text).toContain(`\`${variable}\``);
        expect(text).toContain(`\`${String(settings[key])}\``);
      }
    }
  });

  it('keeps the exact Windows capability statement and the access caveat', () => {
    const page = read('docs/features/python-runtime-execution.md');
    const windows = describeRuntimeCapabilities('win32')[2]!;
    expect(page).toContain(windows);
    expect(page).toMatch(/not.*network restriction/i);
    expect(page).toMatch(/not.*sandbox/i);
  });
});
