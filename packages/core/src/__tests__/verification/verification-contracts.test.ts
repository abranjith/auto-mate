import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { computeRuntimeFingerprint, describeRuntime, describeRuntimeChange, type RuntimeDetail } from '../../verification/runtime-fingerprint';
import { evaluateApproval, type ApprovalView } from '../../verification/approval';
import { isPlainFilename, parseOutputManifest, reconcileOutputs } from '../../verification/manifest';
import { summarizeVerification, type VerificationCheckView, type VerificationFindingView } from '../../verification/verification';
import { feedbackProblem } from '../../verification/review';
import { buildIntentDigest, RUN_INTENT_CAVEATS, type RunIntent } from '../../verification/run-intent';
import { AutoMateError } from '../../errors/automate-error';
import { ERROR_CODES } from '../../errors/error-codes';
import * as errors from '../../errors/verification-errors';
import { ApprovalRequestSchema, ApprovalResponseSchema, ReviewRequestSchema, ReviewResponseSchema, RunIntentResponseSchema, ScriptRunSchema, VerificationReportSchema } from '../../contracts/verification-api';
import { seededRandom } from '../../ingestion/seeded-random';
import * as barrel from '../../index';

const DETAIL: RuntimeDetail = { pythonVersion: '3.12.4', uvVersion: 'uv 0.8.0', platform: 'linux', arch: 'x64', packages: [{ name: 'pandas', version: '2.3.1' }, { name: 'numpy', version: '2.1.0' }] };
const D = 'a'.repeat(64);

describe('runtime fingerprint', () => {
  it('is stable, order-independent, and moves with one patch version', () => {
    const first = computeRuntimeFingerprint(DETAIL);
    expect(computeRuntimeFingerprint(DETAIL)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRuntimeFingerprint({ ...DETAIL, packages: [...DETAIL.packages].reverse() })).toBe(first);
    expect(computeRuntimeFingerprint({ ...DETAIL, packages: [{ name: 'pandas', version: '2.3.2' }, { name: 'numpy', version: '2.1.0' }] })).not.toBe(first);
    expect(computeRuntimeFingerprint({ ...DETAIL, pythonVersion: '3.12.5' })).not.toBe(first);
  });
  it('names each concrete change and nothing for an identical runtime', () => {
    expect(describeRuntimeChange(DETAIL, DETAIL)).toEqual([]);
    const after: RuntimeDetail = { ...DETAIL, pythonVersion: '3.13.1', uvVersion: 'uv 0.9.0', packages: [{ name: 'pandas', version: '2.4.0' }, { name: 'plotly', version: '6.0.0' }] };
    expect(describeRuntimeChange(DETAIL, after)).toEqual(['Python changed from 3.12.4 to 3.13.1', 'uv changed from uv 0.8.0 to uv 0.9.0', 'pandas changed from 2.3.1 to 2.4.0', 'plotly 6.0.0 was added', 'numpy 2.1.0 was removed']);
    expect(describeRuntime(DETAIL)).toBe('Python 3.12.4 on Linux (x64)');
  });
});

describe('evaluateApproval', () => {
  const approval: ApprovalView = { contentDigest: 'c', runtimeFingerprint: 'r', intentDigest: 'i', decision: 'approved' };
  const required = { contentDigest: 'c', runtimeFingerprint: 'r', intentDigest: 'i' };
  it.each([
    [approval, required, 'none'],
    [null, required, 'digest'],
    [approval, { ...required, contentDigest: 'x' }, 'digest'],
    [approval, { ...required, runtimeFingerprint: 'x' }, 'runtime'],
    [approval, { ...required, intentDigest: 'x' }, 'intent'],
    [{ ...approval, decision: 'cancelled' as const }, required, 'cancelled'],
    [{ ...approval, decision: 'cancelled' as const }, { contentDigest: 'x', runtimeFingerprint: 'x', intentDigest: 'x' }, 'cancelled'],
  ] as const)('case %#', (given, need, expected) => {
    expect(evaluateApproval(given, need)).toBe(expected);
  });
});

