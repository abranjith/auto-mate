import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeToggle } from './theme-toggle';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; });

it('shows the saved mode, changes it, and persists the choice', () => {
  localStorage.setItem('automate-theme', 'dark');
  render(<ThemeToggle />);
  expect(screen.getByText('Theme: dark')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('automate-theme')).toBe('light');
});

it('uses system preference when storage is empty or blocked', () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  const empty = render(<ThemeToggle />);
  expect(screen.getByText('Theme: dark')).toBeTruthy();
  empty.unmount();
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  vi.stubGlobal('localStorage', storage);
  render(<ThemeToggle />);
  expect(screen.getByText('Theme: dark')).toBeTruthy();
  fireEvent.click(screen.getByRole('button'));
  expect(document.documentElement.dataset.theme).toBe('light');
});
