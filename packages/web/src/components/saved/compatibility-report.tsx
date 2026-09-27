import { describeCompatibilityFinding, describeCompatibilityStatus, type CompatibilityReport as Report } from '@automate/core';
import { ds } from '../../design-system/tokens';

export function CompatibilityReport({ report }: { report: Report }) {
  return <section className={ds.card} aria-label="Compatibility report"><h2 className={ds.sectionTitle}>Fit check</h2><p>{describeCompatibilityStatus(report.status)}</p>
    <ul className={ds.noteList}>{report.findings.filter((finding) => finding.severity !== 'info').map((finding, index) => { const words = describeCompatibilityFinding(finding); return <li key={index}><strong>{words.headline}</strong> — {words.detail}</li>; })}</ul>
  </section>;
}
