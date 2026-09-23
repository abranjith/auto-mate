import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import { useCreateTask } from '../../api/task-queries';
import { ds } from '../../design-system/tokens';

function errorMessage(error: unknown): string {
  if (
    error instanceof AutoMateError &&
    error.code === ERROR_CODES.EXECUTION_LIMIT_REACHED
  )
    return 'Another task is already running. Wait for it to finish, or cancel it.';
  if (error instanceof AutoMateError) return error.message;
  return 'The task could not be started. Try again.';
}

/** Plain-language task entry with keyboard submit and lossless failure behavior. */
export function TaskComposer() {
  const [prompt, setPrompt] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const mutation = useCreateTask();
  const navigate = useNavigate();
  useEffect(() => input.current?.focus(), []);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || mutation.isPending || submitting.current) return;
    submitting.current = true;
    mutation.mutate(
      { prompt: trimmed },
      {
        onSuccess: ({ task }) => {
          void navigate({
            to: '/tasks/$taskId',
            params: { taskId: String(task.id) },
          } as never);
        },
        onError: () => {
          submitting.current = false;
        },
      },
    );
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };
  return (
    <form className={ds.composer} onSubmit={submit}>
      <label className={ds.label} htmlFor="task-prompt">
        What would you like Auto-Mate to do?
      </label>
      <textarea
        id="task-prompt"
        ref={input}
        className={ds.textarea}
        rows={6}
        maxLength={8000}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={keyDown}
        placeholder="Describe the result you want in plain language…"
      />
      {prompt.length >= 7600 ? (
        <span className={ds.counter}>{prompt.length} / 8000</span>
      ) : null}
      {mutation.isError ? (
        <p className={ds.statusDanger} role="alert">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      <div className={ds.row}>
        <button
          className={ds.btnPrimary}
          type="submit"
          disabled={!prompt.trim() || mutation.isPending}
        >
          {mutation.isPending ? 'Starting…' : 'Start task'}
        </button>
        <span className={ds.hint}>Ctrl/Cmd + Enter</span>
      </div>
    </form>
  );
}
