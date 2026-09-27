import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_TYPES, ARTIFACT_TYPE_POLICY, RENDER_MODES } from '@automate/core';
import { checkOutputs } from '../../verification/checks/contract-checks';
import type { CodeVersionWithFiles } from '../../db/repositories/code-version-repository';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'artifacts');
const declaring = (entries: readonly { filename: string; type: string }[]) => ({ declaredOutputs: JSON.stringify(entries.map((entry) => ({ ...entry, title: entry.filename, description: '' }))) }) as unknown as CodeVersionWithFiles;

describe('the gate and the renderers agree (FEAT-109 TASK-011)', () => {
  it('FEAT-107\'s contract_outputs accepts every type the policy can show, and each has a renderer', () => {
    const entries = Object.keys(ARTIFACT_TYPE_POLICY).map((type) => ({ filename: `out-${type}${ARTIFACT_TYPE_POLICY[type as keyof typeof ARTIFACT_TYPE_POLICY].extensions[0]}`, type }));
    expect(checkOutputs(declaring(entries)).status).toBe('passed');
    for (const type of ARTIFACT_TYPES) expect(RENDER_MODES).toContain(ARTIFACT_TYPE_POLICY[type].renderMode);
  });

  it.each(['svg', 'plotly-json', 'exe'])('still blocks a run declaring the type %j', (type) => {
    const outcome = checkOutputs(declaring([{ filename: 'x.out', type }]));
    expect(outcome.status).toBe('failed');
    expect(outcome.findings.map(({ ruleCode }) => ruleCode)).toContain('invalid_output_type');
  });
});

describe('the self-contained rule, checked against real Plotly 7.1.0 output', () => {
  // Both fixtures were written by plotly 7.1.0's write_html; the inlined one has its bundled plotly.js body trimmed.
  const cdn = readFileSync(path.join(FIXTURES, 'plotly-cdn.html'), 'utf8');
  const inline = readFileSync(path.join(FIXTURES, 'plotly-inline.html'), 'utf8');

  it("include_plotlyjs='cdn' references a remote script, which the preview CSP blocks: an empty chart", () => {
    expect(cdn).toMatch(/src="https:\/\//);
  });

  it('include_plotlyjs=True references nothing remote, so it renders inside the sealed frame', () => {
    expect(inline).not.toMatch(/src="https?:\/\//);
    expect(inline).toContain('plotly.js v');
    expect(inline).toContain('Plotly.newPlot');
  });
});
