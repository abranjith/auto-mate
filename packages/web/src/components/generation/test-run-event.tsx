import { useEffect, useState } from 'react';
import type { ConversationEvent, GenerationAttemptListResponse, SyntheticFixture } from '@automate/core';
import { getAttempts, getFixturesOnce } from '../../api/generation-queries';
import { FixtureNote } from './fixture-note';
import { TestRunResult } from './test-run-result';

type TestRunFinished = Extract<ConversationEvent, { type: 'test_run_finished' }>;

/**
 * A `test_run_finished` transcript entry. The event carries counts only; the
 * filtered failure text and the fixture preview are fetched from REST, the
 * same receipt pattern FEAT-105 uses for what was disclosed.
 */
export function TestRunEvent({ event, executionId, loadAttempts = getAttempts, loadFixtures = getFixturesOnce }: { event: TestRunFinished; executionId?: number; loadAttempts?: (id: number) => Promise<GenerationAttemptListResponse>; loadFixtures?: (id: number) => Promise<readonly SyntheticFixture[]> }) {
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<readonly SyntheticFixture[]>();
  const failed = event.outcome !== 'passed' && event.outcome !== 'refused' && event.outcome !== 'aborted';
  useEffect(() => {
    if (executionId === undefined) return;
    let live = true;
    if (failed) void loadAttempts(executionId).then((result) => { if (live) setDiagnostics(result.attempts.find(({ id }) => id === event.attemptId)?.diagnostics ?? null); }, () => undefined);
    if (event.outcome !== 'refused') void loadFixtures(executionId).then((result) => { if (live) setFixtures(result); }, () => undefined);
    return () => { live = false; };
  }, [executionId, event.attemptId, event.outcome, failed, loadAttempts, loadFixtures]);
  return (
    <div>
      <TestRunResult event={event} diagnostics={diagnostics} />
      {event.outcome !== 'refused' ? <FixtureNote {...(fixtures ? { fixtures } : {})} /> : null}
    </div>
  );
}
