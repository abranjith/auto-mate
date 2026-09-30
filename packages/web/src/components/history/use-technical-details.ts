import { createContext, useContext, useEffect, useState } from 'react';

const KEY = 'automate.showTechnicalDetails';

/** Safely read this browser's display preference. */
function stored(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** Share the technical display choice with nested run views. */
export const TechnicalDetailsContext = createContext(false);

/** Read the technical display choice from the nearest run page. */
export function useShowTechnical(): boolean { return useContext(TechnicalDetailsContext); }

/** Remember the choice in this browser and follow changes from other tabs. */
export function useTechnicalDetails(): readonly [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(stored);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === KEY) setOn(stored()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const change = (value: boolean) => {
    setOn(value);
    try { localStorage.setItem(KEY, value ? '1' : '0'); } catch { /* The view still works without storage. */ }
  };
  return [on, change] as const;
}
