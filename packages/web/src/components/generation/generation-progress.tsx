import type { ConversationEvent, GenerationLimits } from '@automate/core';
import { ds } from '../../design-system/tokens';

type GenerationEvent = Extract<ConversationEvent, { type: 'code_version_sealed' | 'test_run_finished' | 'generation_settled' }>;

/** Where the loop is, from the latest generation event. */
export function generationPhase(events: readonly ConversationEvent[]): { attempt: number; phase: string } {
  const generation = events.filter((event): event is GenerationEvent => event.type === 'code_version_sealed' || event.type === 'test_run_finished' || event.type === 'generation_settled').sort((a, b) => a.seq - b.seq);
  const attempt = Math.max(0, ...generation.flatMap((event) => (event.type === 'generation_settled' ? [] : [event.attempt])));
  const last = generation.at(-1);
  if (!last) return { attempt: 1, phase: 'writing the script' };
  if (last.type === 'generation_settled') return { attempt: Math.max(1, attempt), phase: 'finished' };
  if (last.type === 'code_version_sealed') return { attempt: last.attempt, phase: 'running its tests' };
  if (last.outcome === 'passed') return { attempt: last.attempt, phase: 'tests passed; choosing the final version' };
  if (last.outcome === 'refused') return { attempt: last.attempt, phase: 'no more test runs; choosing the final version' };
  return { attempt: last.attempt + 1, phase: 'repairing the script' };
}

/** Time spent parked in `waiting` for a person's answer, which the server's wall clock does not count either. */
export function waitingMs(events: readonly ConversationEvent[], now: number): number {
  let total = 0;
  let since: number | null = null;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type !== 'state_changed') continue;
    if (event.to === 'waiting' && since === null) since = Date.parse(event.at);
    else if (event.from === 'waiting' && since !== null) { total += Math.max(0, Date.parse(event.at) - since); since = null; }
  }
  return since === null ? total : total + Math.max(0, now - since);
}

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;

/** "Attempt 2 of 3 — running its tests", plus the elapsed share of the wall-clock budget, excluding time spent waiting for an answer. */
export function GenerationProgress({ events, limits, startedAt, now = Date.now() }: { events: readonly ConversationEvent[]; limits?: GenerationLimits; startedAt?: string | null; now?: number }) {
  const { attempt, phase } = generationPhase(events);
  const cap = limits?.maxAttempts;
  const elapsed = startedAt ? Math.max(0, now - new Date(startedAt).getTime() - waitingMs(events, now)) : null;
  return (
    <section className={ds.generationProgress} aria-live="polite" aria-label="Code generation progress">
      <strong>{cap ? `Attempt ${Math.min(attempt, cap)} of ${cap}` : `Attempt ${attempt}`}</strong>
      <span>— {phase}</span>
      {limits && elapsed !== null ? (
        <>
          <progress className={ds.progressTrack} value={Math.min(elapsed, limits.timeoutMs)} max={limits.timeoutMs} aria-label="Time used" />
          <span className={ds.hint}>{minutes(elapsed)} of {minutes(limits.timeoutMs)}</span>
        </>
      ) : null}
    </section>
  );
}
