import { describe, expect, it } from 'vitest';
import { describeLineageEdge, describeLineageOrigin, excerptReason } from '../../history/run-wording';

describe('run lineage wording', () => {
  it('makes one bounded line without discarding short reasons', () => {
    expect(excerptReason('  use\n the   Total column  ')).toBe('use the Total column');
    for (const blank of [null, '', '   ']) expect(excerptReason(blank)).toBeNull();
    expect(excerptReason('x'.repeat(140))).toBe('x'.repeat(140));
    expect(excerptReason('word '.repeat(60))?.length).toBeLessThanOrEqual(140);
    expect(excerptReason('x'.repeat(200))).toBe(`${'x'.repeat(139)}…`);
  });

  it('quotes a reason only when that reason explains the later run', () => {
    const base = { hasGuidance: true, reason: 'Use totals', reuse: null } as const;
    expect(describeLineageEdge({ ...base, trigger: 'rerun' })).toEqual({ label: 'Tried again with your guidance', quote: 'Use totals' });
    expect(describeLineageEdge({ ...base, trigger: 'feedback' })).toEqual({ label: 'Re-run after your review', quote: 'Use totals' });
    expect(describeLineageEdge({ ...base, trigger: 'manual' }).quote).toBeNull();
    expect(describeLineageEdge({ ...base, trigger: 'rerun', reuse: { kind: 'replay', templateId: 1, templateName: 'Sales', revisionNumber: 1 } }).quote).toBeNull();
  });

  it('names saved-task origins and handles deleted sources', () => {
    expect(describeLineageOrigin(null)).toBeNull();
    expect(describeLineageOrigin({ kind: 'run', templateId: 7, templateName: 'Sales', revisionNumber: 2 })).toBe('Ran “Sales” (revision 2) with another file');
    expect(describeLineageOrigin({ kind: 'repair', templateId: null, templateName: 'Sales', revisionNumber: 2 })).toBe('Repaired a saved task since deleted for another file');
  });
});
