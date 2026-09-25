import { useCallback, useRef, useState } from 'react';
import { AutoMateError, type UploadResponse } from '@automate/core';
import { useDeleteUpload, useUploadFile, type UploadProgress } from '../../api/upload-mutations';

export type AttachmentStatus = 'uploading' | 'analyzing' | 'ready' | 'failed';

/** One file the person attached, and where its upload stands. */
export interface Attachment {
  readonly key: string;
  readonly file: File;
  readonly status: AttachmentStatus;
  readonly loaded: number;
  readonly total: number;
  readonly result: UploadResponse | null;
  readonly error: string | null;
}

function failureText(error: unknown): string {
  return error instanceof AutoMateError ? error.message : 'The file could not be uploaded. Try again.';
}

/**
 * Attached files for the task composer: uploads each one, tracks its
 * progress, and exposes the ids of those ready to attach to a task.
 */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const upload = useUploadFile();
  const remover = useDeleteUpload();
  const counter = useRef(0);

  const patch = useCallback((key: string, change: Partial<Attachment>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const start = useCallback(
    (key: string, file: File) => {
      const onProgress = (progress: UploadProgress) =>
        patch(key, progress.phase === 'analyzing' ? { status: 'analyzing' } : { status: 'uploading', loaded: progress.loaded, total: progress.total });
      upload.mutateAsync({ file, onProgress }).then(
        (result) => patch(key, { status: 'ready', result, error: null }),
        (error: unknown) => patch(key, { status: 'failed', error: failureText(error) }),
      );
    },
    [patch, upload],
  );

  /** Attach and start uploading files that already passed the client-side checks. */
  const add = useCallback(
    (files: readonly File[]) => {
      const added = files.map((file): Attachment => {
        counter.current += 1;
        return { key: `attachment-${counter.current}`, file, status: 'uploading', loaded: 0, total: file.size, result: null, error: null };
      });
      setItems((current) => [...current, ...added]);
      added.forEach((item) => start(item.key, item.file));
    },
    [start],
  );

  /** Upload a failed file again. */
  const retry = useCallback(
    (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (!item) return;
      patch(key, { status: 'uploading', loaded: 0, error: null });
      start(key, item.file);
    },
    [items, patch, start],
  );

  /** Drop a file; a stored upload is deleted on the server too. */
  const remove = useCallback(
    (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (item?.result) remover.mutate(item.result.upload.id);
      setItems((current) => current.filter((candidate) => candidate.key !== key));
    },
    [items, remover],
  );

  /** Forget every attachment after a task claimed them. */
  const clear = useCallback(() => setItems([]), []);

  const uploadIds = items.flatMap((item) => (item.status === 'ready' && item.result ? [item.result.upload.id] : []));
  const busy = items.some((item) => item.status === 'uploading' || item.status === 'analyzing');
  return { items, add, retry, remove, clear, uploadIds, busy };
}
