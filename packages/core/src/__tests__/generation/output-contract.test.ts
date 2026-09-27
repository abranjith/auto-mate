import { describe, expect, it } from 'vitest';
import { OUTPUT_CONTRACT_RULES, renderCodeContract, type CodeContractContext } from '../../generation/code-contract';
import { ARTIFACT_TYPES } from '../../contracts/generation-api';
import { ARTIFACT_TYPE_POLICY } from '../../artifacts/artifact-type';

const MEMORY_NINE = ['csv', 'plotly-html', 'html', 'image', 'markdown', 'json', 'text', 'xlsx', 'pdf'];
const context: CodeContractContext = { platform: 'linux', pythonVersion: '3.14.6', dependencies: ['pandas', 'plotly'], inputFiles: [], attemptLimit: 3 };

/** Split text into sentences on terminal punctuation. */
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/);

describe('the output contract (FEAT-109)', () => {
  it('is rendered into the code contract, every rule verbatim', () => {
    const text = renderCodeContract(context);
    for (const rule of OUTPUT_CONTRACT_RULES) expect(text).toContain(rule);
    expect(Object.isFrozen(OUTPUT_CONTRACT_RULES)).toBe(true);
  });

  it('names all nine types with the extensions each may use, and forbids svg', () => {
    const text = renderCodeContract(context);
    for (const type of ARTIFACT_TYPES) expect(text).toContain(`${type} (${ARTIFACT_TYPE_POLICY[type].extensions.join(', ')})`);
    expect(text).toContain('Never write .svg files.');
    expect(text).not.toMatch(/image \([^)]*\.svg/);
  });

  it('requires inlined Plotly, and mentions cdn only in the sentence that forbids it', () => {
    const text = renderCodeContract(context);
    expect(text).toContain('include_plotlyjs=True');
    const mentioning = sentences(text).filter((sentence) => /cdn/i.test(sentence));
    expect(mentioning).toHaveLength(1);
    expect(mentioning[0]).toMatch(/never 'cdn'/);
  });

  it('asks for self-contained reports, data alongside charts, and a size limit in human units', () => {
    const text = renderCodeContract(context);
    expect(text).toMatch(/embed its images as data: URIs/);
    expect(text).toMatch(/also write the numbers behind it as a csv/);
    expect(text).toContain('under 512 MB');
    expect(text).toMatch(/shell scripts are not executed/);
    expect(text).toMatch(/cannot reach the network when it is shown/);
  });

  it('keeps the gate, the contract, and the renderers on one list: policy keys = contract_outputs types = memory\'s nine', () => {
    const policy = Object.keys(ARTIFACT_TYPE_POLICY).sort();
    const gate = [...ARTIFACT_TYPES].sort();
    expect(policy).toEqual(gate);
    expect(gate).toEqual([...MEMORY_NINE].sort());
  });

  it('stays free of absolute paths and deterministic', () => {
    const text = renderCodeContract(context);
    expect(text).toBe(renderCodeContract({ ...context }));
    expect(text).not.toMatch(/[A-Za-z]:\\|(?:^|\s)\/(?:home|Users|tmp|var|etc)\//);
  });
});
