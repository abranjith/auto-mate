import { useEffect, useState } from 'react';
import { ds } from '../design-system/tokens';

type Theme = 'light' | 'dark';

/** Read the saved preference. @returns A light or dark mode, falling back to the system preference when storage is unavailable. */
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('automate-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Storage may be blocked; the system preference remains usable. */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Render the mode control. @returns A button that applies and persists the chosen theme when possible. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  /** Switch the visible theme and save the choice when browser storage works. */
  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('automate-theme', next); }
    catch { /* Theme still changes for this session when storage is blocked. */ }
  }
  return <button type="button" className={ds.btnGhost} onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>Theme: {theme}</button>;
}
