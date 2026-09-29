import { useEffect, useState } from 'react';
import type { Clarification } from '@automate/core';
import { getClarifications } from '../../api/clarification-mutations';
import { ds } from '../../design-system/tokens';
import { ClarificationCard } from './clarification-card';
export function ClarificationEvent({ executionId, clarificationId }: { executionId: number; clarificationId: number }) {
  const [items, setItems] = useState<Clarification[]>([]);
  useEffect(() => { void getClarifications(executionId).then((received) => setItems([...received])); }, [executionId]);
  const batch = items.find(({ id }) => id === clarificationId);
  const questionById = new Map(items.flatMap(({ questions }) => (questions ?? []).map((question) => [question.id, question] as const)));
  return batch ? <ClarificationCard clarification={batch} questionById={questionById} onSettled={(settled) => setItems((current) => current.map((item) => item.id === settled.id ? settled : item))} /> : <p className={ds.eventLine}>Loading clarification…</p>;
}
