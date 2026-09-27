import { describe, expect, it } from 'vitest';
import { AutoMateError } from '../../errors/automate-error';
import { ERROR_CODES } from '../../errors/error-codes';
import { ArchiveTooLargeError, ArtifactFileMissingError, ArtifactNotFoundError, ArtifactNotPreviewableError, ArtifactNotTabularError, ArtifactRegistrationError, ArtifactTooLargeToPreviewError, NoArtifactsError } from '../../errors/artifact-errors';

describe('artifact errors', () => {
  it.each([
    [new ArtifactNotFoundError(7), ERROR_CODES.ARTIFACT_NOT_FOUND],
    [new ArtifactFileMissingError(7), ERROR_CODES.ARTIFACT_FILE_MISSING],
    [new ArtifactNotPreviewableError(7), ERROR_CODES.ARTIFACT_NOT_PREVIEWABLE],
    [new ArtifactTooLargeToPreviewError(5_242_880), ERROR_CODES.ARTIFACT_TOO_LARGE_TO_PREVIEW],
    [new ArtifactNotTabularError(7), ERROR_CODES.ARTIFACT_NOT_TABULAR],
    [new ArtifactRegistrationError('the database was busy'), ERROR_CODES.ARTIFACT_REGISTRATION_FAILED],
    [new ArchiveTooLargeError(4_294_967_295), ERROR_CODES.ARCHIVE_TOO_LARGE],
    [new NoArtifactsError(3), ERROR_CODES.ARTIFACT_NOT_FOUND],
  ])('%s keeps its code and a safe envelope', (error, code) => {
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error.code).toBe(code);
    const json = error.toJSON();
    expect(json).toEqual({ error: { code, message: error.message } });
    expect(JSON.stringify(json)).not.toMatch(/stack|[A-Za-z]:\\|\/home\/|\/Users\//);
    expect(error.message).toMatch(/^[A-Z].*\.$/);
  });

  it('names the concrete limit and points at the download', () => {
    expect(new ArtifactTooLargeToPreviewError(5_242_880).message).toBe('This output is larger than the 5 MB the app will preview. Download it to open it.');
    expect(new ArchiveTooLargeError(4_294_967_295).message).toContain('4 GB');
    expect(new ArchiveTooLargeError(4_294_967_295).message).toContain('one at a time');
  });

  it('registers every new code in ERROR_CODES', () => {
    for (const code of ['ARTIFACT_NOT_FOUND', 'ARTIFACT_FILE_MISSING', 'ARTIFACT_NOT_PREVIEWABLE', 'ARTIFACT_TOO_LARGE_TO_PREVIEW', 'ARTIFACT_NOT_TABULAR', 'ARTIFACT_REGISTRATION_FAILED', 'ARCHIVE_TOO_LARGE'] as const) expect(ERROR_CODES[code]).toBe(code);
  });
});
