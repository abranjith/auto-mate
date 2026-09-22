import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';
import { Route as RootRoute } from '../routes/__root';

vi.mock('../api/health-query', () => ({ useHealth: () => ({ isPending: true }) }));
beforeEach(() => vi.stubGlobal('scrollTo', vi.fn()));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPath(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  return render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
}

it('renders keyboard-reachable navigation links and history placeholder', async () => {
  renderPath('/history');
  expect(await screen.findByText('Execution history arrives in FEAT-110.')).toBeTruthy();
  for (const name of ['New task', 'History', 'Settings']) expect(screen.getByRole('link', { name })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'History' }).className).toContain('font-semibold');
});

it('renders a plain-English not-found page', async () => {
  renderPath('/does-not-exist');
  expect(await screen.findByText('Page not found')).toBeTruthy();
});

it('uses the route error boundary without showing a stack trace', async () => {
  const failure = createRoute({ getParentRoute: () => RootRoute, path: '/failure', component: () => { throw new Error('secret stack detail'); } });
  const router = createRouter({ routeTree: RootRoute.addChildren([failure]), history: createMemoryHistory({ initialEntries: ['/failure'] }) });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  expect(await screen.findByText('This page could not be opened')).toBeTruthy();
  expect(document.body.textContent).not.toContain('secret stack detail');
});
