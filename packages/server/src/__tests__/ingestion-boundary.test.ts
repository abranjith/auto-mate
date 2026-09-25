// Cross-feature boundaries for FEAT-104, as tests rather than review notes.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreIngestion = path.resolve(serverSrc, '../../core/src/ingestion');

function sources(directory: string): { file: string; text: string }[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return { file: path.relative(serverSrc, file), text: readFileSync(file, 'utf8') };
    });
}

const importsOf = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);

describe('FEAT-104 boundaries', () => {
  const ingestion = sources(path.join(serverSrc, 'ingestion'));

  it('scans a non-empty ingestion directory', () => {
    expect(ingestion.length).toBeGreaterThan(5);
  });

  it('imports nothing from the agent layer or the Pi SDK', () => {
    const offenders = ingestion.filter(({ text }) => /src\/agent|pi-coding-agent/.test(text) || importsOf(text).some((spec) => /(^|\/)agent(\/|$)/.test(spec)));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('makes no network call: no fetch, no http or https module', () => {
    const offenders = ingestion.filter(({ text }) => /\bfetch\(|require\('https?'\)|from 'node:https?'|from 'https?'/.test(text));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('keeps the core ingestion logic free of Node built-ins', () => {
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const offenders = sources(coreIngestion).filter(({ text }) => importsOf(text).some((spec) => spec.startsWith('node:') || builtins.has(spec)));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('never loads a workbook with the in-memory reader outside fixture generation', () => {
    const offenders = sources(serverSrc).filter(
      ({ file, text }) => !file.endsWith(path.join('support', 'workbook-fixtures.ts')) && !file.endsWith('ingestion-boundary.test.ts') && /xlsx\.readFile|new ExcelJS\.Workbook\(\)/.test(text),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('never renders file content as HTML in the web ingestion components', () => {
    const web = sources(path.resolve(serverSrc, '../../web/src/components/ingestion'));
    expect(web.length).toBeGreaterThan(3);
    expect(web.filter(({ text }) => text.includes('dangerouslySetInnerHTML')).map(({ file }) => file)).toEqual([]);
  });
});
