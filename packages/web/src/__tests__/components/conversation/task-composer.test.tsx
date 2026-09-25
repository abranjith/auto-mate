import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AutoMateError,
  ERROR_CODES,
  UPLOAD_LIMIT_DEFAULTS,
  uploadLimitMessage,
  uploadTooLargeMessage,
  type UploadResponse,
} from '@automate/core';
import type { UploadProgress } from '../../../api/upload-mutations';
import { TaskComposer } from '../../../components/conversation/task-composer';
import { fileOf, uploadResponse } from '../ingestion/upload-fixtures';

interface PendingUpload {
  file: File;
  onProgress: (progress: UploadProgress) => void;
  resolve: (value: UploadResponse) => void;
  reject: (error: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  mutation: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  uploads: [] as PendingUpload[],
  uploadAsync: vi.fn(),
  deleteUpload: vi.fn(),
  getPreview: vi.fn(),
  grantConsent: vi.fn(),
}));
vi.mock('../../../api/task-queries', () => ({
  useCreateTask: () => mocks.mutation,
}));
vi.mock('../../../api/upload-mutations', () => ({
  useUploadFile: () => ({ mutateAsync: mocks.uploadAsync }),
  useDeleteUpload: () => ({ mutate: mocks.deleteUpload }),
}));
vi.mock('../../../api/disclosure-queries', () => ({
  getDisclosurePreview: mocks.getPreview,
  grantDisclosureConsent: mocks.grantConsent,
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
  mocks.uploads = [];
  mocks.deleteUpload.mockReset();
  mocks.uploadAsync.mockReset();
  mocks.getPreview.mockReset();
  mocks.grantConsent.mockReset();
  mocks.getPreview.mockImplementation((uploadIds: number[]) => Promise.resolve({ uploadIds, text: 'approved text', digest: 'a'.repeat(64), byteSize: 13, provider: 'test', model: 'fake', truncations: [], required: [], defaults: [], notices: [] }));
  mocks.grantConsent.mockResolvedValue({ id: 7, payloadDigest: 'a'.repeat(64), provider: 'test', model: 'fake', byteSize: 13, scopeContext: true, scopeDiagnostics: true, grantedAt: new Date().toISOString() });
  mocks.uploadAsync.mockImplementation(
    ({ file, onProgress }: { file: File; onProgress: PendingUpload['onProgress'] }) =>
      new Promise<UploadResponse>((resolve, reject) => mocks.uploads.push({ file, onProgress, resolve, reject })),
  );
});
afterEach(cleanup);

const dropZone = () => screen.getByTestId('file-drop-zone');
const drop = (...files: File[]) => fireEvent.drop(dropZone(), { dataTransfer: { files } });
const startButton = () => screen.getByRole('button', { name: /start task|starting/i }) as HTMLButtonElement;
async function settle(index: number, id: number) {
  await act(async () => mocks.uploads[index]!.resolve(uploadResponse(undefined, { id, originalFilename: mocks.uploads[index]!.file.name })));
}

describe('TaskComposer', () => {
  it('focuses an accessible composer and validates whitespace', async () => {
    const user = userEvent.setup();
    render(<TaskComposer />);
    const field = screen.getByRole('textbox', { name: /what would you like/i });
    expect(document.activeElement).toBe(field);
    expect(startButton().disabled).toBe(true);
    await user.type(field, '   ');
    expect(startButton().disabled).toBe(true);
    await user.type(field, 'do it');
    expect(startButton().disabled).toBe(false);
  });

  it('renders a correctly labelled file input for the three accepted extensions (replaces the FEAT-103 no-attachment tripwire)', () => {
    const { container } = render(<TaskComposer />);
    const input = screen.getByLabelText(/attach csv or excel files/i) as HTMLInputElement;
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(input.accept).toBe('.csv,.tsv,.xlsx');
  });

  it('submits a trimmed text-only prompt once and supports Ctrl+Enter', async () => {
    const user = userEvent.setup();
    render(<TaskComposer />);
    await user.type(screen.getByRole('textbox'), '  hello  ');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(mocks.mutation.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutation.mutate).toHaveBeenCalledWith({ prompt: 'hello' }, expect.any(Object));
    await user.dblClick(startButton());
    expect(mocks.mutation.mutate).toHaveBeenCalledTimes(1);
  });

  it('navigates on success and renders specific cap failures without clearing input', async () => {
    const user = userEvent.setup();
    mocks.mutation.isError = true;
    mocks.mutation.error = new AutoMateError(ERROR_CODES.EXECUTION_LIMIT_REACHED, 'raw');
    render(<TaskComposer />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(field, 'keep me');
    expect(screen.getByRole('alert').textContent).toContain('Another task is already running');
    await user.click(startButton());
    const options = mocks.mutation.mutate.mock.calls[0]?.[1] as { onSuccess(value: { task: { id: number } }): void };
    act(() => options.onSuccess({ task: { id: 42 } }));
    expect(mocks.navigate).toHaveBeenCalled();
    expect(field.value).toBe('keep me');
  });

  it('uploads a dropped file once, and three dropped files three times', () => {
    render(<TaskComposer />);
    drop(fileOf('a.csv'));
    expect(mocks.uploadAsync).toHaveBeenCalledTimes(1);
    expect(mocks.uploads[0]!.file.name).toBe('a.csv');
    drop(fileOf('b.csv'), fileOf('c.csv'), fileOf('d.xlsx'));
    expect(mocks.uploadAsync).toHaveBeenCalledTimes(4);
  });

  it('refuses a sixth file client-side with the cap message and sends no request', () => {
    render(<TaskComposer />);
    drop(...['1', '2', '3', '4', '5'].map((name) => fileOf(`${name}.csv`)));
    drop(fileOf('6.csv'));
    expect(mocks.uploadAsync).toHaveBeenCalledTimes(5);
    expect(screen.getByRole('alert').textContent).toContain(uploadLimitMessage(6, UPLOAD_LIMIT_DEFAULTS.maxFilesPerTask));
  });

  it('refuses an oversized file with the same message the server uses', () => {
    render(<TaskComposer />);
    const size = UPLOAD_LIMIT_DEFAULTS.maxUploadBytes + 1;
    drop(fileOf('big.csv', size));
    expect(mocks.uploadAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(uploadTooLargeMessage(size, UPLOAD_LIMIT_DEFAULTS.maxUploadBytes));
  });

  it('shows determinate transfer progress, then the indeterminate analyzing state', () => {
    render(<TaskComposer />);
    drop(fileOf('a.csv', 100));
    act(() => mocks.uploads[0]!.onProgress({ phase: 'transferring', loaded: 40, total: 100 }));
    const bar = screen.getByLabelText('Upload progress') as HTMLProgressElement;
    expect(bar.getAttribute('value')).toBe('40');
    expect(screen.getByText('Uploading… 40%')).toBeTruthy();
    act(() => mocks.uploads[0]!.onProgress({ phase: 'analyzing' }));
    expect((screen.getByLabelText('Analyzing the file') as HTMLProgressElement).hasAttribute('value')).toBe(false);
    expect(screen.getByText('Analyzing on this computer…')).toBeTruthy();
  });

  it('blocks submit while an upload is in flight, then submits the ready upload ids', async () => {
    const user = userEvent.setup();
    render(<TaskComposer />);
    await user.type(screen.getByRole('textbox'), 'Summarize');
    drop(fileOf('a.csv'), fileOf('b.csv'));
    expect(startButton().disabled).toBe(true);
    await settle(0, 11);
    expect(startButton().disabled).toBe(true);
    await settle(1, 12);
    expect(startButton().disabled).toBe(false);
    await user.click(startButton());
    await user.click(await screen.findByRole('button', { name: /approve and start/i }));
    await waitFor(() => expect(mocks.mutation.mutate).toHaveBeenCalledWith({ prompt: 'Summarize', uploadIds: [11, 12], disclosureAck: { consentId: 7, payloadDigest: 'a'.repeat(64) }, preflightDecisions: [] }, expect.any(Object)));
  });

  it('removes a file: the delete mutation runs and its id is no longer submitted', async () => {
    const user = userEvent.setup();
    render(<TaskComposer />);
    await user.type(screen.getByRole('textbox'), 'Go');
    drop(fileOf('a.csv'), fileOf('b.csv'));
    await settle(0, 21);
    await settle(1, 22);
    await user.click(screen.getByRole('button', { name: 'Remove a.csv' }));
    expect(mocks.deleteUpload).toHaveBeenCalledWith(21);
    await user.click(startButton());
    await user.click(await screen.findByRole('button', { name: /approve and start/i }));
    await waitFor(() => expect(mocks.mutation.mutate).toHaveBeenCalledWith({ prompt: 'Go', uploadIds: [22], disclosureAck: { consentId: 7, payloadDigest: 'a'.repeat(64) }, preflightDecisions: [] }, expect.any(Object)));
  });

  it('renders a failed upload\'s plain-English message, keeps the others, and retries', async () => {
    const user = userEvent.setup();
    render(<TaskComposer />);
    drop(fileOf('good.csv'), fileOf('bad.csv'));
    await settle(0, 31);
    await act(async () => mocks.uploads[1]!.reject(new AutoMateError('PARSE_FAILED', 'This file could not be read (line 4). A quoted value starts on this line and is never closed.')));
    expect(screen.getByText(/line 4\)\. A quoted value/)).toBeTruthy();
    expect(screen.getByText('good.csv')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.uploadAsync).toHaveBeenCalledTimes(3);
    expect(mocks.uploads[2]!.file.name).toBe('bad.csv');
    await waitFor(() => expect(screen.queryByText(/line 4\)/)).toBeNull());
  });
});
