import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { assemblePromptContext } from '@automate/core';
import { DisclosureRunStrategy } from '../../disclosure/disclosure-run-strategy';

const task = { id: 4, name: 'Task', description: 'Summarize', createdAt: new Date(), updatedAt: new Date() };
const execution = { id: 8, taskId: 4, status: 'pending', trigger: 'manual', agentSessionId: null, agentLogPath: null, provider: null, model: null, errorCode: null, errorMessage: null, usageTurns: null, usageInputTokens: null, usageOutputTokens: null, usageCostUsd: null, startedAt: null, completedAt: null, durationMs: null, retryOfExecutionId: null, guidance: null, reviewFeedback: null, reviewedAt: null, createdAt: new Date() };
const consent = { id: 2, taskId: 4, uploadIds: '[1]', payloadDigest: 'a'.repeat(64), payloadSnapshot: 'APPROVED BYTES', byteSize: 14, provider: 'test', model: 'fake', scopeContext: true, scopeDiagnostics: true, grantedAt: new Date(), revokedAt: null, createdAt: new Date() };
const tool = { name: 'request_clarification', description: 'ask', parameters: Type.Object({}), execute: async () => ({}) };

describe('DisclosureRunStrategy', () => {
  it('builds from the consent snapshot and records before returning the provider prompt', () => {
    const verify = vi.fn(() => consent);
    const record = vi.fn(() => ({ id: 9, executionId: 8, consentId: 2, kind: 'context', payloadDigest: consent.payloadDigest, payloadSnapshot: null, byteSize: 14, summary: '{}', provider: 'test', model: 'fake', at: new Date() }));
    const strategy = new DisclosureRunStrategy({ disclosure: { verifyForTransmission: verify } as never, transmissions: { record } as never, uploads: { listByTask: () => [{}] } as never, clarifications: { listByExecution: () => [] } as never, executions: { getById: () => execution } as never, clarificationTool: tool });
    const built = strategy.buildRun(task, execution);
    expect(built.prompt).toBe(assemblePromptContext({ userPrompt: 'Summarize', disclosure: { text: 'APPROVED BYTES', consentId: 2 }, appText: [] }).text);
    expect(record).toHaveBeenCalledOnce();
    expect(built.events?.[0]).toMatchObject({ type: 'disclosure_sent', transmissionId: 9 });
  });

  it('keeps text-only tasks unchanged and records no receipt', () => {
    const verify = vi.fn(); const record = vi.fn();
    const strategy = new DisclosureRunStrategy({ disclosure: { verifyForTransmission: verify } as never, transmissions: { record } as never, uploads: { listByTask: () => [] } as never, clarifications: { listByExecution: () => [] } as never, executions: { getById: () => execution } as never, clarificationTool: tool });
    expect(strategy.buildRun(task, execution).prompt).toBe('Summarize');
    expect(verify).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  });

  it('filters diagnostics before storing or returning them', () => {
    const record = vi.fn((input) => ({ id: 10, ...input, summary: JSON.stringify(input.summary), at: new Date() }));
    const strategy = new DisclosureRunStrategy({ disclosure: { verifyForTransmission: () => consent } as never, transmissions: { record } as never, uploads: { listByTask: () => [{}] } as never, clarifications: { listByExecution: () => [] } as never, executions: { getById: () => execution } as never, clarificationTool: tool });
    const filtered = strategy.recordDiagnosticTransmission(8, "ValueError: bad 'Jane secret'");
    expect(filtered).not.toContain('Jane');
    expect(record.mock.calls[0]?.[0].payloadSnapshot).toBe(filtered);
  });

  it('applies the configured diagnostic byte ceiling', () => {
    const record = vi.fn((input) => ({ id: 11, ...input, summary: JSON.stringify(input.summary), at: new Date() }));
    const strategy = new DisclosureRunStrategy({ disclosure: { verifyForTransmission: () => consent } as never, transmissions: { record } as never, uploads: { listByTask: () => [{}] } as never, clarifications: { listByExecution: () => [] } as never, executions: { getById: () => execution } as never, clarificationTool: tool, maxDiagnosticBytes: 20 });
    const filtered = strategy.recordDiagnosticTransmission(8, "ValueError: bad 'Jane secret'");
    expect(new TextEncoder().encode(filtered).byteLength).toBeLessThanOrEqual(20);
    expect(record.mock.calls[0]?.[0].byteSize).toBeLessThanOrEqual(20);
  });
});
