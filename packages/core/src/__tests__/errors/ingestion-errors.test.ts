import { describe, expect, it } from 'vitest';
import { AutoMateError } from '../../errors/automate-error';
import { ERROR_CODES } from '../../errors/error-codes';
import {
  EmptyFileError,
  NoTabularContentError,
  ParseFailedError,
  ParseTimeoutError,
  TooManyColumnsError,
  UnsupportedFileFormatError,
  UploadAlreadyAttachedError,
  UploadLimitReachedError,
  UploadNotFoundError,
  UploadTooLargeError,
  WorkbookTooLargeError,
  formatBytes,
  uploadTooLargeMessage,
} from '../../errors/ingestion-errors';

const MB = 1024 * 1024;

describe('ingestion errors', () => {
  const cases: [AutoMateError, string][] = [
    [new UploadNotFoundError(7), ERROR_CODES.UPLOAD_NOT_FOUND],
    [new UploadTooLargeError(78 * MB, 50 * MB), ERROR_CODES.UPLOAD_TOO_LARGE],
    [new UploadLimitReachedError(6, 5), ERROR_CODES.UPLOAD_LIMIT_REACHED],
    [new UnsupportedFileFormatError('xls'), ERROR_CODES.UNSUPPORTED_FILE_FORMAT],
    [new UploadAlreadyAttachedError(3), ERROR_CODES.UPLOAD_ALREADY_ATTACHED],
    [new EmptyFileError(), ERROR_CODES.FILE_EMPTY],
    [new ParseFailedError('A quoted value is never closed.', { line: 4812 }), ERROR_CODES.PARSE_FAILED],
    [new ParseTimeoutError(60_000), ERROR_CODES.PARSE_TIMEOUT],
    [new TooManyColumnsError(600, 512), ERROR_CODES.TOO_MANY_COLUMNS],
    [new WorkbookTooLargeError(1100 * MB, 1024 * MB), ERROR_CODES.WORKBOOK_TOO_LARGE],
    [new NoTabularContentError(), ERROR_CODES.NO_TABULAR_CONTENT],
  ];

  it('defines all eleven subclasses with their own stable codes', () => {
    expect(new Set(cases.map(([, code]) => code)).size).toBe(11);
  });

  it.each(cases)('%s is an AutoMateError whose JSON has only code and message', (error, code) => {
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.toJSON()).toEqual({ error: { code, message: error.message } });
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('details');
    expect(error.message).not.toMatch(/[A-Za-z]:\\|\/(?:tmp|home|Users)\//);
  });

  it('names both numbers in the size message', () => {
    expect(new UploadTooLargeError(78 * MB, 50 * MB).message).toBe('This file is 78 MB. The current limit is 50 MB.');
  });

  it('falls back to exact byte counts when both sizes would round to the same label', () => {
    const message = uploadTooLargeMessage(50 * MB + 1, 50 * MB);
    expect(message).toContain('52,428,801 bytes');
    expect(message).toContain('52,428,800 bytes');
  });

  it('says "larger than" when only a lower bound is known', () => {
    expect(new UploadTooLargeError(50 * MB + 1, 50 * MB, false).message).toBe(
      'This file is larger than 50 MB. The current limit is 50 MB.',
    );
  });

  it('names limit and actual value for every counted limit', () => {
    expect(new UploadLimitReachedError(6, 5).message).toMatch(/at most 5 files.*6/);
    expect(new TooManyColumnsError(600, 512).message).toMatch(/600 columns.*limit is 512/);
    expect(new TooManyColumnsError(600, 512, 'Q3').message).toContain('Sheet "Q3"');
    expect(new WorkbookTooLargeError(1100 * MB, 1024 * MB).message).toMatch(/more than 1\.1 GB.*limit is 1 GB/);
    expect(new WorkbookTooLargeError(300 * MB, 256 * MB, 'shared-strings').message).toContain('shared text table');
    expect(new ParseTimeoutError(60_000).message).toContain('60 seconds');
    expect(new ParseTimeoutError(1_000).message).toContain('1 second,');
    expect(new ParseTimeoutError(40).message).toContain('40 milliseconds,');
  });

  it('names the line or sheet of a parse failure', () => {
    expect(new ParseFailedError('x.', { line: 4812 }).message).toContain('(line 4,812)');
    expect(new ParseFailedError('x.', { sheet: 'Q3' }).message).toContain('(sheet "Q3")');
    expect(new ParseFailedError('x.', { sheet: 'Q3', line: 2 }).message).toContain('(sheet "Q3", line 2)');
    expect(new ParseFailedError('x.').message).toBe('This file could not be read. x.');
  });

  it('tells a person how to fix an .xls file and what an unsupported file is', () => {
    expect(new UnsupportedFileFormatError('xls').message).toMatch(/\.xls\b.*\.xlsx/);
    expect(new UnsupportedFileFormatError().message).toMatch(/\.csv, \.tsv, and \.xlsx/);
    expect(new NoTabularContentError('Notes').message).toContain('sheet "Notes"');
  });

  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [1023, '1023 bytes'],
    [1536, '1.5 KB'],
    [50 * MB, '50 MB'],
    [1024 * MB, '1 GB'],
  ])('formats %d bytes as %s', (bytes, label) => expect(formatBytes(bytes)).toBe(label));
});
