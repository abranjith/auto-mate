// The recorded corpora in `fixtures/verification/` are REAL ruff 0.16.8 and
// bandit 1.9.4 output (Windows, mixed separators), with the scratch root
// replaced by `<ROOT>`. The last suite reruns the hostile-config proof against
// the real tools when AUTOMATE_TEST_VERIFY_ENV names a prepared verify-env.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CheckerResult, CheckerTool } from '../../../verification/verify-env';
import { VerifyEnvironment } from '../../../verification/verify-env';
import { runLintCheck, ruffArgs } from '../../../verification/checks/lint-check';
import { banditArgs, runSecurityCheck } from '../../../verification/checks/security-check';
import { versionRelative } from '../../../verification/checks/check-result';

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'verification');
let versionDir: string;
beforeEach(() => { versionDir = mkdtempSync(path.join(tmpdir(), 'automate-static-')); });
afterEach(() => rmSync(versionDir, { recursive: true, force: true }));

/** A recorded corpus with its root pointed at this test's directory, keeping the tools' Windows-style separators. */
const corpus = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8').split('<ROOT>').join(versionDir.replace(/\\/g, '/').replace(/"/g, ''));
const result = (overrides: Partial<CheckerResult>): CheckerResult => ({ exitCode: 1, stdout: '', stderr: '', droppedBytes: 0, timedOut: false, aborted: false, spawnError: null, durationMs: 42, ...overrides });
function runner(response: Partial<CheckerResult> | ((tool: CheckerTool, args: readonly string[]) => Partial<CheckerResult>)) {
  const calls: { tool: CheckerTool; args: readonly string[] }[] = [];
  const run = (tool: CheckerTool, args: readonly string[]) => { calls.push({ tool, args }); return Promise.resolve(result(typeof response === 'function' ? response(tool, args) : response)); };
  return { run, calls };
}
const signal = () => new AbortController().signal;
const CONFIG = { configPath: path.join(tmpdir(), 'verify-env', 'bandit.yaml'), iniPath: path.join(tmpdir(), 'verify-env', 'bandit.ini') };

describe('lint check', () => {
  it('yields passed with zero findings for a clean file', async () => {
    const outcome = await runLintCheck(runner({ exitCode: 0, stdout: corpus('ruff-clean.json') }).run, versionDir, signal());
    expect(outcome).toMatchObject({ status: 'passed', findings: [], summary: 'Lint clean', durationMs: 42 });
  });
  it('marks F821 blocking and F401/S-rules advisory, with version-relative paths', async () => {
    const outcome = await runLintCheck(runner({ stdout: corpus('ruff-findings.json') }).run, versionDir, signal());
    expect(outcome.status).toBe('failed');
    const byCode = Object.fromEntries(outcome.findings.map((finding) => [finding.ruleCode, finding]));
    expect(byCode.F821).toMatchObject({ isBlocking: true, severity: 'high', filePath: 'main.py', line: 6, column: 11, confidence: null });
    expect(byCode.F401).toMatchObject({ isBlocking: false, filePath: 'clean.py' });
    expect(byCode.S101).toMatchObject({ isBlocking: false, filePath: 'test_main.py' });
    expect(outcome.summary).toBe('1 code error and 3 advisory findings');
    expect(outcome.findings[0]?.ruleCode).toBe('F821');
  });
  it('blocks on invalid-syntax, the code current ruff uses for a syntax error', async () => {
    const stdout = JSON.stringify([{ code: 'invalid-syntax', filename: `${versionDir}\\main.py`, message: 'Expected `)`', location: { row: 1, column: 12 } }]);
    const outcome = await runLintCheck(runner({ exitCode: 1, stdout }).run, versionDir, signal());
    expect(outcome.findings[0]).toMatchObject({ ruleCode: 'invalid-syntax', isBlocking: true });
  });
  it.each([
    ['unparseable stdout', { exitCode: 2, stdout: 'ruff failed: error: unexpected argument' }, /report could not be read/],
    ['a timeout', { timedOut: true, exitCode: null }, /took longer than 1 minute/],
    ['a spawn ENOENT', { spawnError: Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }), exitCode: null }, /could not be started/],
    ['an abort', { aborted: true, exitCode: null }, /aborted/],
  ])('yields errored for %s, naming the tool and no stack', async (_name, response, message) => {
    const outcome = await runLintCheck(runner(response).run, versionDir, signal());
    expect(outcome.status).toBe('errored');
    expect(outcome.summary).toMatch(message);
    expect(outcome.summary).toContain('ruff');
    expect(outcome.summary).not.toMatch(/at .+:\d+:\d+|ENOENT/);
  });
  it('stores 200 findings and names the overflow, keeping blocking ones first', async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ code: index === 200 ? 'F821' : 'F401', filename: `${versionDir}/main.py`, message: 'm', location: { row: index + 1, column: 1 } }));
    const outcome = await runLintCheck(runner({ stdout: JSON.stringify(items) }).run, versionDir, signal());
    expect(outcome.findings).toHaveLength(200);
    expect(outcome.findings[0]?.ruleCode).toBe('F821');
    expect(outcome.summary).toMatch(/1 more not shown/);
    expect(outcome.detail).toMatchObject({ total: 201, overflow: 1 });
  });
});

