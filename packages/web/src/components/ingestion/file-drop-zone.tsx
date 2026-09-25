import { useId, useState, type DragEvent } from 'react';
import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  UNSUPPORTED_FORMAT_MESSAGE,
  UPLOAD_LIMIT_DEFAULTS,
  XLS_RESAVE_MESSAGE,
  extensionOf,
  formatBytes,
  uploadLimitMessage,
  uploadTooLargeMessage,
} from '@automate/core';
import { ds } from '../../design-system/tokens';

/** Limits the browser checks before sending anything. The server remains authoritative. */
export interface ClientUploadLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

const DEFAULT_LIMITS: ClientUploadLimits = {
  maxFiles: UPLOAD_LIMIT_DEFAULTS.maxFilesPerTask,
  maxBytes: UPLOAD_LIMIT_DEFAULTS.maxUploadBytes,
};

/**
 * Pre-check chosen files with the same message text the server would return,
 * so the two never disagree.
 *
 * @param files Files just chosen or dropped.
 * @param existingCount Files already attached.
 * @param limits Per-task file cap and per-file size cap.
 * @returns Files to upload, and one plain-English message per refused file.
 */
export function checkFiles(files: readonly File[], existingCount: number, limits: ClientUploadLimits = DEFAULT_LIMITS): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  const room = Math.max(0, limits.maxFiles - existingCount);
  for (const file of files) {
    const extension = extensionOf(file.name);
    if (extension === '.xls') rejected.push(`${file.name}: ${XLS_RESAVE_MESSAGE}`);
    else if (extension === null || !(ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) rejected.push(`${file.name}: ${UNSUPPORTED_FORMAT_MESSAGE}`);
    else if (file.size > limits.maxBytes) rejected.push(`${file.name}: ${uploadTooLargeMessage(file.size, limits.maxBytes)}`);
    else if (accepted.length >= room) rejected.push(`${file.name}: ${uploadLimitMessage(existingCount + accepted.length + 1, limits.maxFiles)}`);
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export interface FileDropZoneProps {
  readonly existingCount: number;
  readonly onAccept: (files: File[]) => void;
  readonly disabled?: boolean;
  readonly limits?: ClientUploadLimits;
}

/** A labelled file input plus a drop surface sharing one handler. Keyboard users reach it through the input itself. */
export function FileDropZone({ existingCount, onAccept, disabled = false, limits = DEFAULT_LIMITS }: FileDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const inputId = useId();
  const hintId = useId();
  const receive = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const result = checkFiles(files, existingCount, limits);
    setRejected(result.rejected);
    if (result.accepted.length > 0) onAccept(result.accepted);
  };
  const over = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!disabled) setDragging(true);
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) receive(event.dataTransfer.files);
  };
  return (
    <div className={dragging ? ds.dropZoneActive : ds.dropZone} onDragEnter={over} onDragOver={over} onDragLeave={() => setDragging(false)} onDrop={drop} data-testid="file-drop-zone">
      <label className={ds.label} htmlFor={inputId}>
        Attach CSV or Excel files (optional)
      </label>
      <input
        id={inputId}
        className={ds.fileInput}
        type="file"
        accept={ACCEPTED_UPLOAD_EXTENSIONS.join(',')}
        multiple
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => {
          receive(event.target.files);
          event.target.value = '';
        }}
      />
      <p id={hintId} className={ds.hint}>
        Drop files here or choose them: .csv, .tsv, or .xlsx, up to {limits.maxFiles} files of {formatBytes(limits.maxBytes)} each. Files are analyzed on this computer.
      </p>
      <p className={ds.srOnly} role="status" aria-live="polite">
        {dragging ? 'Release to attach the files.' : ''}
      </p>
      {rejected.length > 0 ? (
        <ul className={ds.noteList} role="alert">
          {rejected.map((message, index) => (
            <li key={`${index}-${message}`} className={ds.statusDanger}>
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
