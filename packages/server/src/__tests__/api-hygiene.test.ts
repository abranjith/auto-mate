// FEAT-110 D10: reads are protected from other web pages only by the same-origin
// policy, which holds only while no /api response carries a CORS allow header.
// This sweeps every route the app registers — taken from Express's own router
// stack, so a route added later is covered without editing this file.
import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { startFullApp, type FullApp } from './support/history-app';

const apps: FullApp[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

type Route = { method: string; path: string };
/** Every method and path registered on the app, including routes inside mounted routers. */
function registeredRoutes(app: Express): Route[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
  const visit = (stack: Layer[]): Route[] => stack.flatMap((layer) => layer.route
    ? Object.keys(layer.route.methods).filter((method) => method !== '_all').map((method) => ({ method: method.toUpperCase(), path: layer.route!.path }))
    : visit(layer.handle?.stack ?? []));
  return visit((app as unknown as { router: { stack: Layer[] } }).router.stack);
}

function expectHygienic(response: Response, label: string): void {
  for (const [name] of response.headers) expect(name, `${label} sent ${name}`).not.toMatch(/^access-control-allow-/i);
  expect(response.headers.get('x-content-type-options'), label).toBe('nosniff');
}

describe('/api response hygiene', () => {
  it('no /api route, success, error, or 404, sends a CORS allow header, and every response is nosniff', async () => {
    const full = await startFullApp(); apps.push(full);
    const { app, h, base } = full;
    const routes = registeredRoutes(app).filter(({ path }) => path.startsWith('/api'));
    for (const expected of ['GET /api/tasks', 'GET /api/tasks/:taskId/runs', 'GET /api/executions/:id/record', 'DELETE /api/tasks/:taskId', 'POST /api/tasks', 'GET /api/artifacts/:id/download']) {
      expect(routes.map(({ method, path }) => `${method} ${path}`)).toContain(expected);
    }
    expect(routes.length).toBeGreaterThan(40);
    const id = String(h.execution.id);
    for (const { method, path } of routes) {
      const url = `${base}${path.replace(/:[A-Za-z]+/g, id)}`;
      const label = `${method} ${path}`;
      const init: RequestInit = { method, headers: { origin: 'https://attacker.example', 'access-control-request-method': method } };
      // A cross-site request: refused with the error envelope, never with an allow header.
      expectHygienic(await fetch(url, method === 'GET' ? { headers: { origin: 'https://attacker.example' } } : init), `${label} (foreign origin)`);
      // A same-origin request reaches the handler; any status is acceptable here, headers are what is asserted.
      const own = await fetch(url, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      expectHygienic(own, label);
      await own.arrayBuffer();
      // A CORS preflight is never answered with permission either.
      expectHygienic(await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://attacker.example', 'access-control-request-method': method } }), `OPTIONS ${path}`);
    }
    expectHygienic(await fetch(`${base}/api/does-not-exist`), '404');
    await h.quiesce();
  }, 60_000);
});
