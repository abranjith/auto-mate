import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import { TaskComposer } from '../../../components/conversation/task-composer';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  navigate: vi.fn(),
  mutation: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
}));
vi.mock('../../../api/task-queries', () => ({
  useCreateTask: () => mocks.mutation,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}));
beforeEach(() => {
  mocks.mutation.mutate = vi.fn();
  mocks.mutation.isPending = false;
  mocks.mutation.isError = false;
  mocks.mutation.error = null;
  mocks.navigate.mockReset();
});
afterEach(cleanup);

describe('TaskComposer', () => {
  it('focuses an accessible text-only composer and validates whitespace', async () => {
    const user = userEvent.setup();
    const { container } = render(<TaskComposer />);
    const field = screen.getByRole('textbox', { name: /what would you like/i });
    expect(document.activeElement).toBe(field);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.type(field, '   ');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.type(field, 'do it');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
  it('submits a trimmed prompt once and supports Ctrl+Enter', async () => {
    const user = userEvent.setup();
    render(<TaskComposer />);
    const field = screen.getByRole('textbox');
    await user.type(field, '  hello  ');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(mocks.mutation.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutation.mutate).toHaveBeenCalledWith(
      { prompt: 'hello' },
      expect.any(Object),
    );
    await user.dblClick(screen.getByRole('button'));
    expect(mocks.mutation.mutate).toHaveBeenCalledTimes(1);
  });
  it('navigates on success and renders specific cap failures without clearing input', async () => {
    const user = userEvent.setup();
    mocks.mutation.isError = true;
    mocks.mutation.error = new AutoMateError(
      ERROR_CODES.EXECUTION_LIMIT_REACHED,
      'raw',
    );
    render(<TaskComposer />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(field, 'keep me');
    expect(screen.getByRole('alert').textContent).toContain(
      'Another task is already running',
    );
    await user.click(screen.getByRole('button'));
    const options = mocks.mutation.mutate.mock.calls[0]?.[1] as {
      onSuccess(value: { task: { id: number } }): void;
    };
    options.onSuccess({ task: { id: 42 } });
    expect(mocks.navigate).toHaveBeenCalled();
    expect(field.value).toBe('keep me');
  });
});
