import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ArtifactPreview, TablePage } from '@automate/core';
import { ArtifactTable, formulaNotice } from '../../../components/artifacts/artifact-table';
import { ArtifactImage } from '../../../components/artifacts/artifact-image';
import { ArtifactText } from '../../../components/artifacts/artifact-text';
import { ARTIFACT_MARKDOWN_OPTIONS, ArtifactMarkdown } from '../../../components/artifacts/artifact-markdown';
import { MARKDOWN_OPTIONS } from '../../../components/conversation/assistant-message';
import { ArtifactCard } from '../../../components/artifacts/artifact-card';
import { HOSTILE, artifact } from './artifact-fixtures';

afterEach(cleanup);

function page(overrides: Partial<TablePage> = {}): TablePage {
  return { columns: ['region', 'total'], rows: [['North', '10'], ['South', '20']], offset: 0, limit: 2, hasMore: false, scannedRowsCapped: false, truncatedCellCount: 0, sheet: null, otherSheets: [], formulaCellCount: null, ...overrides };
}
const preview = (text: string, overrides: Partial<ArtifactPreview> = {}): ArtifactPreview => ({ text, truncated: false, byteSize: text.length, previewBytes: text.length, ...overrides });
const textArtifact = artifact({ id: 5, filename: 'log.txt', type: 'text', renderMode: 'text', extension: '.txt', mimeType: 'text/plain; charset=utf-8' });
const markdownArtifact = artifact({ id: 6, filename: 'notes.md', type: 'markdown', renderMode: 'markdown', extension: '.md', mimeType: 'text/markdown; charset=utf-8' });
const imageArtifact = artifact({ id: 9, filename: 'chart.png', type: 'image', renderMode: 'image', extension: '.png', mimeType: 'image/png', title: 'Sales by month' });

describe('ArtifactTable', () => {
  it('renders the columns and rows, and pages forward and back', async () => {
    const load = vi.fn((_id: number, offset: number) => Promise.resolve(offset === 0 ? page({ hasMore: true }) : page({ offset: 2, rows: [['East', '30']], hasMore: false })));
    render(<ArtifactTable artifact={artifact()} pageSize={2} load={load} />);
    expect(await screen.findByText('North')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['region', 'total']);
    expect(screen.getByText('Rows 1–2')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('East')).toBeTruthy();
    expect(screen.getByText('Rows 3–3')).toBeTruthy();
    expect(load).toHaveBeenLastCalledWith(1, 2, 2);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('North')).toBeTruthy();
    expect(load).toHaveBeenLastCalledWith(1, 0, 2);
  });

  it('shows a formula-looking cell as that literal string, and says how many there are without changing the file', async () => {
    const dde = "=cmd|'/c calc'!A1";
    const scanned = artifact({ contentScan: { scannedRows: 2, rowsAreCapped: false, formulaCellCount: 3, sampledColumns: 2 } });
    render(<ArtifactTable artifact={scanned} load={() => Promise.resolve(page({ rows: [[dde, '<script>alert(1)</script>']] }))} />);
    const cell = await screen.findByText(dde);
    expect(cell.getAttribute('title')).toBe('Shown as text. It is not run as a formula.');
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(document.querySelector('td script')).toBeNull();
    expect(screen.getByText(formulaNotice(scanned)!)).toBeTruthy();
    expect(formulaNotice(scanned)).toBe('3 cells start with =, +, -, or @. Excel will treat them as formulas when you open the file. They are shown here as plain text, and the file itself has not been changed.');
  });

  it('says when the formula count covers only the first rows, and when the preview stops early', async () => {
    const capped = artifact({ contentScan: { scannedRows: 5_000, rowsAreCapped: true, formulaCellCount: 1, sampledColumns: 2 } });
    expect(formulaNotice(capped)).toMatch(/^1 cell in the first 5,000 rows start with/);
    expect(formulaNotice(artifact({ contentScan: { scannedRows: 5, rowsAreCapped: false, formulaCellCount: 0, sampledColumns: 1 } }))).toBeNull();
    render(<ArtifactTable artifact={capped} load={() => Promise.resolve(page({ scannedRowsCapped: true, sheet: 'Summary', otherSheets: ['North', 'South'] }))} />);
    expect(await screen.findByText(/The preview stops after this many rows/)).toBeTruthy();
    expect(screen.getByText(/The file also has: North, South/)).toBeTruthy();
  });

  it('turns a failed page into a sentence', async () => {
    render(<ArtifactTable artifact={artifact()} load={() => Promise.reject(new Error('The file for output 1 is no longer on this computer.'))} />);
    expect((await screen.findByRole('alert')).textContent).toBe('The file for output 1 is no longer on this computer.');
  });
});

