import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getDisclosurePreview, grantDisclosureConsent } from '../../api/disclosure-queries';
import { DisclosureReviewPanel } from '../disclosure/disclosure-review-panel';
import { ds } from '../../design-system/tokens';

/** Show the exact repair instructions and FEAT-105 disclosure before an AI session starts. */
export function RepairReview({ uploadIds, instructions, taskId, decisions, onDecisionsChange, onApproved, onCancel }: { uploadIds: readonly number[]; instructions: string; taskId?: number; decisions?: Readonly<Record<string, string>>; onDecisionsChange?: (decisions: Readonly<Record<string, string>>) => void; onApproved: (consent: { consentId: number; payloadDigest: string }) => Promise<void>; onCancel: () => void }) {
  const preview = useQuery({ queryKey: ['repair-disclosure', taskId ?? 0, uploadIds.join(',')], queryFn: () => getDisclosurePreview(uploadIds) });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const approve = async ({ diagnostics }: { diagnostics: boolean }) => { if (!preview.data || pending) return; setPending(true); setError(undefined); try {
    const granted = await grantDisclosureConsent({ ...(taskId ? { taskId } : {}), uploadIds: preview.data.uploadIds, payloadDigest: preview.data.digest, scopeDiagnostics: diagnostics });
    await onApproved({ consentId: granted.id, payloadDigest: granted.payloadDigest });
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'The repair could not start.'); } finally { setPending(false); } };
  return <section className={ds.cardStack}><section className={ds.card}><h2 className={ds.sectionTitle}>Instructions for the AI</h2><pre className={ds.historyPrompt}>{instructions}</pre></section>
    {preview.isPending ? <p>Preparing the disclosure review…</p> : preview.data ? <DisclosureReviewPanel key={preview.data.digest} preview={preview.data} pending={pending} error={error} initialDecisions={decisions} onDecisionsChange={onDecisionsChange} onApprove={(value) => void approve(value)} onRefresh={() => void preview.refetch()} onCancel={onCancel} /> : <p className={ds.statusDanger}>The disclosure review could not be loaded.</p>}
  </section>;
}
