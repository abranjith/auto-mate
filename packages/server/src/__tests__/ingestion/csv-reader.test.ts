import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { Readable } from 'node:stream';
import { EmptyFileError, ParseFailedError, profileTable } from '@automate/core';
import { openCsv } from '../../ingestion/csv-reader';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'automate-csv-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string | Uint8Array): string {
  const target = path.join(dir, name);
  writeFileSync(target, content);
  return target;
}

async function collect(rows: AsyncIterable<string[]>): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of rows) out.push(row);
  return out;
}

/** Record every stream the reader opens so a test can assert it was destroyed. */
function trackingOpener(): { streams: Readable[]; open: (target: string) => Readable } {
  const streams: Readable[] = [];
  return {
    streams,
    open: (target) => {
      const stream = createReadStream(target);
      streams.push(stream);
      return stream;
    },
  };
}

const options = { maxRows: 1_000_000 };

describe('openCsv', () => {
  it('reads a comma file with a header', async () => {
    const table = await openCsv(file('a.csv', 'id,name,amount\n1,Ada,3.5\n2,Grace,4\n'), options);
    expect(table.header).toEqual(['id', 'name', 'amount']);
    expect(table.headerRowIndex).toBe(0);
    expect(await collect(table.rows)).toEqual([
      ['1', 'Ada', '3.5'],
      ['2', 'Grace', '4'],
    ]);
    expect(table.truncated).toBe(false);
  });

  it.each([
    [';', 'id;name\n1;Ada\n2;Grace\n'],
    ['\t', 'id\tname\n1\tAda\n2\tGrace\n'],
    ['|', 'id|name\n1|Ada\n2|Grace\n'],
  ])('parses a %j-delimited file', async (delimiter, content) => {
    const table = await openCsv(file('d.csv', content), options);
    expect(table.dialect.delimiter).toBe(delimiter);
    expect(await collect(table.rows)).toEqual([
      ['1', 'Ada'],
      ['2', 'Grace'],
    ]);
  });

  it('decodes a windows-1252 file with accented characters end to end, and notes the guess', async () => {
    const latin1 = Buffer.from('id,name\n1,Zoë\n2,José\n', 'latin1');
    const table = await openCsv(file('w.csv', latin1), options);
    expect(table.encoding.encoding).toBe('windows-1252');
    expect(await collect(table.rows)).toEqual([
      ['1', 'Zoë'],
      ['2', 'José'],
    ]);
    expect(table.notes).toEqual([{ code: 'encoding_guessed', formats: ['windows-1252'] }]);
  });

  it('falls back to windows-1252 when the only latin-1 byte is beyond the 64 KiB probe', async () => {
    const ascii = Array.from({ length: 5_000 }, (_, index) => `${index},name${index}`).join('\n');
    const bytes = Buffer.concat([Buffer.from(`id,name\n${ascii}\n`), Buffer.from('9999,Renée\n', 'latin1')]);
    expect(bytes.length).toBeGreaterThan(65_536);
    const table = await openCsv(file('late.csv', bytes), options);
    expect(table.encoding.encoding).toBe('windows-1252');
    expect((await collect(table.rows)).at(-1)).toEqual(['9999', 'Renée']);
  });

  it('confirms UTF-8 with full confidence when a partial ASCII probe is followed by valid UTF-8', async () => {
    const ascii = Array.from({ length: 5_000 }, (_, index) => `${index},name${index}`).join('\n');
    const table = await openCsv(file('late-utf8.csv', `id,name\n${ascii}\n9999,東京\n`), options);
    expect(table.encoding).toEqual({ encoding: 'utf-8', confidence: 1, bomLength: 0 });
    expect(table.notes).toEqual([]);
  });

  it('does not leak a UTF-8 BOM into the first header name', async () => {
    const table = await openCsv(file('bom.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('id,name\n1,Ada\n')])), options);
    expect(table.header?.[0]).toBe('id');
    expect(table.dialectInfo.hasBom).toBe(true);
    await collect(table.rows);
  });

  it('decodes a UTF-16LE file with a BOM', async () => {
    const content = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('id,name\n1,Ada\n', 'utf16le')]);
    const table = await openCsv(file('u16.csv', content), options);
    expect(table.header).toEqual(['id', 'name']);
    expect(await collect(table.rows)).toEqual([['1', 'Ada']]);
  });

  it('keeps quoted delimiters, embedded newlines, and doubled quotes as single values', async () => {
    const table = await openCsv(file('q.csv', 'id,comment,n\n1,"Hello, world",2\n2,"line one\nline two",3\n3,"She said ""hi""",4\n'), options);
    expect(await collect(table.rows)).toEqual([
      ['1', 'Hello, world', '2'],
      ['2', 'line one\nline two', '3'],
      ['3', 'She said "hi"', '4'],
    ]);
  });

  it('yields a ragged row with its own field count instead of throwing', async () => {
    const table = await openCsv(file('r.csv', 'id,name\n1,Ada\n2\n3,Grace,extra\n'), options);
    expect((await collect(table.rows)).map((row) => row.length)).toEqual([2, 1, 3]);
  });

  it('leaves no carriage return on the last field of CRLF rows', async () => {
    const table = await openCsv(file('crlf.csv', 'id,name\r\n1,Ada\r\n2,Grace\r\n'), options);
    expect(table.header).toEqual(['id', 'name']);
    expect((await collect(table.rows)).flat().some((cell) => cell.includes('\r'))).toBe(false);
  });

  it('keeps blank rows so they can be counted, and skips leading ones before the header', async () => {
    const table = await openCsv(file('b.csv', '\n\nid,name\n1,Ada\n\n2,Grace\n'), options);
    expect(table.leadingRowsSkipped).toBe(2);
    expect(table.headerRowIndex).toBe(2);
    expect(await collect(table.rows)).toEqual([['1', 'Ada'], [''], ['2', 'Grace']]);
  });

  it('raises EmptyFileError for a zero-byte file', async () => {
    await expect(openCsv(file('empty.csv', ''), options)).rejects.toBeInstanceOf(EmptyFileError);
  });

  it('yields zero data rows for a header-only file but keeps its column names', async () => {
    const table = await openCsv(file('h.csv', 'id,name,city\n'), options);
    expect(table.header).toEqual(['id', 'name', 'city']);
    expect(await collect(table.rows)).toEqual([]);
  });

  it('stops at exactly maxRows, reports truncation, and destroys the stream', async () => {
    const tracker = trackingOpener();
    const rows = Array.from({ length: 100 }, (_, index) => `${index},${index * 2}`).join('\n');
    const table = await openCsv(file('cap.csv', `a,b\n${rows}\n`), { maxRows: 10, openStream: tracker.open });
    expect(await collect(table.rows)).toHaveLength(10);
    expect(table.truncated).toBe(true);
    expect(tracker.streams.at(-1)!.destroyed).toBe(true);
  });

  it('destroys the stream when closed without being iterated', async () => {
    const tracker = trackingOpener();
    const table = await openCsv(file('c.csv', 'a,b\n1,2\n'), { ...options, openStream: tracker.open });
    table.close();
    expect(tracker.streams.every((stream) => stream.destroyed)).toBe(true);
  });

  it('stops reading and destroys the stream when the signal aborts', async () => {
    const tracker = trackingOpener();
    const controller = new AbortController();
    const rows = Array.from({ length: 50_000 }, (_, index) => `${index},${index}`).join('\n');
    const table = await openCsv(file('abort.csv', `a,b\n${rows}\n`), { ...options, signal: controller.signal, openStream: tracker.open });
    const iterate = async () => {
      let seen = 0;
      for await (const row of table.rows) {
        expect(row).toHaveLength(2);
        if (++seen === 5) controller.abort(new Error('timed out'));
      }
    };
    await expect(iterate()).rejects.toThrow('timed out');
    expect(tracker.streams.at(-1)!.destroyed).toBe(true);
  });

  it('raises ParseFailedError with a line number and no library text for an unclosed quote at EOF', async () => {
    const table = await openCsv(file('bad.csv', 'id,comment\n1,ok\n2,fine\n3,"never closed\n'), options);
    const failure = await collect(table.rows).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ParseFailedError);
    expect((failure as ParseFailedError).message).toContain('(line 4)');
    expect((failure as ParseFailedError).message).not.toMatch(/Quote Not Closed|CSV_|csv-parse/);
  });

  it('iterates a 100,000-row file and profiles it with bounded memory', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const rows = Array.from({ length: 100_000 }, (_, index) => `${index},${(index * 7) % 1_000},2026-01-${String((index % 28) + 1).padStart(2, '0')},note ${index}`);
    const target = file('big.csv', `id,amount,day,note\n${rows.join('\n')}\n`);
    gc();
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const table = await openCsv(target, options);
    const tracked = (async function* () {
      let seen = 0;
      for await (const row of table.rows) {
        if (++seen % 10_000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
        yield row;
      }
    })();
    const started = Date.now();
    const profile = await profileTable(
      { rows: tracked, header: table.header, headerRowIndex: table.headerRowIndex, expectedWidth: table.dialect.columnCount },
      { sheetName: null, sheetIndex: 0, isHidden: false, delimiter: table.dialect.delimiter, dialect: table.dialectInfo },
      { seed: 'd'.repeat(64), maxRows: 1_000_000, maxColumns: 512 },
    );
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(profile.rowCount).toBe(100_000);
    expect(profile.columns.map(({ inferredType }) => inferredType)).toEqual(['integer', 'integer', 'date', 'string']);
    expect(peak - baseline).toBeLessThan(96 * 1024 * 1024);
  }, 60_000);
});
