import { useState } from 'react';
import type { ConversationEvent, TransmissionReceipt } from '@automate/core';
import { getDisclosureReceipts } from '../../api/disclosure-queries';
import { ds } from '../../design-system/tokens';
type Event = Extract<ConversationEvent, { type: 'disclosure_sent' }>;
export function DisclosureReceipt({ executionId, event }: { executionId: number; event: Event }) {
  const [receipt, setReceipt] = useState<TransmissionReceipt>();
  const [loading, setLoading] = useState(false);
  const expand = async () => { if (receipt || loading) return; setLoading(true); try { setReceipt((await getDisclosureReceipts(executionId)).find(({ id }) => id === event.transmissionId)); } finally { setLoading(false); } };
  return <details className={ds.receipt} onToggle={(toggle) => { if (toggle.currentTarget.open) void expand(); }}><summary>Sent {event.kind === 'context' ? 'the file description' : 'filtered diagnostics'} to {event.provider} <code className={ds.inlineCode}>{event.model}</code> — {event.byteSize.toLocaleString()} bytes</summary>{loading ? <p className={ds.hint}>Loading exact bytes…</p> : null}{receipt ? <pre className={ds.codeBlock}>{receipt.payloadSnapshot ?? ''}</pre> : null}</details>;
}
