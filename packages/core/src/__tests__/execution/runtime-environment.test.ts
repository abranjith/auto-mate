import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  LIMIT_BREACHES,
  POSIX_MEMORY_CAPABILITY,
  WINDOWS_MEMORY_CAPABILITY,
  describeLimitBreach,
  describeRuntimeCapabilities,
} from '../../execution/runtime-environment';
import { RuntimePrepareRequestSchema, RuntimeStatusResponseSchema } from '../../contracts/runtime-api';
import { AutoMateError } from '../../errors/automate-error';
import { ScriptLimitExceededError, RuntimeLockMismatchError, NonPythonEntrypointError } from '../../errors/runtime-errors';

describe('runtime contracts', () => {
  it('describes every limit in human units', () => {
    for (const breach of LIMIT_BREACHES) expect(describeLimitBreach(breach)).toMatch(/stopped\./);
    expect(describeLimitBreach('time')).toContain('15 minutes');
    expect(describeLimitBreach('memory')).toContain('4 GB');
    expect(describeLimitBreach('output_bytes')).toContain('1 GB');
    expect(describeLimitBreach('output_files')).toContain('200 output files');
    expect(describeLimitBreach('memory', { timeoutMs: 1, memoryBytes: 0, maxOutputTotalBytes: 0, maxOutputFiles: 1 })).not.toContain('0 memory');
  });

  it('states the platform memory gap in one place', () => {
    expect(describeRuntimeCapabilities('win32')).toContain(WINDOWS_MEMORY_CAPABILITY);
    for (const platform of ['darwin', 'linux']) {
      expect(describeRuntimeCapabilities(platform)).toContain(POSIX_MEMORY_CAPABILITY);
      expect(describeRuntimeCapabilities(platform)).not.toContain(WINDOWS_MEMORY_CAPABILITY);
    }
  });

  it('serializes TypeBox contracts and typed errors without a stack', () => {
    const request = { kind: 'script' };
    const status = { pinnedPythonVersion: '3.14.6', script: { ready: false, environment: null, reason: 'Preparing' }, verify: { ready: false, environment: null, reason: null }, capabilities: describeRuntimeCapabilities('win32') };
    for (const [schema, value] of [[RuntimePrepareRequestSchema, request], [RuntimeStatusResponseSchema, status]] as const) {
      expect(Value.Check(schema, value)).toBe(true);
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
    for (const error of [new ScriptLimitExceededError('time'), new RuntimeLockMismatchError(), new NonPythonEntrypointError()]) {
      expect(error).toBeInstanceOf(AutoMateError);
      expect(error.toJSON()).toEqual({ error: { code: error.code, message: error.message } });
      expect(JSON.stringify(error.toJSON())).not.toContain('stack');
    }
  });
});
