import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTechnicalDetails } from '../../../components/history/use-technical-details';

function Preference() {
  const [on, change] = useTechnicalDetails();
  return <button onClick={() => change(!on)}>{on ? 'On' : 'Off'}</button>;
}

afterEach(() => { cleanup(); localStorage.clear(); });
describe('technical details preference', () => {
  it('defaults off, persists, and reads back after remount', async () => {
    const user = userEvent.setup();
    const view = render(<Preference />, { reactStrictMode: true });
    expect(screen.getByRole('button').textContent).toBe('Off');
    await user.click(screen.getByRole('button'));
    expect(localStorage.getItem('automate.showTechnicalDetails')).toBe('1');
    view.unmount();
    render(<Preference />);
    expect(screen.getByRole('button').textContent).toBe('On');
  });

  it('follows storage events from another tab', () => {
    render(<Preference />);
    localStorage.setItem('automate.showTechnicalDetails', '1');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'automate.showTechnicalDetails' })));
    expect(screen.getByRole('button').textContent).toBe('On');
  });

  it('stays off when browser storage cannot be read', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      render(<Preference />, { reactStrictMode: true });
      expect(screen.getByRole('button').textContent).toBe('Off');
    } finally { read.mockRestore(); }
  });
});
