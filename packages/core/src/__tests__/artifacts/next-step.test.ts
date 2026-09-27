import { describe, expect, it } from 'vitest';
import { LIMIT_BREACHES, describeLimitBreach, type LimitBreach } from '../../execution/runtime-environment';
import { SCRIPT_RUN_STATUSES } from '../../contracts/verification-api';
import { NEXT_STEP_ACTIONS, describeRunOutcome, type RunOutcomeInput } from '../../artifacts/next-step';

const breaches: (LimitBreach | null)[] = [null, ...LIMIT_BREACHES];
const manifests = [true, false, null];
const counts = [0, 1, 3];
const exitCodes = [0, 1, null];

function run(overrides: Partial<RunOutcomeInput>): RunOutcomeInput {
  return { status: 'succeeded', exitCode: 0, limitBreached: null, manifestPresent: true, declaredOutputCount: 1, missingDeclaredCount: 0, ...overrides };
}

describe('describeRunOutcome', () => {
  it('is total: every status × breach × manifest × artifact count × exit code has a headline, a detail, and a next step', () => {
    let cells = 0;
    for (const status of SCRIPT_RUN_STATUSES) for (const limitBreached of breaches) for (const manifestPresent of manifests) for (const count of counts) for (const exitCode of exitCodes) {
      const outcome = describeRunOutcome(run({ status, limitBreached, manifestPresent, exitCode, declaredOutputCount: 3, missingDeclaredCount: 1 }), Array.from({ length: count }));
      expect(outcome.headline.trim(), `${status}/${limitBreached}/${manifestPresent}/${count}`).not.toBe('');
      expect(outcome.detail.trim()).not.toBe('');
      expect(outcome.nextSteps.length).toBeGreaterThan(0);
      for (const step of outcome.nextSteps) expect(NEXT_STEP_ACTIONS).toContain(step.action);
      expect(new Set(outcome.nextSteps.map((step) => step.action)).size).toBe(outcome.nextSteps.length);
      expect(`${outcome.headline} ${outcome.detail}`).not.toMatch(/Traceback|exit code|[A-Za-z]:\\|\/home\/|\/Users\//);
      if (count === 0) expect(outcome.nextSteps.map((step) => step.action)).not.toContain('download_produced');
      cells += 1;
    }
    expect(cells).toBe(SCRIPT_RUN_STATUSES.length * breaches.length * manifests.length * counts.length * exitCodes.length);
  });

  it('keeps a successful run with results calm', () => {
    const outcome = describeRunOutcome(run({}), [{}, {}]);
    expect(outcome.tone).toBe('success');
    expect(outcome.headline).toBe('Your results are ready.');
    expect(`${outcome.headline} ${outcome.detail}`).not.toMatch(/error|fail|problem|wrong/i);
    expect(outcome.nextSteps.map((step) => step.action)).toEqual(['review_result', 'download_produced']);
  });

  it('does not call a clean exit with no outputs an error, because it was not one', () => {
    const noManifest = describeRunOutcome(run({ status: 'failed', manifestPresent: false }), []);
    expect(noManifest.headline).toBe('The script finished but did not say what it produced.');
    expect(noManifest.headline).not.toMatch(/error/i);
    expect(noManifest.nextSteps.map((step) => step.action)).toContain('retry_with_detail');
    const nothing = describeRunOutcome(run({ declaredOutputCount: 0 }), []);
    expect(`${nothing.headline} ${nothing.detail}`).not.toMatch(/error/i);
    expect(nothing.tone).toBe('notice');
  });

  it('words every limit breach with FEAT-108\'s sentence, verbatim', () => {
    for (const breach of LIMIT_BREACHES) {
      const outcome = describeRunOutcome(run({ status: breach === 'time' ? 'timed_out' : 'failed', limitBreached: breach, exitCode: null }), [{}]);
      expect(outcome.limit).toBe(describeLimitBreach(breach));
      expect(outcome.detail).toBe('The 1 file it wrote before stopping is kept below.');
      expect(outcome.nextSteps.map((step) => step.action)).toEqual(['adjust_request', 'download_produced', 'open_transcript']);
    }
    expect(describeRunOutcome(run({ status: 'timed_out', limitBreached: null, exitCode: null }), []).limit).toBe(describeLimitBreach('time'));
    expect(describeRunOutcome(run({}), [{}]).limit).toBeNull();
  });

  it('names both numbers when promised files are missing, and offers what was produced', () => {
    const outcome = describeRunOutcome(run({ status: 'failed', declaredOutputCount: 3, missingDeclaredCount: 2 }), [{}]);
    expect(outcome.detail).toContain('3 files');
    expect(outcome.detail).toContain('2 were not written');
    expect(outcome.nextSteps[0]!.action).toBe('download_produced');
  });

  it('sends a run that could not start to Settings, and a running one to Stop', () => {
    expect(describeRunOutcome(run({ status: 'errored', exitCode: null }), []).nextSteps[0]!.action).toBe('prepare_runtime');
    expect(describeRunOutcome(run({ status: 'running', exitCode: null }), []).nextSteps[0]!.action).toBe('cancel');
  });

  it('keeps what a stopped run wrote', () => {
    const outcome = describeRunOutcome(run({ status: 'aborted', exitCode: null }), [{}, {}]);
    expect(outcome.detail).toContain('2 files it wrote before stopping are kept');
    expect(outcome.nextSteps.map((step) => step.action)).toContain('download_produced');
  });
});
