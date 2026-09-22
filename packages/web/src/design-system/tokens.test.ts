import { expect, it } from 'vitest';
import { ds } from './tokens';

it('provides every documented semantic class', () => {
  for (const name of ['page', 'card', 'btnPrimary', 'btnGhost', 'navLink', 'navLinkActive', 'surface', 'textMuted'] as const) {
    expect(ds[name].trim().length).toBeGreaterThan(0);
  }
});
