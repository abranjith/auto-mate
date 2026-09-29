import { useRef, useState, type FormEvent } from 'react';
import { answerText, MAX_ANSWER_CHARS, type Clarification, type ClarificationQuestion } from '@automate/core';
import { answerClarification } from '../../api/clarification-mutations';
import { ds } from '../../design-system/tokens';

const sourceLabel = (kind: ClarificationQuestion['answerKind']) => kind === 'seeded' ? 'carried over from an earlier run' : kind === 'default' ? 'application default' : kind === 'own_words' ? 'in your words' : 'your choice';

/** One persisted batch of questions, including typed answers and earlier follow-ups. */
export function ClarificationCard({ clarification, questionById, onSettled, onAnswer = answerClarification }: { clarification: Clarification; questionById?: ReadonlyMap<number, ClarificationQuestion>; onSettled?: (value: Clarification) => void; onAnswer?: typeof answerClarification }) {
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [other, setOther] = useState<Record<number, boolean>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const valueFor = (question: ClarificationQuestion) => question.options && !other[question.id] ? picked[question.id] ?? '' : (typed[question.id] ?? '').trim();
  const ready = clarification.questions.every((question) => valueFor(question).length > 0);
  const leadIn = (question: ClarificationQuestion) => {
    const parent = question.followUpOfQuestionId ? questionById?.get(question.followUpOfQuestionId) : undefined;
    return parent ? <p className={ds.hint}>Following up on “{parent.promptText}” — you said “{answerText(parent)}”.</p> : null;
  };
  const defaultLabel = (question: ClarificationQuestion) => question.options?.find(({ value }) => value === question.proposedDefault)?.label ?? question.proposedDefault;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !ready) return;
    inFlight.current = true; setPending(true); setError(undefined);
    try {
      const settled = await onAnswer(clarification.id, { answers: clarification.questions.map((question) => ({ questionId: question.id, value: valueFor(question) })) });
      onSettled?.(settled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The answers could not be saved.');
      setPending(false); inFlight.current = false;
    }
  };
  if (clarification.status === 'declined') return <p className={ds.eventLine}>Auto-Mate declined to interrupt ({clarification.declineReason === 'question_limit' ? 'the question limit was reached' : 'too many runs are waiting'}) and used: {clarification.questions.map(defaultLabel).join(', ')}.</p>;
  if (clarification.status !== 'pending') return <section className={ds.clarificationCard}>{clarification.questions.map((question) => <div key={question.id}>{leadIn(question)}<p>{question.promptText}</p><p className={ds.hint}>Answer: {question.answerKind === 'own_words' ? `“${answerText(question)}”` : answerText(question) ?? defaultLabel(question)} ({sourceLabel(question.answerKind)})</p></div>)}</section>;
  return <form className={ds.clarificationCard} onSubmit={(event) => void submit(event)}>{clarification.questions.map((question) => <fieldset className={ds.stackTight} key={question.id}>{leadIn(question)}<legend>{question.promptText}</legend><p className={ds.hint}>{question.rationale}</p>{question.options ? <>{question.options.map((option) => <label className={ds.row} key={option.value}><input type="radio" name={`question-${question.id}`} value={option.value} checked={!other[question.id] && picked[question.id] === option.value} onChange={() => { setOther((current) => ({ ...current, [question.id]: false })); setPicked((current) => ({ ...current, [question.id]: option.value })); }} />{option.label}</label>)}<label className={ds.row}><input type="radio" name={`question-${question.id}`} checked={Boolean(other[question.id])} onChange={() => setOther((current) => ({ ...current, [question.id]: true }))} />Something else…</label></> : null}{(!question.options || other[question.id]) ? <textarea className={ds.input} aria-label="Your answer" maxLength={MAX_ANSWER_CHARS} value={typed[question.id] ?? ''} onChange={(event) => setTyped((current) => ({ ...current, [question.id]: event.target.value }))} /> : null}<p className={ds.hint}>If ignored, the agent will use: {defaultLabel(question)}</p></fieldset>)}{error ? <p className={ds.statusDanger} role="alert">{error}</p> : null}<button className={ds.btnPrimary} type="submit" disabled={pending || !ready}>{pending ? 'Sending…' : 'Send answers'}</button></form>;
}
