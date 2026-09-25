import { createHash } from 'node:crypto';
import { assemblePromptContext, filterDiagnostics, utf8ByteLength, type AgentProvider, type AgentSession, type AgentSessionOptions, type UnnumberedConversationEvent } from '@automate/core';
import type { ClarificationRepository } from '../db/repositories/clarification-repository';
import type { DisclosureTransmissionRepository } from '../db/repositories/disclosure-transmission-repository';
import type { ExecutionRepository, ExecutionRow } from '../db/repositories/execution-repository';
import type { TaskRow } from '../db/repositories/task-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { RunStrategy } from '../conversation/run-strategy';
import type { DisclosureService } from './disclosure-service';
import type { AgentToolDefinition } from '@automate/core';

export interface DisclosureRunStrategyDependencies {
  readonly disclosure: DisclosureService;
  readonly transmissions: DisclosureTransmissionRepository;
  readonly uploads: UploadRepository;
  readonly clarifications: ClarificationRepository;
  readonly executions: ExecutionRepository;
  readonly clarificationTool: AgentToolDefinition;
  readonly maxDiagnosticBytes?: number;
  readonly publish?: (executionId: number, event: UnnumberedConversationEvent) => void;
}

/** Open the provider only after the disclosure strategy has built an approved run. */
export function openProviderSession(provider: AgentProvider, options: AgentSessionOptions): Promise<AgentSession> {
  return provider.open(options);
}

/** Send only the prompt returned by the disclosure construction boundary. */
export function runProviderSession(session: AgentSession, prompt: string) {
  return session.run(prompt);
}

/**
 * Extra prompt inputs a wrapping strategy supplies (FEAT-106). They go into the SAME
 * `assemblePromptContext` call, never a second one: application text as
 * `application_text`, and a retry's guidance inside the `user_prompt` source.
 */
export interface PromptExtras {
  readonly appText?: readonly string[];
  readonly guidance?: string | null;
}

/** The person's words for this run: the task, then any retry guidance they typed. */
function userWords(task: TaskRow, extras: PromptExtras): string {
  return extras.guidance ? `${task.description}\n\n${extras.guidance}` : task.description;
}

/** Approved file context and the clarification tool, with no generation policy. */
export class DisclosureRunStrategy implements RunStrategy {
  constructor(private readonly deps: DisclosureRunStrategyDependencies) {}

  buildRun(task: TaskRow, execution: ExecutionRow, extras: PromptExtras = {}) {
    if (this.deps.uploads.listByTask(task.id).length === 0) return { prompt: userWords(task, extras), customTools: [this.deps.clarificationTool] };
    const consent = this.deps.disclosure.verifyForTransmission(task.id, 'context');
    const answers = this.deps.clarifications.listByExecution(execution.id).filter(({ source, status }) => source === 'preflight' && status === 'answered').flatMap(({ questions }) => questions.map((question) => `${question.promptText}: ${question.answer ?? question.proposedDefault}`));
    const context = assemblePromptContext({ userPrompt: userWords(task, extras), disclosure: { text: consent.payloadSnapshot, consentId: consent.id }, appText: [...answers, ...(extras.appText ?? [])] });
    const summary = { files: (JSON.parse(consent.uploadIds) as number[]).length, tables: null, columns: null, sampleRows: null, truncations: null };
    const receipt = this.deps.transmissions.record({ executionId: execution.id, consentId: consent.id, kind: 'context', payloadDigest: consent.payloadDigest, payloadSnapshot: null, byteSize: consent.byteSize, summary, provider: consent.provider, model: consent.model });
    return { prompt: context.text, systemPrompt: 'Ask through request_clarification only when ambiguity changes meaning or risks data loss. State a rationale and a proposed default. Cosmetic choices must use a disclosed default.', customTools: [this.deps.clarificationTool], events: [{ type: 'disclosure_sent' as const, transmissionId: receipt.id, kind: 'context' as const, provider: receipt.provider, model: receipt.model, byteSize: receipt.byteSize, summary, at: receipt.at.toISOString() }] };
  }

  /** Filter and record the only supported diagnostic prompt input. */
  recordDiagnosticTransmission(executionId: number, rawDiagnostics: string): string {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new Error(`Execution ${executionId} was not found.`);
    const consent = this.deps.disclosure.verifyForTransmission(execution.taskId, 'diagnostics');
    const filtered = filterDiagnostics(rawDiagnostics, { maxBytes: this.deps.maxDiagnosticBytes });
    const digest = createHash('sha256').update(filtered.text).digest('hex');
    const summary = { exceptionType: filtered.exceptionType, frameCount: filtered.frames.length, droppedLineCount: filtered.droppedLineCount, maskedLiteralCount: filtered.maskedLiteralCount };
    const receipt = this.deps.transmissions.record({ executionId, consentId: consent.id, kind: 'diagnostics', payloadDigest: digest, payloadSnapshot: filtered.text, byteSize: utf8ByteLength(filtered.text), summary, provider: consent.provider, model: consent.model });
    this.deps.publish?.(executionId, { type: 'disclosure_sent', transmissionId: receipt.id, kind: 'diagnostics', provider: receipt.provider, model: receipt.model, byteSize: receipt.byteSize, summary, at: receipt.at.toISOString() });
    return filtered.text;
  }
}
