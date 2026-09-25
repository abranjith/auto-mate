import { useState, type FormEvent } from 'react';
import type { Clarification } from '@automate/core';
import { answerClarification } from '../../api/clarification-mutations';
import { ds } from '../../design-system/tokens';

const sourceLabel = (source: Clarification['questions'][number]['answerSource']) => source === 'seeded' ? 'carried over from an earlier run' : source === 'default' ? 'application default' : 'your answer';
export function ClarificationCard({ clarification, onSettled, onAnswer = answerClarification }: { clarification: Clarification; onSettled?: (value: Clarification) => void; onAnswer?: typeof answerClarification }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (clarification.status === 'declined') return <p className={ds.eventLine}>Auto-Mate declined to interrupt ({clarification.declineReason === 'question_limit' ? 'the question limit was reached' : 'too many runs are waiting'}) and used: {clarification.questions.map(({ proposedDefault }) => proposedDefault).join(', ')}.</p>;
  if (clarification.status !== 'pending') return <section className={ds.clarificationCard}>{clarification.questions.map((question) => <div key={question.id}><p>{question.promptText}</p><p className={ds.hint}>Answer: {question.answer ?? question.proposedDefault} ({sourceLabel(question.answerSource)})</p></div>)}</section>;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!clarification.questions.every(({ id }) => answers[id])) return;
    setPending(true); setError(undefined);
    try {
      const settled = await onAnswer(clarification.id, { answers: clarification.questions.map(({ id }) => ({ questionId: id, value: answers[id]! })) });
      onSettled?.(settled);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The answers could not be saved.'); setPending(false); }
  };
  return <form className={ds.clarificationCard} onSubmit={(event) => void submit(event)}>{clarification.questions.map((question) => <fieldset className={ds.stackTight} key={question.id}><legend>{question.promptText}</legend><p className={ds.hint}>{question.rationale}</p>{question.options ? question.options.map((option) => <label className={ds.row} key={option.value}><input type="radio" name={`question-${question.id}`} value={option.value} checked={answers[question.id] === option.value} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.value }))} />{option.label}</label>) : <input className={ds.input} maxLength={2000} value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}<p className={ds.hint}>If ignored, the agent will use: {question.proposedDefault}</p></fieldset>)}{error ? <p className={ds.statusDanger} role="alert">{error}</p> : null}<button className={ds.btnPrimary} type="submit" disabled={pending || !clarification.questions.every(({ id }) => answers[id])}>{pending ? 'Sending…' : 'Send answers'}</button></form>;
}
