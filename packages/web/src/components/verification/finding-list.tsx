import type { VerificationFinding } from '@automate/core';
import { ds } from '../../design-system/tokens';

const SEVERITY_CLASS = { high: ds.severityHigh, medium: ds.severityMedium, low: ds.severityLow, info: ds.severityLow } as const;

/** Group findings by file, keeping the order they were reported in. Findings not about a file come first. */
export function groupByFile(findings: readonly VerificationFinding[]): [string | null, VerificationFinding[]][] {
  const groups = new Map<string | null, VerificationFinding[]>();
  for (const finding of findings) groups.set(finding.filePath, [...(groups.get(finding.filePath) ?? []), finding]);
  return [...groups.entries()].sort(([left], [right]) => (left === null ? -1 : right === null ? 1 : 0));
}

/**
 * One check's findings, grouped by file. Every message is tool output about
 * model-written code — untrusted — and renders as a text node only.
 */
export function FindingList({ findings }: { findings: readonly VerificationFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className={ds.stackTight}>
      {groupByFile(findings).map(([file, items]) => (
        <div key={file ?? '(general)'} className={ds.findingGroup}>
          <span className={ds.findingFile}>{file ?? 'About the whole script'}</span>
          <ul className={ds.findingList}>
            {items.map((finding) => (
              <li key={finding.id} className={ds.findingItem}>
                <span className={SEVERITY_CLASS[finding.severity]}>{finding.severity}</span>
                <span className={finding.isBlocking ? ds.badgeBlocking : ds.badgeAdvisory}>{finding.isBlocking ? 'blocks' : 'advisory'}</span>
                {finding.line === null ? null : <span className={ds.digest}>line {finding.line}</span>}
                <span className={ds.digest}>{finding.ruleCode}</span>
                <span className={ds.findingMessage}>{finding.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
