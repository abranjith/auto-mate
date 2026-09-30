import { useEffect, useState } from 'react';
import { isTerminal, type ConversationEvent, type ExecutionSummary, type GenerationAttemptListResponse } from '@automate/core';
import { getAttempts } from '../../api/generation-queries';
import { GenerationProgress } from './generation-progress';

const GENERATION_KINDS = new Set<ConversationEvent['type']>(['code_version_sealed', 'test_run_finished', 'generation_settled']);

/** True once a run is generating code against an approved file, rather than answering a text-only task. */
export function isGenerationRun(events: readonly ConversationEvent[]): boolean {
  return events.some((event) => GENERATION_KINDS.has(event.type) || (event.type === 'disclosure_sent' && event.kind === 'context'));
}

/** Progress while a generation run is active. */
export function GenerationSection({ execution, events, loadAttempts = getAttempts }: { execution: ExecutionSummary; events: readonly ConversationEvent[]; loadAttempts?: (executionId: number) => Promise<GenerationAttemptListResponse> }) {
  const [attempts, setAttempts] = useState<GenerationAttemptListResponse>();
  const [now, setNow] = useState(() => Date.now());
  const generation = isGenerationRun(events);
  // Generation is active only while the agent works; verification and the gates have their own section (FEAT-107).
  const active = !isTerminal(execution.status) && ['pending', 'generating', 'waiting'].includes(execution.status);
  const milestones = events.filter((event) => GENERATION_KINDS.has(event.type)).length;
  useEffect(() => {
    if (!generation || !active) return;
    let live = true;
    void loadAttempts(execution.id).then((result) => { if (live) setAttempts(result); }, () => undefined);
    return () => { live = false; };
  }, [execution.id, generation, milestones, active, loadAttempts]);
  useEffect(() => {
    if (!active || !generation) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [active, generation]);
  if (!generation) return null;
  if (active) return <GenerationProgress events={events} startedAt={execution.startedAt} now={now} {...(attempts ? { limits: attempts.limits } : {})} />;
  return null;
}
