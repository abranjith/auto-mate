import { useQuery } from '@tanstack/react-query';
import { getDisclosureReceipts } from '../../api/disclosure-queries';
import { getClarifications } from '../../api/clarification-mutations';
import { getCodeVersion } from '../../api/generation-queries';
import { getVerification, getRun } from '../../api/verification-queries';
import { getArtifacts } from '../../api/artifact-queries';
import { ClarificationCard } from '../conversation/clarification-card';
import { DisclosureReceipt } from '../disclosure/disclosure-receipt';
import { CodeVersionCard } from '../generation/code-version-card';
import { VerificationReport } from '../verification/verification-report';
import { RunResult } from '../execution/run-result';
import { ArtifactList } from '../artifacts/artifact-list';
import { ds } from '../../design-system/tokens';
import type { DetailKind } from './record-section';

/** Loads each section from its owning feature endpoint on first expansion. */
export function RecordDetail({ kind, executionId, resourceId, savedRevisionNumber }: { kind: DetailKind; executionId: number; resourceId?: number; savedRevisionNumber?: number }) {
  const disclosure = useQuery({ queryKey: ['disclosure', executionId], queryFn: () => getDisclosureReceipts(executionId), enabled: kind === 'disclosure' });
  const questions = useQuery({ queryKey: ['clarifications', executionId], queryFn: () => getClarifications(executionId), enabled: kind === 'questions' });
  const code = useQuery({ queryKey: ['code-version', resourceId], queryFn: () => getCodeVersion(resourceId!), enabled: kind === 'code' && resourceId !== undefined });
  const checks = useQuery({ queryKey: ['verification', executionId], queryFn: () => getVerification(executionId), enabled: kind === 'checks' });
  const run = useQuery({ queryKey: ['script-run', executionId], queryFn: () => getRun(executionId), enabled: kind === 'run' });
  const outputs = useQuery({ queryKey: ['artifacts', executionId], queryFn: () => getArtifacts(executionId), enabled: kind === 'outputs' });
  if (kind === 'disclosure') return disclosure.isPending ? <p className={ds.hint}>Loading what was sent…</p> : <div className={ds.stackTight}>{disclosure.data?.map((entry) => <DisclosureReceipt key={entry.id} executionId={executionId} initialReceipt={entry} event={{ seq: entry.id, type: 'disclosure_sent', transmissionId: entry.id, kind: entry.kind, byteSize: entry.byteSize, provider: entry.provider, model: entry.model, summary: entry.summary, at: entry.at }} />)}</div>;
  if (kind === 'questions') return questions.isPending ? <p className={ds.hint}>Loading questions…</p> : <div className={ds.stackTight}>{questions.data?.map((item) => <ClarificationCard key={item.id} clarification={item} questionById={new Map((questions.data ?? []).flatMap(({ questions: entries }) => (entries ?? []).map((question) => [question.id, question] as const)))} />)}</div>;
  if (kind === 'checks') return checks.data ? <VerificationReport report={checks.data} /> : <p className={ds.hint}>Loading checks…</p>;
  // The run's outputs are their own section; the run view shows the run alone, so each endpoint is fetched once.
  if (kind === 'run') return run.data ? <RunResult run={run.data} /> : <p className={ds.hint}>Loading the run…</p>;
  if (kind === 'outputs') return outputs.data ? <ArtifactList list={outputs.data} /> : <p className={ds.hint}>Loading outputs…</p>;
  if (kind === 'code' && code.data) return <CodeVersionCard initialDetail={code.data} {...(savedRevisionNumber === undefined ? {} : { savedRevisionNumber })} event={{ seq: code.data.id, type: 'code_version_sealed', codeVersionId: code.data.id, attempt: code.data.attempt, digest: code.data.contentDigest!, files: code.data.files.map((file) => ({ path: file.path, role: file.role, byteSize: file.byteSize, lineCount: file.lineCount })), at: code.data.sealedAt ?? code.data.createdAt }} />;
  return <p className={ds.hint}>Open the transcript below to see this run&apos;s code versions.</p>;
}
