import { Value } from '@sinclair/typebox/value';
import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  ApiErrorSchema,
  AutoMateError,
  DeleteUploadResponseSchema,
  ERROR_CODES,
  UploadListResponseSchema,
  UploadResponseSchema,
  type DeleteUploadResponse,
  type UploadListResponse,
  type UploadResponse,
} from '@automate/core';
import { getJson, sendJson } from './api-client';

/** Where one file's upload is: bytes still moving (determinate), or the server analyzing them (indeterminate). */
export type UploadProgress =
  | { readonly phase: 'transferring'; readonly loaded: number; readonly total: number }
  | { readonly phase: 'analyzing' };

/** The subset of XMLHttpRequest this module uses, so tests can supply a double. */
export interface UploadTransport {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null; onload: (() => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Turn a finished upload request into a validated response or a typed error carrying the server's plain-English message. */
function settle(transport: UploadTransport, correlationId: string): UploadResponse {
  const body = parseBody(transport.responseText);
  if (transport.status === 201 && Value.Check(UploadResponseSchema, body)) return body;
  if (Value.Check(ApiErrorSchema, body)) {
    throw new AutoMateError(body.error.code, body.error.message, undefined, body.error.correlationId ?? correlationId);
  }
  throw new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'The server returned an unexpected response to the upload.', undefined, correlationId);
}

/**
 * Upload one file with transfer progress.
 *
 * `fetch` cannot report upload progress, so this uses XMLHttpRequest. Progress
 * is determinate while bytes move, then switches to `analyzing` while the
 * server profiles the file.
 *
 * @param file The file the person chose.
 * @param onProgress Receives each progress change.
 * @param createTransport Test seam; defaults to a real XMLHttpRequest.
 * @returns The stored upload with its profile and disclosure payload.
 * @throws AutoMateError with the server's code and message, or CONNECTION_ERROR.
 */
export function uploadFile(
  file: File,
  onProgress: (progress: UploadProgress) => void,
  createTransport: () => UploadTransport = () => new XMLHttpRequest() as unknown as UploadTransport,
): Promise<UploadResponse> {
  const correlationId = crypto.randomUUID();
  const transport = createTransport();
  return new Promise((resolve, reject) => {
    transport.upload.onprogress = (event) =>
      onProgress({ phase: 'transferring', loaded: event.loaded, total: event.lengthComputable ? event.total : file.size });
    transport.upload.onload = () => onProgress({ phase: 'analyzing' });
    transport.onload = () => {
      try {
        resolve(settle(transport, correlationId));
      } catch (error) {
        reject(error);
      }
    };
    transport.onerror = () =>
      reject(new AutoMateError(ERROR_CODES.CONNECTION_ERROR, 'Cannot reach the local server. Start it with pnpm dev.', undefined, correlationId));
    transport.onabort = () => reject(new AutoMateError(ERROR_CODES.CONNECTION_ERROR, 'The upload was cancelled.', undefined, correlationId));
    const form = new FormData();
    form.append('file', file, file.name);
    transport.open('POST', '/api/uploads');
    transport.setRequestHeader('x-correlation-id', correlationId);
    transport.send(form);
  });
}

/** Upload one file; progress arrives through the variables' callback. */
export function useUploadFile(): UseMutationResult<
  UploadResponse,
  AutoMateError,
  { file: File; onProgress: (progress: UploadProgress) => void }
> {
  return useMutation({ mutationFn: ({ file, onProgress }) => uploadFile(file, onProgress) });
}

/** Delete a staged upload. An attached upload is removed only with its task. */
export function useDeleteUpload(): UseMutationResult<DeleteUploadResponse, AutoMateError, number> {
  return useMutation({
    mutationFn: (id) =>
      sendJson(`/uploads/${id}`, 'DELETE', undefined, (value): value is DeleteUploadResponse => Value.Check(DeleteUploadResponseSchema, value)),
  });
}

/** Read one upload with its profiles. */
export function getUpload(id: number): Promise<UploadResponse> {
  return getJson(`/uploads/${id}`, (value): value is UploadResponse => Value.Check(UploadResponseSchema, value));
}

/** One upload with its profiles. */
export function useUpload(id: number | null): UseQueryResult<UploadResponse, AutoMateError> {
  return useQuery({ queryKey: ['upload', id], queryFn: () => getUpload(id!), enabled: id !== null });
}

/** A task's attached uploads. */
export function useTaskUploads(taskId: number): UseQueryResult<UploadListResponse, AutoMateError> {
  return useQuery({
    queryKey: ['task-uploads', taskId],
    queryFn: () => getJson(`/tasks/${taskId}/uploads`, (value): value is UploadListResponse => Value.Check(UploadListResponseSchema, value)),
  });
}
