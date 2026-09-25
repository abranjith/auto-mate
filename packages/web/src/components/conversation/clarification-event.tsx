import { useEffect, useState } from 'react';
import type { Clarification } from '@automate/core';
import { getClarifications } from '../../api/clarification-mutations';
import { ds } from '../../design-system/tokens';
import { ClarificationCard } from './clarification-card';
export function ClarificationEvent({ executionId, clarificationId }: { executionId: number; clarificationId: number }) {
  const [batch, setBatch] = useState<Clarification>();
  useEffect(() => { void getClarifications(executionId).then((items) => setBatch(items.find(({ id }) => id === clarificationId))); }, [executionId, clarificationId]);
  return batch ? <ClarificationCard clarification={batch} onSettled={setBatch} /> : <p className={ds.eventLine}>Loading clarification…</p>;
}
