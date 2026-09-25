import { useEffect, useState } from 'react';
import { isTerminal, type ConversationEvent, type CreateTaskResponse, type ExecutionSummary, type GenerationAttemptListResponse } from '@automate/core';
import { getAttempts } from '../../api/generation-queries';
import { GenerationFailurePanel } from './generation-failure-panel';
import { GenerationProgress } from './generation-progress';

const GENERATION_KINDS = new Set<ConversationEvent['type']>(['code_version_sealed', 'test_run_finished', 'generation_settled']);

/** True once a run is generating code against an approved file, rather than answering a text-only task. */
export function isGenerationRun(events: readonly ConversationEvent[]): boolean {
  return events.some((event) => GENERATION_KINDS.has(event.type) || (event.type === 'disclosure_sent' && event.kind === 'context'));
}

/** Progress while a generation run is active; the guidance retry once it has failed. */
export function GenerationSection({ execution, events, onRetried, loadAttempts = getAttempts }: { execution: ExecutionSummary; events: readonly ConversationEvent[]; onRetried?: (created: CreateTaskResponse) => void; loadAttempts?: (executionId: number) => Promise<GenerationAttemptListResponse> }) {
  const [attempts, setAttempts] = useState<GenerationAttemptListResponse>();
  const [now, setNow] = useState(() => Date.now());
  const generation = isGenerationRun(events);
  const active = !isTerminal(execution.status);
  const milestones = events.filter((event) => GENERATION_KINDS.has(event.type)).length;
  useEffect(() => {
    if (!generation) return;
    let live = true;
    void loadAttempts(execution.id).then((result) => { if (live) setAttempts(result); }, () => undefined);
    return () => { live = false; };
  }, [execution.id, generation, milestones, execution.status, loadAttempts]);
  useEffect(() => {
    if (!active || !generation) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [active, generation]);
  if (!generation) return null;
  const settled = [...events].reverse().find((event): event is Extract<ConversationEvent, { type: 'generation_settled' }> => event.type === 'generation_settled');
  if (active) return <GenerationProgress events={events} startedAt={execution.startedAt} now={now} {...(attempts ? { limits: attempts.limits } : {})} />;
  if (execution.status !== 'failed' || !settled) return null;
  return <GenerationFailurePanel execution={execution} attempts={attempts?.attempts ?? []} summary={settled.summary} {...(onRetried ? { onRetried } : {})} />;
}
