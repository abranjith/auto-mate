import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  UNSUPPORTED_FORMAT_MESSAGE,
  UPLOAD_LIMIT_DEFAULTS,
  XLS_RESAVE_MESSAGE,
  uploadLimitMessage,
  uploadTooLargeMessage,
} from '@automate/core';
import { FileDropZone, checkFiles } from '../../../components/ingestion/file-drop-zone';
import { fileOf } from './upload-fixtures';

afterEach(cleanup);
const MAX = UPLOAD_LIMIT_DEFAULTS.maxUploadBytes;

describe('checkFiles', () => {
  it('accepts the three extensions and refuses others with the server\'s own wording', () => {
    const result = checkFiles([fileOf('a.csv'), fileOf('b.TSV'), fileOf('c.xlsx'), fileOf('d.xls'), fileOf('e.exe'), fileOf('noext')], 0);
    expect(result.accepted.map(({ name }) => name)).toEqual(['a.csv', 'b.TSV', 'c.xlsx']);
    expect(result.rejected).toEqual([`d.xls: ${XLS_RESAVE_MESSAGE}`, `e.exe: ${UNSUPPORTED_FORMAT_MESSAGE}`, `noext: ${UNSUPPORTED_FORMAT_MESSAGE}`]);
  });

  it('refuses an oversized file with exactly the server\'s size message', () => {
    const big = fileOf('big.csv', 78 * 1024 * 1024);
    expect(checkFiles([big], 0).rejected).toEqual([`big.csv: ${uploadTooLargeMessage(78 * 1024 * 1024, MAX)}`]);
    expect(checkFiles([fileOf('edge.csv', MAX)], 0).accepted).toHaveLength(1);
  });

  it('refuses files past the per-task cap with the server\'s cap message', () => {
    const result = checkFiles([fileOf('5.csv'), fileOf('6.csv')], 4);
    expect(result.accepted.map(({ name }) => name)).toEqual(['5.csv']);
    expect(result.rejected).toEqual([`6.csv: ${uploadLimitMessage(6, 5)}`]);
  });
});

describe('FileDropZone', () => {
  it('renders a labelled file input accepting only the three extensions', () => {
    render(<FileDropZone existingCount={0} onAccept={vi.fn()} />);
    const input = screen.getByLabelText(/attach csv or excel files/i) as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.csv,.tsv,.xlsx');
    expect(input.multiple).toBe(true);
  });

  it('passes chosen and dropped files through one handler', async () => {
    const onAccept = vi.fn();
    render(<FileDropZone existingCount={0} onAccept={onAccept} />);
    await userEvent.upload(screen.getByLabelText(/attach csv/i), fileOf('a.csv'));
    fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files: [fileOf('b.csv'), fileOf('c.xlsx')] } });
    expect(onAccept.mock.calls.map(([files]) => (files as File[]).map(({ name }) => name))).toEqual([['a.csv'], ['b.csv', 'c.xlsx']]);
  });

  it('announces drag state in a live region, not by colour alone', () => {
    render(<FileDropZone existingCount={0} onAccept={vi.fn()} />);
    fireEvent.dragEnter(screen.getByTestId('file-drop-zone'));
    expect(screen.getByRole('status').textContent).toBe('Release to attach the files.');
    fireEvent.dragLeave(screen.getByTestId('file-drop-zone'));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('shows refusals as an alert and sends nothing for them', () => {
    const onAccept = vi.fn();
    render(<FileDropZone existingCount={5} onAccept={onAccept} />);
    fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files: [fileOf('sixth.csv')] } });
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(uploadLimitMessage(6, 5));
  });

  it('is reachable by keyboard', async () => {
    const user = userEvent.setup();
    render(<FileDropZone existingCount={0} onAccept={vi.fn()} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/attach csv/i));
  });

  it('ignores drops while disabled', () => {
    const onAccept = vi.fn();
    render(<FileDropZone existingCount={0} onAccept={onAccept} disabled />);
    fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files: [fileOf('a.csv')] } });
    expect(onAccept).not.toHaveBeenCalled();
  });
});
