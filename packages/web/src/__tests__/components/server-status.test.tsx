import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ServerStatus } from '../../components/server-status';
import { useHealth } from '../../api/health-query';

vi.mock('../../api/health-query', () => ({ useHealth: vi.fn() }));
const mocked = vi.mocked(useHealth);
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('shows the schema version when connected', () => {
  mocked.mockReturnValue({ data: { status: 'ok', database: { connected: true, schemaVersion: '1' } }, isError: false, isPending: false } as ReturnType<typeof useHealth>);
  render(<ServerStatus />);
  expect(screen.getByText(/Server connected · schema 1/)).toBeTruthy();
});

it('explains degraded and unreachable states', () => {
  mocked.mockReturnValue({ data: { status: 'degraded' }, isError: false, isPending: false } as ReturnType<typeof useHealth>);
  const view = render(<ServerStatus />);
  expect(screen.getByText(/Server degraded/)).toBeTruthy();
  mocked.mockReturnValue({ data: undefined, isError: true, isPending: false } as ReturnType<typeof useHealth>);
  view.rerender(<ServerStatus />);
  expect(screen.getByText(/Start it with pnpm dev/)).toBeTruthy();
});
