import { describe, expect, expectTypeOf, it } from 'vitest';
import { EXECUTION_STATUSES, PARKED_STATUSES, TERMINAL_STATUSES, INTERRUPTED_ON_RESTART, SURVIVES_RESTART, INTERRUPTION_MESSAGES } from '../../conversation/execution-state';
import { HISTORY_STATUS_GROUPS, statusGroupOf } from '../../history/history-status';
import { describeNeedsYou, describeRunState, describeTrigger, type ExecutionTrigger } from '../../history/run-wording';
import type { ExecutionStatus } from '../../conversation/execution-state';

describe('history status and recovery', () => {
  it('classifies every state into exactly one filter', () => {
    for (const status of EXECUTION_STATUSES) {
      const groups = Object.entries(HISTORY_STATUS_GROUPS).filter(([, statuses]) => (statuses as readonly string[]).includes(status));
      expect(groups).toHaveLength(1);
      expect(statusGroupOf(status)).toBe(groups[0]?.[0]);
    }
    expect(HISTORY_STATUS_GROUPS.needs_you).toEqual(PARKED_STATUSES);
  });

  it('resolves the FEAT-105/FEAT-107 waiting restart conflict', () => {
    expect(INTERRUPTED_ON_RESTART).toContain('waiting');
    expect(SURVIVES_RESTART).not.toContain('waiting');
    const open = EXECUTION_STATUSES.filter((status) => !(TERMINAL_STATUSES as readonly string[]).includes(status));
    expect(new Set([...INTERRUPTED_ON_RESTART, ...SURVIVES_RESTART])).toEqual(new Set(open));
    expect(INTERRUPTED_ON_RESTART.filter((status) => (SURVIVES_RESTART as readonly string[]).includes(status))).toEqual([]);
    for (const status of INTERRUPTED_ON_RESTART) expect(INTERRUPTION_MESSAGES[status].length).toBeGreaterThan(15);
  });

  it('has usable wording for every status and recorded outcome', () => {
    for (const status of EXECUTION_STATUSES) for (const errorCode of [null, 'EXECUTION_INTERRUPTED', 'EXECUTION_STOPPED_ON_SHUTDOWN', 'OTHER']) {
      const { label } = describeRunState({ status, errorCode });
      expect(label).not.toMatch(/error|exception|EXECUTION_/i);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(describeRunState({ status: 'failed', errorCode: 'EXECUTION_INTERRUPTED' }).label).toBe('Interrupted');
    expect(describeRunState({ status: 'aborted', errorCode: 'EXECUTION_STOPPED_ON_SHUTDOWN' }).label).toBe('Stopped when the app closed');
    expect(['manual', 'rerun', 'feedback'].map((trigger) => describeTrigger(trigger as 'manual' | 'rerun' | 'feedback', { hasGuidance: true }))).toEqual(['First run', 'Tried again with your guidance', 'Re-run after your review']);
    for (const status of PARKED_STATUSES) expect(describeNeedsYou(status)).toBeTruthy();
  });

  it('types each wording function over the full union its switch must cover', () => {
    // Each switch ends in `satisfies never`, so adding a status or trigger without wording fails to compile.
    expectTypeOf<Parameters<typeof describeRunState>[0]['status']>().toEqualTypeOf<ExecutionStatus>();
    expectTypeOf<Parameters<typeof describeTrigger>[0]>().toEqualTypeOf<ExecutionTrigger>();
    expectTypeOf<ExecutionTrigger>().toEqualTypeOf<'manual' | 'rerun' | 'feedback'>();
    expectTypeOf<Parameters<typeof describeNeedsYou>[0]>().toEqualTypeOf<(typeof PARKED_STATUSES)[number]>();
    expect(describeTrigger('rerun', { hasGuidance: false })).toBe('Tried again');
  });
});
