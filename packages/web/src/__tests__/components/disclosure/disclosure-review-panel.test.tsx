import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisclosurePreviewResponse } from '@automate/core';
import { DisclosureReviewPanel } from '../../../components/disclosure/disclosure-review-panel';

afterEach(cleanup);
const text = '<script>alert(1)</script> | onerror=alert(1) | =HYPERLINK("x")';
const preview: DisclosurePreviewResponse = { uploadIds: [1], text, digest: 'a'.repeat(64), byteSize: 72, provider: 'anthropic', model: 'claude-sonnet-5', truncations: ['drop_top_values'], required: [{ findingKey: '1:c:date', impact: 'meaning', question: 'Day first?', rationale: 'The meaning changes.', options: [{ value: 'DD/MM', label: 'Day first' }, { value: 'MM/DD', label: 'Month first' }], proposedDefault: 'DD/MM' }], defaults: [], notices: [] };

describe('DisclosureReviewPanel', () => {
  it('renders literal bytes and requires every choice without preselecting', async () => {
    const user = userEvent.setup(); const approve = vi.fn();
    const { container } = render(<DisclosureReviewPanel preview={preview} pending={false} onApprove={approve} onRefresh={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByText(/show exactly/i));
    expect(screen.getByText(text).textContent).toBe(text);
    expect(container.querySelector('script')).toBeNull();
    const start = screen.getByRole('button', { name: /approve and start/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect((screen.getByRole('radio', { name: 'Day first' }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole('radio', { name: 'Day first' }));
    expect(start.disabled).toBe(false);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    await user.click(start);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ diagnostics: true, decisions: [{ findingKey: '1:c:date', choice: 'DD/MM' }] }));
    expect(screen.getByText(/drop_top_values was omitted/)).toBeTruthy();
  });

  it('returns an edited applied default with approval', async () => {
    const user = userEvent.setup();
    const approve = vi.fn();
    render(<DisclosureReviewPanel preview={{ ...preview, required: [], defaults: [{ findingKey: '1:0:delimiter', label: 'Detected delimiter', value: ',', demoted: false }] }} pending={false} onApprove={approve} onRefresh={vi.fn()} onCancel={vi.fn()} />);
    const override = screen.getByRole('textbox', { name: /detected delimiter override/i });
    await user.clear(override);
    await user.type(override, ';');
    await user.click(screen.getByRole('button', { name: /approve and start/i }));
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ defaults: { '1:0:delimiter': ';' } }));
  });
});
