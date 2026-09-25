import { CHECK_KEYS, type CheckKey, type VerificationReport as Report } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { FindingList } from './finding-list';
import { RuntimeNote } from './runtime-note';

/** Plain names for the seven checks, in policy order. */
export const CHECK_LABELS: Readonly<Record<CheckKey, string>> = {
  integrity: 'The code and its test data match what was recorded',
  contract_entrypoint: 'The script has a starting point',
  contract_inputs: 'Every column the script needs is in your file',
  contract_outputs: 'The script says clearly what it will produce',
  lint: 'Code errors (ruff)',
  security: 'Security problems (bandit)',
  tests: 'The tests, re-run by this app',
};
const ICONS = { passed: '✓', failed: '✗', errored: '!', skipped: '–' } as const;
const ICON_LABELS = { passed: 'Passed', failed: 'Failed', errored: 'Could not run', skipped: 'Not run' } as const;

/**
 * The verification report: one line per check with its blocking or advisory
 * badge, findings expandable per check, and the runtime it applies to. A
 * blocked report reads as a sentence, and there is no way to run from here.
 */
export function VerificationReport({ report }: { report: Report }) {
  const checks = [...report.checks].sort((left, right) => CHECK_KEYS.indexOf(left.checkKey) - CHECK_KEYS.indexOf(right.checkKey));
  const blocked = report.status !== 'passed';
  return (
    <section className={ds.verificationReport} aria-label="Code check results">
      <p className={blocked ? ds.verdictBlocked : ds.verdictPassed}>{report.summary ?? 'Checking the code…'}</p>
      <ul className={ds.checkList}>
        {checks.map((check) => {
          const findings = report.findings.filter(({ checkKey }) => checkKey === check.checkKey);
          return (
            <li key={check.checkKey} className={ds.checkRow} data-check={check.checkKey}>
              <div className={ds.checkHeader}>
                <span className={ds.checkIcon} role="img" aria-label={ICON_LABELS[check.status]}>{ICONS[check.status]}</span>
                <span>{CHECK_LABELS[check.checkKey]}</span>
                <span className={check.isBlocking ? ds.badgeBlocking : ds.badgeAdvisory}>{check.isBlocking ? 'Blocking' : 'Advisory'}</span>
              </div>
              <span className={ds.textMuted}>{check.summary}</span>
              {findings.length > 0 ? (
                <details>
                  <summary className={ds.codeCardSummary}>Show {findings.length} finding{findings.length === 1 ? '' : 's'}</summary>
                  <FindingList findings={findings} />
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
      <RuntimeNote description={report.runtimeDescription} />
    </section>
  );
}
