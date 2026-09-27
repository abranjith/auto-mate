import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { SANDBOX_ATTRIBUTE, describeArtifactSafety } from '@automate/core';
import { ArtifactFrame } from '../../../components/artifacts/artifact-frame';
import { artifact } from './artifact-fixtures';

afterEach(() => { cleanup(); vi.useRealTimers(); });

// Never typed: the literal token must appear nowhere in packages/web or packages/core, this file included.
const SAME_ORIGIN_TOKEN = ['allow', 'same', 'origin'].join('-');
const report = artifact({ id: 7, filename: 'report.html', type: 'plotly-html', extension: '.html', mimeType: 'text/html; charset=utf-8', renderMode: 'sandboxed_html', byteSize: 3_500_000 });
const pdf = artifact({ id: 8, filename: 'summary.pdf', type: 'pdf', extension: '.pdf', mimeType: 'application/pdf', renderMode: 'sandboxed_pdf' });

function sources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    return statSync(full).isDirectory() ? sources(full) : /\.(ts|tsx|css|html)$/.test(name) ? [full] : [];
  });
}
const PACKAGES = path.join(import.meta.dirname, '..', '..', '..', '..', '..');

describe('ArtifactFrame', () => {
  it('mounts nothing before the click, and shows the safety sentences verbatim', () => {
    const { container } = render(<ArtifactFrame artifact={report} />);
    expect(container.querySelector('iframe')).toBeNull();
    const shown = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(shown).toEqual(describeArtifactSafety('sandboxed_html'));
    expect(screen.getByText('3.3 MB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show preview' })).toBeTruthy();
  });

  it('mounts exactly one frame that may run scripts and nothing else, over the content route', async () => {
    const { container } = render(<ArtifactFrame artifact={report} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    const frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).toBe(SANDBOX_ATTRIBUTE);
    expect(frame.getAttribute('sandbox')).not.toContain(SAME_ORIGIN_TOKEN);
    expect(SANDBOX_ATTRIBUTE).not.toContain(SAME_ORIGIN_TOKEN);
    for (const grant of ['allow-popups', 'allow-forms', 'allow-top-navigation', 'allow-modals']) expect(frame.getAttribute('sandbox')).not.toContain(grant);
    expect(frame.getAttribute('src')).toBe('/api/artifacts/7/content');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('loading')).toBe('lazy');
    expect(frame.getAttribute('title')).toBe('Preview of report.html');
  });

  it('tears the frame down on Close preview rather than hiding it', async () => {
    const { container } = render(<ArtifactFrame artifact={report} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Show preview' })).toBeTruthy();
  });

  it('replaces a PDF frame that never reports a load with a download prompt', async () => {
    vi.useFakeTimers();
    const { container } = render(<ArtifactFrame artifact={pdf} loadTimeoutMs={1_000} />);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(describeArtifactSafety('sandboxed_pdf'));
    act(() => { screen.getByRole('button', { name: 'Show preview' }).click(); });
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toMatch(/did not show this PDF/);
    expect(screen.getByRole('link', { name: 'Download: summary.pdf' }).getAttribute('href')).toBe('/api/artifacts/8/download');
  });

  it('keeps a PDF frame that loaded', async () => {
    vi.useFakeTimers();
    const { container } = render(<ArtifactFrame artifact={pdf} loadTimeoutMs={1_000} />);
    act(() => { screen.getByRole('button', { name: 'Show preview' }).click(); });
    act(() => { container.querySelector('iframe')!.dispatchEvent(new Event('load')); });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
  });
});

describe('source guards', () => {
  it('the same-origin sandbox token appears nowhere in packages/web or packages/core', () => {
    const offenders = ['web', 'core'].flatMap((pkg) => sources(path.join(PACKAGES, pkg, 'src'))).filter((file) => readFileSync(file, 'utf8').includes(SAME_ORIGIN_TOKEN));
    expect(offenders).toEqual([]);
  });

  it('no artifact component, or its tests, injects raw HTML or enables the raw-HTML markdown plugin', () => {
    const files = [...sources(path.join(PACKAGES, 'web', 'src', 'components', 'artifacts')), ...sources(path.join(import.meta.dirname))];
    const unsafe = ['dangerously', 'SetInnerHTML'].join('');
    const raw = ['rehype', 'raw'].join('-');
    expect(files.filter((file) => { const text = readFileSync(file, 'utf8'); return text.includes(unsafe) || text.includes(raw); })).toEqual([]);
  });

  it('types the sandbox value nowhere: the frame takes it from the shared constant', () => {
    const frame = readFileSync(path.join(PACKAGES, 'web', 'src', 'components', 'artifacts', 'artifact-frame.tsx'), 'utf8');
    expect(frame).toContain('sandbox={SANDBOX_ATTRIBUTE}');
    expect(frame).not.toMatch(/sandbox=["']/);
  });
});