describe('security check', () => {
  it('yields passed with zero findings for a clean tree', async () => {
    const outcome = await runSecurityCheck(runner({ exitCode: 0, stdout: corpus('bandit-clean.json') }).run, versionDir, CONFIG, signal());
    expect(outcome).toMatchObject({ status: 'passed', findings: [], summary: 'No security findings' });
  });
  it('blocks on HIGH/HIGH and lowercases severities and confidences', async () => {
    const outcome = await runSecurityCheck(runner({ stdout: corpus('bandit-findings.json') }).run, versionDir, CONFIG, signal());
    expect(outcome.status).toBe('failed');
    const byCode = Object.fromEntries(outcome.findings.map((finding) => [finding.ruleCode, finding]));
    expect(byCode.B602).toMatchObject({ isBlocking: true, severity: 'high', confidence: 'high', filePath: 'main.py', line: 7 });
    expect(byCode.B404).toMatchObject({ isBlocking: false, severity: 'low', confidence: 'high' });
    expect(outcome.summary).toBe('1 high-severity security finding and 2 advisory findings');
  });
  it('does not block MEDIUM/HIGH', async () => {
    const stdout = JSON.stringify({ errors: [], results: [{ test_id: 'B608', issue_severity: 'MEDIUM', issue_confidence: 'HIGH', filename: `${versionDir}/main.py`, line_number: 3, col_offset: 4, issue_text: 'Possible SQL injection.' }] });
    const outcome = await runSecurityCheck(runner({ stdout }).run, versionDir, CONFIG, signal());
    expect(outcome).toMatchObject({ status: 'passed' });
    expect(outcome.findings[0]).toMatchObject({ severity: 'medium', confidence: 'high', isBlocking: false });
  });
  it('treats a file bandit could not parse as a blocking finding', async () => {
    const stdout = JSON.stringify({ errors: [{ filename: `${versionDir}\\main.py`, reason: 'syntax error while parsing AST from file' }], results: [] });
    const outcome = await runSecurityCheck(runner({ exitCode: 0, stdout }).run, versionDir, CONFIG, signal());
    expect(outcome.status).toBe('failed');
    expect(outcome.findings[0]).toMatchObject({ ruleCode: 'scan_error', isBlocking: true, filePath: 'main.py' });
  });
  it('yields errored when bandit output cannot be read', async () => {
    const outcome = await runSecurityCheck(runner({ exitCode: 2, stdout: '[main] ERROR bad config' }).run, versionDir, CONFIG, signal());
    expect(outcome).toMatchObject({ status: 'errored' });
    expect(outcome.summary).toContain('bandit');
  });
});