describe('output manifest', () => {
  const valid = { artifacts: [{ filename: 'a.csv', type: 'csv', title: 'A', description: 'x' }, { filename: 'r.html', type: 'plotly-html', title: 'R', description: '' }] };
  it('parses a valid manifest', () => {
    expect(parseOutputManifest(JSON.stringify(valid))?.artifacts).toHaveLength(2);
    expect(parseOutputManifest('{"artifacts":[]}')).toEqual({ artifacts: [] });
  });
  it.each([
    ['invalid JSON', '{nope'],
    ['a missing array', '{"files":[]}'],
    ['a non-array', '{"artifacts":{}}'],
    ['an entry without a filename', '{"artifacts":[{"type":"csv","title":"A"}]}'],
    ['a type outside the artifact list', '{"artifacts":[{"filename":"a.exe","type":"exe","title":"A"}]}'],
    ['a traversal filename', '{"artifacts":[{"filename":"../a.csv","type":"csv","title":"A"}]}'],
    ['a root value', '"text"'],
    ['null', 'null'],
  ])('returns null for %s', (_name, text) => {
    expect(parseOutputManifest(text)).toBeNull();
  });
  it('never throws over a fuzz corpus', () => {
    const random = seededRandom('manifest-fuzz');
    const alphabet = '{}[]":,.a /\\\u0000\u00ff01nulltruefalseartifactsfilenametype';
    for (let round = 0; round < 2_000; round += 1) {
      const text = Array.from({ length: Math.floor(random() * 80) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      expect(() => parseOutputManifest(text)).not.toThrow();
    }
  });
  it('validates plain filenames', () => {
    expect(isPlainFilename('totals.csv')).toBe(true);
    for (const bad of ['', '..', '../x.csv', '/tmp/x.csv', 'C:\\x.csv', 'a/b.csv', 'a\u0000.csv', 'x'.repeat(256)]) expect(isPlainFilename(bad)).toBe(false);
  });
  it('reconciles declared against produced, excluding the manifest', () => {
    expect(reconcileOutputs(['a.csv', 'b.csv'], ['a.csv', 'manifest.json', 'c.txt'])).toEqual({ declaredCount: 2, producedCount: 2, missing: ['b.csv'], undeclared: ['c.txt'] });
  });
});

describe('summarizeVerification', () => {
  const check = (checkKey: VerificationCheckView['checkKey'], status: VerificationCheckView['status'], detail: unknown = null): VerificationCheckView => ({ checkKey, status, isBlocking: true, summary: '', detail, durationMs: 1 });
  const blocking = (checkKey: VerificationFindingView['checkKey'], ruleCode: string): VerificationFindingView => ({ checkKey, ruleCode, severity: 'high', confidence: 'high', filePath: '/tmp/x/main.py', line: 1, column: 1, message: 'bad', isBlocking: true });
  it('names counts in plain English and no rule codes or paths', () => {
    const text = summarizeVerification({ status: 'failed', blockingCount: 3, advisoryCount: 0 }, [check('security', 'failed'), check('tests', 'failed', { failed: 1 })], [blocking('security', 'B602'), blocking('security', 'B605'), blocking('tests', 'tests_failed')]);
    expect(text).toBe("This code can't run yet: 2 high-severity security findings and 1 failing test.");
    expect(text).not.toMatch(/B60\d|\/tmp|[A-Z]\d{3}/);
  });
  it.each([
    [{ status: 'passed', blockingCount: 0, advisoryCount: 0 }, 'All checks passed.'],
    [{ status: 'passed', blockingCount: 0, advisoryCount: 2 }, 'No blocking problems found; 2 advisory findings to review.'],
    [{ status: 'errored', blockingCount: 0, advisoryCount: 0 }, 'The code could not be fully checked, so it cannot run yet.'],
    [{ status: 'timed_out', blockingCount: 0, advisoryCount: 0 }, 'Checking took too long and was stopped, so this code cannot run yet.'],
    [{ status: 'aborted', blockingCount: 0, advisoryCount: 0 }, 'Checking was stopped before it finished.'],
  ] as const)('%j', (run, expected) => {
    expect(summarizeVerification(run, [], [])).toBe(expected);
  });
  it('says a blocking check could not run', () => {
    expect(summarizeVerification({ status: 'failed', blockingCount: 0, advisoryCount: 0 }, [check('lint', 'errored')], [])).toBe("This code can't run yet: the lint check could not run.");
  });
});

describe('review feedback rule', () => {
  it('requires non-blank feedback within the cap', () => {
    expect(feedbackProblem(undefined)).toMatch(/Say what was wrong/);
    expect(feedbackProblem(' \n\t ')).toMatch(/Say what was wrong/);
    expect(feedbackProblem('x'.repeat(2_000))).toBeNull();
    expect(feedbackProblem('x'.repeat(2_001))).toMatch(/2,000 characters; this is 2,001/);
  });
});

describe('run intent digest', () => {
  const intent: RunIntent = { executionId: 1, codeVersion: { id: 1, shortDigest: 'aaaaaaaaaaaa', contentDigest: D, fileCount: 2, lineCount: 20, entrypoint: 'main.py' }, verificationRunId: 1, summary: 's', inputs: [], outputs: [], checks: [], verdict: 'All checks passed.', blockingCount: 0, advisoryCount: 0, tests: { total: 3, passed: 3, fixtureRowCount: 200 }, runtime: { fingerprint: D, description: 'Python', packages: [] }, caveats: [...RUN_INTENT_CAVEATS] };
  it('is stable and moves with any field', () => {
    expect(buildIntentDigest(intent)).toBe(buildIntentDigest(structuredClone(intent)));
    expect(buildIntentDigest({ ...intent, advisoryCount: 1 })).not.toBe(buildIntentDigest(intent));
  });
  it('states the no-isolation caveat and never calls the copy a boundary', () => {
    expect(RUN_INTENT_CAVEATS.join(' ')).toMatch(/without an isolation boundary/);
    expect(RUN_INTENT_CAVEATS.join(' ')).toMatch(/not a security boundary/);
  });
});

describe('verification errors', () => {
  const cases: readonly [AutoMateError, string][] = [
    [new errors.VerificationNotFoundError(1), ERROR_CODES.VERIFICATION_NOT_FOUND],
    [new errors.VerificationStaleError(['Python changed from 3.12.4 to 3.13.1']), ERROR_CODES.VERIFICATION_STALE],
    [new errors.VerificationBlockedError('blocked'), ERROR_CODES.VERIFICATION_BLOCKED],
    [new errors.ExecutionNotApprovedError(1), ERROR_CODES.EXECUTION_NOT_APPROVED],
    [new errors.ApprovalIntentMismatchError(), ERROR_CODES.APPROVAL_INTENT_MISMATCH],
    [new errors.ApprovalStaleError('runtime'), ERROR_CODES.APPROVAL_STALE],
    [new errors.RunNotFoundError(1), ERROR_CODES.RUN_NOT_FOUND],
    [new errors.RunOutputMissingError('missing'), ERROR_CODES.RUN_OUTPUT_MISSING],
    [new errors.CheckerUnavailableError('uv', 'winget install astral-sh.uv'), ERROR_CODES.CHECKER_UNAVAILABLE],
    [new errors.ReviewNotPendingError(1, 'executing'), ERROR_CODES.REVIEW_NOT_PENDING],
    [new errors.InputCopyMismatchError(1), ERROR_CODES.INPUT_COPY_MISMATCH],
  ];
  it.each(cases.map(([error, code]) => [error.name, error, code] as const))('%s keeps its code and a stack-free envelope', (_name, error, code) => {
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error.code).toBe(code);
    expect(error.toJSON()).toEqual({ error: { code, message: error.message } });
    expect(JSON.stringify(error.toJSON())).not.toMatch(/stack|at .+:\d+:\d+/);
  });
  it('names the concrete change', () => {
    expect(new errors.VerificationStaleError(['Python changed from 3.12.4 to 3.13.1']).message).toContain('Python changed from 3.12.4 to 3.13.1');
    expect(new errors.ReviewNotPendingError(4, 'awaiting_approval').message).toContain('awaiting approval');
  });
});

describe('verification wire contracts', () => {
  it('round-trips representative values unchanged', () => {
    const runtime = { pythonVersion: '3.12.4', uvVersion: 'uv', platform: 'linux', arch: 'x64', packages: [{ name: 'pandas', version: '2' }] };
    const cases: readonly [object, unknown][] = [
      [VerificationReportSchema, { id: 1, executionId: 1, codeVersionId: 1, contentDigest: D, runtimeFingerprint: D, runtime, runtimeDescription: 'Python', status: 'passed', blockingCount: 0, advisoryCount: 1, summary: 's', durationMs: 5, startedAt: 'x', settledAt: null, checks: [{ checkKey: 'lint', status: 'passed', isBlocking: true, summary: 's', detail: { tool: 'ruff' }, durationMs: 1 }], findings: [{ id: 1, checkKey: 'lint', ruleCode: 'F401', severity: 'low', confidence: null, filePath: 'main.py', line: 1, column: 1, message: 'm', isBlocking: false }] }],
      [RunIntentResponseSchema, { intentDigest: D, intent: { executionId: 1, codeVersion: { id: 1, shortDigest: 'a', contentDigest: D, fileCount: 1, lineCount: 1, entrypoint: 'main.py' }, verificationRunId: 1, summary: null, inputs: [{ uploadId: 1, originalFilename: 'a.csv', byteSize: 1, shortSha256: 'a', sheets: [] }], outputs: [{ filename: 'a.csv', type: 'csv', title: 't', description: '' }], checks: [], verdict: 'v', blockingCount: 0, advisoryCount: 0, tests: { total: null, passed: null, fixtureRowCount: null }, runtime: { fingerprint: D, description: 'd', packages: [] }, caveats: ['c'] } }],
      [ApprovalRequestSchema, { intentDigest: D, decision: 'approved', acknowledgedWarnings: false }],
      [ApprovalResponseSchema, { outcome: 'reverify', approvalId: null, runtimeChanges: ['Python changed'], status: 'verifying' }],
      [ScriptRunSchema, { id: 1, executionId: 1, codeVersionId: 1, approvalId: 1, contentDigest: D, runtimeFingerprint: D, status: 'succeeded', exitCode: 0, stdout: 'x', stderr: '', outputTruncated: false, manifestPresent: true, declaredOutputs: [{ filename: 'a.csv', type: 'csv', title: 't', description: '', byteSize: 3, present: true }], declaredOutputCount: 1, producedOutputCount: 1, outputByteCount: 3, limitBreached: null, runtimeLockDigest: D, inputs: [{ uploadId: 1, byteSize: 1, shortSha256: 'a' }], durationMs: 1, startedAt: 'x', settledAt: 'y' }],
      [ReviewRequestSchema, { verdict: 'rejected', feedback: 'wrong totals' }],
      [ReviewResponseSchema, { status: 'rejected', retryExecutionId: 2 }],
    ];
    for (const [schema, value] of cases) {
      expect(Value.Check(schema as never, value)).toBe(true);
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
  it('rejects over-long review feedback and unknown approval fields', () => {
    expect(Value.Check(ReviewRequestSchema, { verdict: 'rejected', feedback: 'x'.repeat(2_001) })).toBe(false);
    expect(Value.Check(ApprovalRequestSchema, { intentDigest: D, decision: 'approved', acknowledgedWarnings: true, force: true })).toBe(false);
  });
  it('exports the surface from the package barrel', () => {
    expect(typeof barrel.decideGate).toBe('function');
    expect(barrel.CHECK_KEYS).toHaveLength(7);
  });
});
