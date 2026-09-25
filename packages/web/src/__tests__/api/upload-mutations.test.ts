import { describe, expect, it, vi } from 'vitest';
import { AutoMateError } from '@automate/core';
import { uploadFile, type UploadProgress, type UploadTransport } from '../../api/upload-mutations';
import { uploadResponse } from '../components/ingestion/upload-fixtures';

/** A scriptable stand-in for XMLHttpRequest. */
class FakeTransport implements UploadTransport {
  status = 0;
  responseText = '';
  opened: [string, string] | null = null;
  headers: Record<string, string> = {};
  sent: FormData | null = null;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null, onload: null as (() => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.opened = [method, url];
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.sent = body;
  }
  abort() {
    this.onabort?.();
  }
  finish(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const file = new File(['id\n1\n'], 'sales.csv', { type: 'text/csv' });

describe('uploadFile', () => {
  it('posts the file as multipart, reports determinate then analyzing progress, and resolves the validated body', async () => {
    const transport = new FakeTransport();
    const progress: UploadProgress[] = [];
    const pending = uploadFile(file, (value) => progress.push(value), () => transport);
    expect(transport.opened).toEqual(['POST', '/api/uploads']);
    expect(transport.headers['x-correlation-id']).toMatch(/[0-9a-f-]{36}/);
    expect((transport.sent?.get('file') as File).name).toBe('sales.csv');
    transport.upload.onprogress?.({ loaded: 3, total: 6, lengthComputable: true } as ProgressEvent);
    transport.upload.onload?.();
    transport.finish(201, uploadResponse());
    await expect(pending).resolves.toEqual(uploadResponse());
    expect(progress).toEqual([{ phase: 'transferring', loaded: 3, total: 6 }, { phase: 'analyzing' }]);
  });

  it('rejects with the server\'s code and plain-English message', async () => {
    const transport = new FakeTransport();
    const pending = uploadFile(file, vi.fn(), () => transport);
    transport.finish(413, { error: { code: 'UPLOAD_TOO_LARGE', message: 'This file is 78 MB. The current limit is 50 MB.', correlationId: 'cid' } });
    await expect(pending).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', message: 'This file is 78 MB. The current limit is 50 MB.', correlationId: 'cid' });
  });

  it('rejects a success status whose body is not a valid upload', async () => {
    const transport = new FakeTransport();
    const pending = uploadFile(file, vi.fn(), () => transport);
    transport.finish(201, { nope: true });
    await expect(pending).rejects.toBeInstanceOf(AutoMateError);
  });

  it('reports a connection failure and a cancellation', async () => {
    const failing = new FakeTransport();
    const offline = uploadFile(file, vi.fn(), () => failing);
    failing.onerror?.();
    await expect(offline).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    const cancelled = new FakeTransport();
    const aborted = uploadFile(file, vi.fn(), () => cancelled);
    cancelled.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
  });
});
