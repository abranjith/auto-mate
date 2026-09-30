import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { RunFailure } from '@automate/core';
import { RunOutcomePanel } from '../../../components/history/run-outcome-panel';
import { TechnicalDetailsContext } from '../../../components/history/use-technical-details';

const failure: RunFailure = { tone: 'problem', headline: "This run didn't finish.", detail: 'It stopped.', limit: null, attempts: [], nextSteps: [{ action: 'retry_with_detail', label: 'Try again' }], technical: { code: 'INTERNAL_ERROR', correlationId: 'abc' } };
afterEach(cleanup);
describe('RunOutcomePanel', () => {
  it('offers one retry form and links the step to it', () => {
    render(<RunOutcomePanel failure={failure} retry={<textarea aria-label="Guidance" />} reviewing={false} executionId={1} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Try again with this' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe('#run-again');
    expect(screen.queryByText(/INTERNAL_ERROR|abc/)).toBeNull();
  });
  it('links an awaiting-review step to review and hides the retry slot', () => {
    render(<RunOutcomePanel failure={failure} retry={<textarea />} reviewing executionId={1} />);
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe('#review');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('shows diagnostics only with technical details', () => {
    render(<TechnicalDetailsContext.Provider value={true}><RunOutcomePanel failure={failure} retry={null} reviewing={false} executionId={1} /></TechnicalDetailsContext.Provider>);
    expect(screen.getByText('INTERNAL_ERROR')).toBeTruthy();
    expect(screen.getByText('abc')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
