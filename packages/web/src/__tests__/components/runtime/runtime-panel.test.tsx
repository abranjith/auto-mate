import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeLimitBreach, describeRuntimeCapabilities, type RuntimeReadiness, type ScriptRun } from '@automate/core';
import { RuntimePanel } from '../../../components/runtime/runtime-panel';
import { RuntimeLimitsNote } from '../../../components/runtime/runtime-limits-note';
import { RunResult } from '../../../components/execution/run-result';

const unsafe = '<script>alert(1)</script><img src=x onerror=alert(1)>';
const environment = { kind: 'script' as const, status: 'ready' as const, pythonVersion: '3.14.6', uvVersion: 'uv 0.11.32', fingerprint: 'f'.repeat(64), lockDigest: 'aabbccddeeff', packageCount: 1, packages: [{ name: unsafe, version: unsafe }], preparedAt: '2026-09-25T00:00:00Z', failureReason: null };

function panel(script: RuntimeReadiness = { ready: true, environment, reason: null }) {
  const client = new QueryClient();
  client.setQueryData(['runtime', 'status'], { pinnedPythonVersion: '3.14.6', script, verify: { ready: false, environment: null, reason: unsafe }, capabilities: describeRuntimeCapabilities('win32') });
  return renderToStaticMarkup(<QueryClientProvider client={client}><RuntimePanel /></QueryClientProvider>);
}

describe('runtime Settings panel', () => {
  it('renders package details and untrusted tool text as escaped text', () => {
    const html = panel();
    expect(html).toContain('Script Python');
    expect(html).toContain('Code checkers');
    expect(html).toContain('1 packages');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });

  it('shows preparation and a failed reason', () => {
    const preparing = panel({ ready: false, environment: { ...environment, status: 'preparing' as const }, reason: null });
    expect(preparing).toContain('Preparing for 0 seconds');
    expect(preparing).toContain('disabled');
    const failed = panel({ ready: false, environment: { ...environment, status: 'failed' as const, failureReason: unsafe }, reason: unsafe });
    expect(failed).toContain('&lt;script&gt;');
  });

  it.each(['win32', 'darwin', 'linux'])('renders every %s capability sentence verbatim', (platform) => {
    const capabilities = describeRuntimeCapabilities(platform);
    const html = renderToStaticMarkup(<RuntimeLimitsNote capabilities={capabilities} />);
    for (const sentence of capabilities) expect(html).toContain(sentence);
  });
});

describe('run limit result', () => {
  const run: ScriptRun = { id: 1, executionId: 1, codeVersionId: 1, approvalId: 1, contentDigest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64), status: 'failed', exitCode: 93, stdout: null, stderr: null, outputTruncated: false, manifestPresent: null, declaredOutputs: [], declaredOutputCount: null, producedOutputCount: 0, outputByteCount: 2048, limitBreached: 'memory', runtimeLockDigest: 'c'.repeat(64), inputs: [], durationMs: 1, startedAt: '2026-09-25T00:00:00Z', settledAt: '2026-09-25T00:00:01Z' };
  it.each(['time', 'memory', 'output_bytes', 'output_files'] as const)('renders %s with the shared sentence', (breach) => {
    expect(renderToStaticMarkup(<RunResult run={{ ...run, limitBreached: breach }} />)).toContain(describeLimitBreach(breach));
  });
  it('has no limit sentence when no limit was breached', () => {
    expect(renderToStaticMarkup(<RunResult run={{ ...run, limitBreached: null }} />)).not.toContain(describeLimitBreach('memory'));
  });
});
