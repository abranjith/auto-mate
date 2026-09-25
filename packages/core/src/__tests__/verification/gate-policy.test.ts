import { describe, expect, it } from 'vitest';
import { BLOCKING_CHECK_KEYS, decideGate, isBlockingCheck, isBlockingFinding, type PolicyCheck, type PolicyFinding } from '../../verification/gate-policy';
import { CHECK_KEYS, FINDING_CONFIDENCES, FINDING_SEVERITIES, type CheckKey } from '../../verification/verification';
import { seededRandom } from '../../ingestion/seeded-random';

const allPassed = (): PolicyCheck[] => CHECK_KEYS.map((checkKey) => ({ checkKey, status: 'passed' }));
const withCheck = (key: CheckKey, status: PolicyCheck['status']) => allPassed().map((check) => (check.checkKey === key ? { ...check, status } : check));
const finding = (overrides: Partial<PolicyFinding>): PolicyFinding & { isBlocking: boolean } => {
  const base: PolicyFinding = { checkKey: 'lint', ruleCode: 'F401', severity: 'low', confidence: null, ...overrides };
  return { ...base, isBlocking: isBlockingFinding(base) };
};

describe('isBlockingFinding', () => {
  const cells = FINDING_SEVERITIES.flatMap((severity) => FINDING_CONFIDENCES.map((confidence) => [severity, confidence] as const));
  it.each(cells)('bandit %s severity / %s confidence blocks only at high/high', (severity, confidence) => {
    expect(isBlockingFinding({ checkKey: 'security', ruleCode: 'B602', severity, confidence })).toBe(severity === 'high' && confidence === 'high');
  });
  it('treats a bandit finding with no confidence as advisory', () => {
    expect(isBlockingFinding({ checkKey: 'security', ruleCode: 'B101', severity: 'high', confidence: null })).toBe(false);
  });
  it.each([
    ['E902', true], ['E999', true], ['F601', true], ['F632', true], ['F701', true], ['F706', true], ['F821', true], ['F822', true], ['F823', true], ['invalid-syntax', true],
    ['F401', false], ['F841', false], ['F811', false], ['E501', false], ['B006', false], ['S101', false], ['F541', false],
  ] as const)('ruff %s blocking = %s', (ruleCode, expected) => {
    expect(isBlockingFinding({ checkKey: 'lint', ruleCode, severity: 'medium', confidence: null })).toBe(expected);
  });
  it('blocks every application-owned finding except an input type mismatch', () => {
    expect(isBlockingFinding({ checkKey: 'integrity', ruleCode: 'digest_mismatch', severity: 'high', confidence: null })).toBe(true);
    expect(isBlockingFinding({ checkKey: 'contract_outputs', ruleCode: 'duplicate_output', severity: 'high', confidence: null })).toBe(true);
    expect(isBlockingFinding({ checkKey: 'contract_inputs', ruleCode: 'missing_column', severity: 'high', confidence: null })).toBe(true);
    expect(isBlockingFinding({ checkKey: 'contract_inputs', ruleCode: 'type_mismatch', severity: 'low', confidence: null })).toBe(false);
  });
  it('lists every check as blocking-capable', () => {
    expect(CHECK_KEYS.every(isBlockingCheck)).toBe(true);
    expect([...BLOCKING_CHECK_KEYS].sort()).toEqual([...CHECK_KEYS].sort());
  });
});

describe('decideGate', () => {
  it('allows a clean pass', () => {
    expect(decideGate(allPassed(), [])).toEqual({ allowed: true, blockingCount: 0, advisoryCount: 0, reasons: [] });
  });
  it('allows a pass with only advisory findings', () => {
    const decision = decideGate(allPassed(), [finding({ ruleCode: 'F401' }), finding({ checkKey: 'security', ruleCode: 'B101', severity: 'low', confidence: 'high' })]);
    expect(decision).toMatchObject({ allowed: true, blockingCount: 0, advisoryCount: 2 });
  });
  it('blocks on one HIGH/HIGH bandit finding', () => {
    const decision = decideGate(withCheck('security', 'failed'), [finding({ checkKey: 'security', ruleCode: 'B602', severity: 'high', confidence: 'high' })]);
    expect(decision).toMatchObject({ allowed: false, blockingCount: 1, reasons: ['security'] });
  });
  it('blocks on F821 and allows F401', () => {
    expect(decideGate(withCheck('lint', 'failed'), [finding({ ruleCode: 'F821' })]).allowed).toBe(false);
    expect(decideGate(allPassed(), [finding({ ruleCode: 'F401' })]).allowed).toBe(true);
  });
  it('does not block a failed lint check that carries only advisory findings', () => {
    expect(decideGate(withCheck('lint', 'failed'), [finding({ ruleCode: 'F401' })]).allowed).toBe(true);
  });
  it('blocks on a failed tests check', () => {
    expect(decideGate(withCheck('tests', 'failed'), []).reasons).toEqual(['tests']);
  });
  it('allows a skipped check', () => {
    expect(decideGate(withCheck('contract_inputs', 'skipped'), []).allowed).toBe(true);
  });
  it('blocks on an errored blocking check: a check that could not run has not passed', () => {
    expect(decideGate(withCheck('lint', 'errored'), [])).toMatchObject({ allowed: false, reasons: ['lint'] });
  });
  it('blocks when a check key is missing entirely', () => {
    expect(decideGate(allPassed().filter(({ checkKey }) => checkKey !== 'tests'), []).reasons).toEqual(['tests']);
  });
  it('reports counts equal to the findings partitioned by isBlocking, over generated finding lists', () => {
    const random = seededRandom('gate-policy');
    const rules = ['F821', 'F401', 'E902', 'B602', 'B101', 'missing_column', 'type_mismatch'];
    for (let round = 0; round < 200; round += 1) {
      const findings = Array.from({ length: Math.floor(random() * 30) }, () => finding({
        checkKey: CHECK_KEYS[Math.floor(random() * CHECK_KEYS.length)]!,
        ruleCode: rules[Math.floor(random() * rules.length)]!,
        severity: FINDING_SEVERITIES[Math.floor(random() * FINDING_SEVERITIES.length)]!,
        confidence: random() < 0.2 ? null : FINDING_CONFIDENCES[Math.floor(random() * FINDING_CONFIDENCES.length)]!,
      }));
      const decision = decideGate(allPassed(), findings);
      expect(decision.blockingCount).toBe(findings.filter(({ isBlocking }) => isBlocking).length);
      expect(decision.advisoryCount).toBe(findings.filter(({ isBlocking }) => !isBlocking).length);
      expect(decision.blockingCount + decision.advisoryCount).toBe(findings.length);
    }
  });
});
