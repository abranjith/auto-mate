import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname, '../..');
const constructionFile = path.resolve(sourceRoot, 'disclosure/disclosure-run-strategy.ts');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

describe('disclosure construction boundary', () => {
  it('keeps prompt assembly and conversation transport in the disclosure strategy', () => {
    const files = [...sourceFiles(path.resolve(sourceRoot, 'conversation')), ...sourceFiles(path.resolve(sourceRoot, 'disclosure'))];
    const violations = files.filter((file) => file !== constructionFile).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return ['assemblePromptContext(', 'provider.open(', 'session.run(']
        .filter((needle) => source.includes(needle))
        .map((needle) => `${path.relative(sourceRoot, file)} contains ${needle}`);
    });
    expect(violations).toEqual([]);
    const boundary = readFileSync(constructionFile, 'utf8');
    expect(boundary).toContain('assemblePromptContext(');
    expect(boundary).toContain('provider.open(');
    expect(boundary).toContain('session.run(');
  });
});