describe('path hygiene', () => {
  it('never lets the temp root into any serialized finding', async () => {
    const lint = await runLintCheck(runner({ stdout: corpus('ruff-findings.json') }).run, versionDir, signal());
    const security = await runSecurityCheck(runner({ stdout: corpus('bandit-findings.json') }).run, versionDir, CONFIG, signal());
    const serialized = JSON.stringify([lint, security]);
    for (const needle of [versionDir, versionDir.replace(/\\/g, '/'), versionDir.replace(/\\/g, '\\\\'), tmpdir()]) expect(serialized).not.toContain(needle);
  });
  it('reduces paths outside the version to a basename and rejects traversal', () => {
    expect(versionRelative(versionDir, path.join(versionDir, 'lib', 'helpers.py'))).toBe('lib/helpers.py');
    expect(versionRelative(versionDir, '/etc/passwd')).toBe('passwd');
    expect(versionRelative(versionDir, '')).toBeNull();
    expect(versionRelative(versionDir, 42)).toBeNull();
  });
});

describe('the hostile-config proof', () => {
  const HOSTILE = '[tool.ruff]\nignore = ["E9", "F"]\n[tool.ruff.lint]\nignore = ["E9", "F", "S"]\n\n[tool.bandit]\nskips = ["B602"]\n';
  it('passes --isolated to ruff and the app config to bandit on every invocation, never a path inside the checked tree', () => {
    writeFileSync(path.join(versionDir, 'pyproject.toml'), HOSTILE);
    const ruff = ruffArgs(versionDir);
    const bandit = banditArgs(versionDir, CONFIG);
    expect(ruff).toContain('--isolated');
    expect(ruff).not.toContain('--config');
    expect(bandit.slice(bandit.indexOf('-c'), bandit.indexOf('-c') + 2)).toEqual(['-c', CONFIG.configPath]);
    expect(bandit.slice(bandit.indexOf('--ini'), bandit.indexOf('--ini') + 2)).toEqual(['--ini', CONFIG.iniPath]);
    for (const file of Object.values(CONFIG)) expect(path.relative(versionDir, file).startsWith('..')).toBe(true);
  });
  it('produces identical findings with the hostile file present', async () => {
    const tools = runner((tool) => ({ stdout: corpus(tool === 'ruff' ? 'ruff-findings.json' : 'bandit-findings.json') }));
    const without = [await runLintCheck(tools.run, versionDir, signal()), await runSecurityCheck(tools.run, versionDir, CONFIG, signal())];
    writeFileSync(path.join(versionDir, 'pyproject.toml'), HOSTILE);
    const withHostile = [await runLintCheck(tools.run, versionDir, signal()), await runSecurityCheck(tools.run, versionDir, CONFIG, signal())];
    expect(withHostile).toEqual(without);
  });

  const realEnv = process.env.AUTOMATE_TEST_VERIFY_ENV;
  it.runIf(Boolean(realEnv))('holds against the real ruff and bandit', async () => {
    const env = new VerifyEnvironment({ verifyEnvDir: realEnv! });
    const run = env.runTool.bind(env);
    writeFileSync(path.join(versionDir, 'main.py'), 'import os\nimport subprocess\n\ndef main():\n    print(undefined_name)\n    subprocess.call("ls " + os.environ["X"], shell=True)\n');
    const check = async () => [await runLintCheck(run, versionDir, signal()), await runSecurityCheck(run, versionDir, { configPath: path.join(realEnv!, 'bandit.yaml'), iniPath: path.join(realEnv!, 'bandit.ini') }, signal())].map((outcome) => outcome.findings.map(({ ruleCode, isBlocking }) => `${ruleCode}:${isBlocking}`).sort());
    const without = await check();
    writeFileSync(path.join(versionDir, 'pyproject.toml'), HOSTILE);
    writeFileSync(path.join(versionDir, 'ruff.toml'), 'lint.ignore = ["F", "S"]\n');
    writeFileSync(path.join(versionDir, '.bandit'), '[bandit]\nskips = B602,B404\n');
    expect(await check()).toEqual(without);
    expect(without[0]).toContain('F821:true');
    expect(without[1]).toContain('B602:true');
  }, 60_000);
});
