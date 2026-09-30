import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ArtifactList } from '../../../components/artifacts/artifact-list';
import { UNDECLARED_SENTENCE } from '../../../components/artifacts/artifact-card';
import { RunResult } from '../../../components/execution/run-result';
import { ConversationView, describeRegistration } from '../../../components/conversation/conversation-view';
import { HOSTILE, artifact, list, run } from './artifact-fixtures';

afterEach(cleanup);

const THREE = [artifact({ id: 1 }), artifact({ id: 2, filename: 'chart.png', type: 'image', renderMode: 'image', extension: '.png', mimeType: 'image/png', byteSize: 1_048_576, title: 'Chart' }), artifact({ id: 3, filename: 'extra.txt', type: 'text', renderMode: 'text', extension: '.txt', declared: false, title: null, description: null, byteSize: 10 })];

function webSources(dir = path.join(import.meta.dirname, '..', '..', '..')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? webSources(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('ArtifactList', () => {
  it('renders one card per artifact with its name, type, and size', () => {
    render(<ArtifactList list={list(THREE)} />);
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText('totals.csv')).toBeTruthy();
    expect(within(cards[0]!).getByText('csv · 2 KB')).toBeTruthy();
    expect(within(cards[1]!).getByText('image · 1 MB')).toBeTruthy();
    expect(within(cards[2]!).getByText('text · 10 bytes')).toBeTruthy();
    for (const card of cards) expect(within(card).getByRole('link', { name: /^Download:/ }).getAttribute('href')).toMatch(/^\/api\/artifacts\/\d\/download$/);
  });

  it('marks an undeclared file with a badge and a sentence, and nothing else', () => {
    render(<ArtifactList list={list(THREE)} />);
    const [first, , third] = screen.getAllByRole('listitem');
    expect(within(third!).getByText('Not listed')).toBeTruthy();
    expect(within(third!).getByText(UNDECLARED_SENTENCE)).toBeTruthy();
    expect(within(first!).queryByText('Not listed')).toBeNull();
    expect(UNDECLARED_SENTENCE).toBe('The script wrote this but did not list it.');
  });

  it('renders every discrepancy as a sentence, not a table of numbers', () => {
    render(<ArtifactList list={list(THREE, { discrepancies: [{ kind: 'missing', count: 2, message: 'The script said it would produce 3 files, but 2 of them were not written.' }, { kind: 'unregistered', count: 1, message: '1 file the script wrote could not be kept, because of an unsupported file type or the per-run file limit.' }] })} />);
    expect(screen.getByText('The script said it would produce 3 files, but 2 of them were not written.')).toBeTruthy();
    expect(screen.getByText(/1 file the script wrote could not be kept/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers Download all only for more than one file, with the count and total size on the control', () => {
    const { unmount } = render(<ArtifactList list={list([artifact()])} />);
    expect(screen.queryByRole('link', { name: /Download all/ })).toBeNull();
    unmount();
    render(<ArtifactList list={list(THREE)} />);
    const all = screen.getByRole('link', { name: 'Download all 3 files (1 MB) as a ZIP' });
    expect(all.getAttribute('href')).toBe('/api/executions/2/artifacts/archive');
    expect(all.hasAttribute('download')).toBe(true);
  });

  it('renders every hostile title, description, and filename as literal text', () => {
    const hostile = HOSTILE.map((payload, index) => artifact({ id: index + 1, filename: `${payload}.csv`, title: payload, description: `=${payload}` }));
    const { container } = render(<ArtifactList list={list(hostile)} />);
    for (const payload of HOSTILE) expect(screen.getAllByText(payload).length).toBeGreaterThan(0);
    expect(container.querySelector('script, img, iframe')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    // Model text may sit inside an attribute value (aria-label), never become an attribute or an element.
    const attributes = [...container.querySelectorAll('*')].flatMap((element) => element.getAttributeNames());
    expect(attributes.filter((name) => name.startsWith('on'))).toEqual([]);
  });
});

describe('RunResult with declared outputs', () => {
  it('keeps the declared filename summary in the run detail', () => {
    render(<RunResult run={run({ declaredOutputs: [{ filename: 'a.csv', type: 'csv', title: 'A', description: '', byteSize: 1, present: true }] })} />);
    expect(screen.getByLabelText('Run result').textContent).toContain('What it produced');
  });

  it('no longer apologises that viewing and downloading arrive later, anywhere in the web package', () => {
    render(<RunResult run={run({ declaredOutputs: [{ filename: 'a.csv', type: 'csv', title: 'A', description: '', byteSize: 1, present: true }] })} />);
    const apology = new RegExp([['next', 'feature'].join(' '), 'coming soon', ['arrives', 'with', 'the'].join(' ')].join('|'), 'i');
    expect(document.body.textContent).not.toMatch(apology);
    for (const file of webSources()) expect(readFileSync(file, 'utf8'), file).not.toMatch(new RegExp(['next', 'feature'].join(' '), 'i'));
  });
});

describe('the transcript line', () => {
  it('states the counts in words, with nothing model-written in it', () => {
    expect(describeRegistration({ artifactCount: 4, undeclaredCount: 1, unregisteredOutputCount: 0 })).toBe('Kept 4 files from this run, 1 of them not listed by the script.');
    expect(describeRegistration({ artifactCount: 1, undeclaredCount: 0, unregisteredOutputCount: 2 })).toBe('Kept 1 file from this run. 2 files could not be kept.');
    expect(describeRegistration({ artifactCount: 0, undeclaredCount: 0, unregisteredOutputCount: 0 })).toBe('No output files were kept.');
    render(<ConversationView events={[{ seq: 1, type: 'artifacts_registered', scriptRunId: 1, artifactCount: 2, undeclaredCount: 0, unregisteredOutputCount: 0, totalBytes: 10, at: '2026-09-25T00:00:00Z' }]} />);
    expect(screen.getByText('Kept 2 files from this run.')).toBeTruthy();
  });
});
