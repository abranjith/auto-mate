import { describeAttempt, type ConversationEvent } from '@automate/core';
import { ds } from '../../design-system/tokens';

type TestRunFinished = Extract<ConversationEvent, { type: 'test_run_finished' }>;

/** "14 lines of output were not recognized as safe to send, so they were dropped." Null when nothing was dropped. */
export function withheldSentence(count: number | null): string | null {
  if (!count) return null;
  return count === 1 ? '1 line of output was not recognized as safe to send, so it was dropped.' : `${count.toLocaleString()} lines of output were not recognized as safe to send, so they were dropped.`;
}

/**
 * One test run: the counts, the FILTERED failure text the agent was shown,
 * and — stated plainly, never silently omitted — how many lines the
 * default-deny filter withheld. Diagnostics are model-adjacent output from
 * generated code: text only.
 */
export function TestRunResult({ event, diagnostics }: { event: TestRunFinished; diagnostics?: string | null }) {
  const headline = describeAttempt({ attempt: event.attempt, status: event.outcome, refusalReason: event.refusalReason, testsTotal: event.testsTotal, testsPassed: event.testsPassed, testsFailed: event.testsFailed });
  const withheld = withheldSentence(event.droppedLineCount);
  const tone = event.outcome === 'passed' ? ds.attemptPassed : event.outcome === 'refused' ? ds.statusMuted : ds.attemptFailed;
  return (
    <section className={ds.testResult} aria-label={`Test run for attempt ${event.attempt}`}>
      <p className={tone}>{headline}</p>
      {event.outcome !== 'refused' ? <p className={ds.hint}>{event.attemptsRemaining} of {event.attemptLimit} attempts left.</p> : null}
      {diagnostics ? <pre className={ds.diagnosticText}>{diagnostics}</pre> : null}
      {withheld ? <p className={ds.hint}>{withheld}</p> : null}
    </section>
  );
}