describe('ArtifactMarkdown', () => {
  it('shares FEAT-103\'s markdown configuration object, by identity', () => {
    expect(ARTIFACT_MARKDOWN_OPTIONS).toBe(MARKDOWN_OPTIONS);
    expect(Object.isFrozen(MARKDOWN_OPTIONS)).toBe(true);
  });

  it('formats markdown, shows raw HTML as text, and opens links safely', async () => {
    const { container } = render(<ArtifactMarkdown artifact={markdownArtifact} load={() => Promise.resolve(preview('# Summary\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[site](https://example.com)'))} />);
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeTruthy();
    expect(container.querySelector('script, img')).toBeNull();
    const link = screen.getByRole('link', { name: 'site' });
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('does not make a javascript: link clickable', async () => {
    const { container } = render(<ArtifactMarkdown artifact={markdownArtifact} load={() => Promise.resolve(preview('[click](javascript:alert(1))'))} />);
    await screen.findByText('click');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

describe('ArtifactImage', () => {
  it('uses the content route with the title as alt text', () => {
    render(<ArtifactImage artifact={imageArtifact} />);
    const image = screen.getByRole('img', { name: 'Sales by month' });
    expect(image.getAttribute('src')).toBe('/api/artifacts/9/content');
  });

  it('falls back to a sentence and a download when the picture will not load', () => {
    render(<ArtifactImage artifact={artifact({ ...imageArtifact, title: null })} />);
    fireEvent.error(screen.getByRole('img', { name: 'chart.png' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('could not be shown here');
    expect(screen.getByRole('link', { name: 'Download: chart.png' })).toBeTruthy();
  });
});

describe('ArtifactText', () => {
  it('shows the head in a block with the truncation notice only above the cap', async () => {
    const { unmount } = render(<ArtifactText artifact={textArtifact} load={() => Promise.resolve(preview('line one\nline two'))} />);
    expect((await screen.findByText(/line one/)).tagName).toBe('PRE');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    unmount();
    render(<ArtifactText artifact={textArtifact} load={() => Promise.resolve(preview('head', { truncated: true, byteSize: 41_943_040, previewBytes: 5_242_880 }))} />);
    expect(await screen.findByText('Showing the first 5 MB of 40 MB.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download the whole file: log.txt' }).getAttribute('href')).toBe('/api/artifacts/5/download');
  });
});

describe('every renderer shows FEAT-107\'s hostile corpus as literal text', () => {
  it.each(HOSTILE)('%s', async (payload) => {
    const { container, unmount } = render(<div>
      <ArtifactTable artifact={artifact()} load={() => Promise.resolve(page({ columns: [payload], rows: [[payload]] }))} />
      <ArtifactText artifact={textArtifact} load={() => Promise.resolve(preview(payload))} />
      <ArtifactMarkdown artifact={markdownArtifact} load={() => Promise.resolve(preview(payload))} />
      <ArtifactImage artifact={artifact({ ...imageArtifact, title: payload })} />
    </div>);
    await waitFor(() => expect(screen.getAllByText(payload).length).toBeGreaterThanOrEqual(3));
    expect(container.querySelector('script, iframe')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect([...container.querySelectorAll('*')].flatMap((element) => element.getAttributeNames()).filter((name) => name.startsWith('on'))).toEqual([]);
    unmount();
  });
});

describe('ArtifactCard', () => {
  it('lazy-loads a trusted viewer only after Show preview, and hides it again', async () => {
    const card = render(<ul><ArtifactCard artifact={textArtifact} /></ul>);
    expect(card.container.querySelector('pre')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    expect(await within(card.container).findByText(/Loading|could not|no longer/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    expect(screen.getByRole('button', { name: 'Show preview' })).toBeTruthy();
  });

  it('gives generated HTML the frame, whose own Show preview is the only way in', async () => {
    const card = render(<ul><ArtifactCard artifact={artifact({ id: 7, filename: 'r.html', type: 'html', renderMode: 'sandboxed_html', extension: '.html', mimeType: 'text/html; charset=utf-8' })} /></ul>);
    expect(await screen.findByRole('button', { name: 'Show preview' })).toBeTruthy();
    expect(card.container.querySelector('iframe')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Show preview' })).toHaveLength(1);
  });
});
