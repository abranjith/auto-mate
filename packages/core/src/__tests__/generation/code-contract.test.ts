import { describe, expect, it } from 'vitest';
import { MANIFEST_FILENAME, SYNTHETIC_DATA_WARNING, renderCodeContract, type CodeContractContext } from '../../generation/code-contract';
import { ARTIFACT_TYPES } from '../../contracts/generation-api';

const DEPENDENCIES = ['pandas', 'openpyxl', 'plotly', 'pytest'];
const context: CodeContractContext = { platform: 'win32', pythonVersion: '3.12.4', dependencies: DEPENDENCIES, inputFiles: [{ filename: '7-sales.csv', format: 'csv', sheets: [] }, { filename: '8-book.xlsx', format: 'xlsx', sheets: ['Orders', 'Regions'] }], attemptLimit: 3 };

describe('renderCodeContract', () => {
  it('is deterministic', () => {
    expect(renderCodeContract(context)).toBe(renderCodeContract({ ...context, inputFiles: [...context.inputFiles] }));
  });

  it('names every dependency, the platform, the Python version, and forbids installs, the network, and shell', () => {
    const text = renderCodeContract(context);
    for (const name of DEPENDENCIES) expect(text).toContain(name);
    expect(text).toContain('Python 3.12.4');
    expect(text).toContain('for Windows');
    expect(text).toMatch(/Do not install packages, do not use the network, and do not write shell scripts\./);
  });

  it('states the synthetic-data warning verbatim — the sentence a refactor most easily drops', () => {
    expect(SYNTHETIC_DATA_WARNING).toBe('The data available during testing is synthetic and shaped like the real file, so the code must not assume values it saw, only the schema it was given.');
    expect(renderCodeContract(context)).toContain(SYNTHETIC_DATA_WARNING);
  });

  it('names inputs by environment variable and stored filename, and the manifest with every artifact type', () => {
    const text = renderCodeContract(context);
    expect(text).toContain('AUTOMATE_INPUT_DIR');
    expect(text).toContain('AUTOMATE_OUTPUT_DIR');
    expect(text).toContain('`7-sales.csv` (CSV)');
    expect(text).toContain('`8-book.xlsx` (XLSX; sheets in order: "Orders", "Regions")');
    expect(text).toContain(MANIFEST_FILENAME);
    for (const type of ARTIFACT_TYPES) expect(text).toContain(type);
    expect(text).toContain("include_plotlyjs=True, never 'cdn'");
  });

  it('states the attempt budget and what to do when it is spent', () => {
    expect(renderCodeContract(context)).toContain('You have 3 test runs.');
    expect(renderCodeContract({ ...context, attemptLimit: 1 })).toContain('You have 1 test run.');
    expect(renderCodeContract(context)).toContain('When run_tests refuses, or the tests pass, call finalize_script once');
  });

  it('contains no absolute filesystem path', () => {
    const text = renderCodeContract(context);
    expect(text).not.toMatch(/[A-Za-z]:\\|(?:^|\s)\/(?:home|Users|tmp|var|etc)\//);
  });

  it('degrades sensibly with no inputs and no probed Python', () => {
    const text = renderCodeContract({ ...context, inputFiles: [], pythonVersion: null, platform: 'plan9' });
    expect(text).toContain('There are no input files.');
    expect(text).toContain('Write Python only for plan9.');
  });
});
