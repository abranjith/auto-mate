import { describe, expect, it } from 'vitest';
import { sniffCsvDialect, splitRecords } from '../../ingestion/csv-dialect';

describe('sniffCsvDialect', () => {
  it.each([
    [',', 'id,amount,city\n1,3.5,Paris\n2,4.25,Oslo\n'],
    [';', 'id;amount;city\n1;3.5;Paris\n2;4.25;Oslo\n'],
    ['\t', 'id\tamount\tcity\n1\t3.5\tParis\n2\t4.25\tOslo\n'],
    ['|', 'id|amount|city\n1|3.5|Paris\n2|4.25|Oslo\n'],
  ])('detects the %j delimiter', (delimiter, text) => {
    const dialect = sniffCsvDialect(text, true);
    expect(dialect.delimiter).toBe(delimiter);
    expect(dialect.columnCount).toBe(3);
    expect(dialect.confidence.delimiter).toBe(1);
  });

  it('does not mistake comma decimals in a semicolon file for comma separation', () => {
    const text = 'id;amount;note\n1;3,50;a\n2;4,25;b\n3;5;c\n4;6,75;d\n';
    expect(sniffCsvDialect(text, true).delimiter).toBe(';');
  });

  it('keeps quoted delimiters, embedded newlines, and doubled quotes inside one field', () => {
    const text = 'id,comment,amount\n1,"Hello, world",2\n2,"line one\nline two",3\n3,"She said ""hi""",4\n';
    const dialect = sniffCsvDialect(text, true);
    expect(dialect.delimiter).toBe(',');
    expect(dialect.columnCount).toBe(3);
    expect(dialect.confidence.delimiter).toBe(1);
    expect(splitRecords(text, ',', '"', 10).records[3]).toEqual(['3', 'She said "hi"', '4']);
  });

  it('yields a one-column result, not a spurious delimiter, for a single-column file', () => {
    const dialect = sniffCsvDialect('name\nAda\nGrace\nKatherine\n', true);
    expect(dialect.columnCount).toBe(1);
    expect(dialect.confidence.delimiter).toBe(0);
  });

  it.each([
    ['\r\n', 'a,b\r\n1,2\r\n3,4\r\n'],
    ['\n', 'a,b\n1,2\n3,4\n'],
    ['\r', 'a,b\r1,2\r3,4\r'],
  ] as const)('detects %j line endings and leaves no carriage return on the last field', (ending, text) => {
    const dialect = sniffCsvDialect(text, true);
    expect(dialect.lineEnding).toBe(ending);
    expect(splitRecords(text, ',', '"', 10).records.flat().some((field) => field.includes('\r'))).toBe(false);
  });

  it('detects a header for a typed table', () => {
    const dialect = sniffCsvDialect('id,amount,city\n1,3.5,Paris\n2,4.25,Oslo\n', true);
    expect(dialect.hasHeader).toBe(true);
    expect(dialect.columnNames).toEqual(['id', 'amount', 'city']);
    expect(dialect.confidence.header).toBe(1);
  });

  it('does not detect a header when row 0 is numeric', () => {
    const dialect = sniffCsvDialect('1,3.5,Paris\n2,4.25,Oslo\n', true);
    expect(dialect.hasHeader).toBe(false);
    expect(dialect.confidence.header).toBe(1);
  });

  it('does not detect a header when row 0 has duplicate values', () => {
    expect(sniffCsvDialect('amount,amount,city\n1,2,Paris\n3,4,Oslo\n', true).hasHeader).toBe(false);
  });

  it('yields column_1…column_n for a header-less file', () => {
    expect(sniffCsvDialect('1,2,3\n4,5,6\n', true).columnNames).toEqual(['column_1', 'column_2', 'column_3']);
  });

  it('keeps a header-only file as a header', () => {
    const dialect = sniffCsvDialect('id,name,city\n', true);
    expect(dialect.hasHeader).toBe(true);
    expect(dialect.columnNames).toEqual(['id', 'name', 'city']);
  });

  it('prefers a single-quote dialect only when single quotes alone mark fields', () => {
    expect(sniffCsvDialect("id,name\n1,'Smith, J'\n2,'Lee'\n", true).quoteChar).toBe("'");
    expect(sniffCsvDialect('id,name\n1,"O\'Brien"\n2,"Lee"\n', true).quoteChar).toBe('"');
  });

  it('ignores a record cut off by an incomplete probe', () => {
    const dialect = sniffCsvDialect('a,b,c\n1,2,3\n4,5,6\n7,8', false);
    expect(dialect.confidence.delimiter).toBe(1);
  });

  it('skips blank lines when judging consistency and the header', () => {
    const dialect = sniffCsvDialect('\n\nid,amount\n\n1,2\n3,4\n\n', true);
    expect(dialect.hasHeader).toBe(true);
    expect(dialect.confidence.delimiter).toBe(1);
  });

  it('returns a harmless default for empty text', () => {
    const dialect = sniffCsvDialect('', true);
    expect(dialect.columnCount).toBe(1);
    expect(dialect.hasHeader).toBe(false);
  });
});

describe('splitRecords', () => {
  it('reports an unterminated quote as a partial last record', () => {
    const result = splitRecords('a,b\n1,"open', ',', '"', 10);
    expect(result.lastIsPartial).toBe(true);
    expect(result.records).toHaveLength(2);
  });

  it('stops at the record limit', () => {
    expect(splitRecords('1\n2\n3\n4\n', ',', '"', 2).records).toEqual([['1'], ['2']]);
  });

  it('treats a quote inside an unquoted field as literal', () => {
    expect(splitRecords('5" pipe,2\n', ',', '"', 10).records).toEqual([['5" pipe', '2']]);
  });
});
