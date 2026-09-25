import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../errors/error-codes';
import { EmptyFileError, UnsupportedFileFormatError } from '../../errors/ingestion-errors';
import { detectFileFormat, extensionOf, zipEntryNames } from '../../ingestion/file-format';

const text = (value: string) => new TextEncoder().encode(value);

/** A minimal ZIP local file header followed by a name; the data is never read by detection. */
function zipEntry(name: string, data = 'x'): number[] {
  const nameBytes = [...text(name)];
  const header = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return [...header, nameBytes.length & 0xff, nameBytes.length >> 8, 0, 0, ...nameBytes, ...text(data)];
}
const zip = (...names: string[]) => new Uint8Array(names.flatMap((name) => zipEntry(name)));
const xlsxHeader = zip('[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml');
const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('detectFileFormat', () => {
  it('identifies an OOXML workbook header', () => {
    expect(detectFileFormat(xlsxHeader)).toBe('xlsx');
  });

  it('identifies a workbook by its xl/ parts even when content types come later', () => {
    expect(detectFileFormat(zip('docProps/app.xml', 'xl/theme/theme1.xml'))).toBe('xlsx');
  });

  it('classifies a workbook named .csv as xlsx: content decides, not the extension', () => {
    expect(detectFileFormat(xlsxHeader, { filename: 'report.csv', mimeType: 'text/csv' })).toBe('xlsx');
  });

  it('treats plain text as csv even when named .xlsx', () => {
    expect(detectFileFormat(text('id,name\n1,Ada\n'))).toBe('csv');
    expect(detectFileFormat(text('id,name\n1,Ada\n'), { filename: 'x.xlsx' })).toBe('csv');
  });

  it('raises the re-save guidance for a legacy OLE2 .xls header', () => {
    expect(() => detectFileFormat(ole2, { filename: 'old.xls' })).toThrow(UnsupportedFileFormatError);
    try {
      detectFileFormat(ole2);
    } catch (error) {
      expect((error as UnsupportedFileFormatError).kind).toBe('xls');
      expect((error as Error).message).toMatch(/save it as.*\.xlsx/i);
    }
  });

  it('does not give .xls guidance for an OLE2 Word document', () => {
    try {
      detectFileFormat(ole2, { filename: 'letter.doc' });
      expect.unreachable();
    } catch (error) {
      expect((error as UnsupportedFileFormatError).kind).toBe('other');
    }
  });

  it('refuses a Word document and a plain ZIP archive', () => {
    expect(codeOf(() => detectFileFormat(zip('[Content_Types].xml', 'word/document.xml')))).toBe(ERROR_CODES.UNSUPPORTED_FILE_FORMAT);
    expect(codeOf(() => detectFileFormat(zip('photos/a.jpg')))).toBe(ERROR_CODES.UNSUPPORTED_FILE_FORMAT);
  });

  it('uses the .xlsx extension only as a tie-break for an unrecognisable ZIP', () => {
    expect(detectFileFormat(zip('docProps/app.xml'), { filename: 'Book1.XLSX' })).toBe('xlsx');
    expect(codeOf(() => detectFileFormat(zip('docProps/app.xml'), { filename: 'Book1.zip' }))).toBe(ERROR_CODES.UNSUPPORTED_FILE_FORMAT);
  });

  it('refuses an executable, a PNG, and a PDF', () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
    expect(codeOf(() => detectFileFormat(exe, { filename: 'setup.exe' }))).toBe(ERROR_CODES.UNSUPPORTED_FILE_FORMAT);
    expect(codeOf(() => detectFileFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))).toBe(ERROR_CODES.UNSUPPORTED_FILE_FORMAT);
    expect(codeOf(() => detectFileFormat(text('%PDF-1.7\n%âãÏÓ\n')))).toBe(ERROR_CODES.UNSUPPORTED_FILE_FORMAT);
  });

  it('accepts text beginning with letters that resemble a signature', () => {
    expect(detectFileFormat(text('MZ code,amount\nA1,3\n'))).toBe('csv');
  });

  it('refuses text dense with control characters', () => {
    const noisy = new Uint8Array(200).map((_, index) => (index % 10 === 0 ? 0x01 : 0x41));
    expect(codeOf(() => detectFileFormat(noisy))).toBe(ERROR_CODES.UNSUPPORTED_FILE_FORMAT);
  });

  it('accepts UTF-16 text by its byte-order mark despite its NUL bytes', () => {
    expect(detectFileFormat(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00]))).toBe('csv');
  });

  it('raises EmptyFileError for an empty buffer or a lone byte-order mark', () => {
    expect(() => detectFileFormat(new Uint8Array())).toThrow(EmptyFileError);
    expect(() => detectFileFormat(new Uint8Array([0xef, 0xbb, 0xbf]))).toThrow(EmptyFileError);
  });

  it('reads ZIP entry names without interpreting data', () => {
    expect(zipEntryNames(xlsxHeader)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']);
    expect(zipEntryNames(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toEqual([]);
  });

  it.each([
    ['data.CSV', '.csv'],
    ['a.b.xlsx', '.xlsx'],
    ['noext', null],
    [null, null],
    ['trailing.', null],
  ])('extensionOf(%s) is %s', (name, expected) => expect(extensionOf(name)).toBe(expected));
});
