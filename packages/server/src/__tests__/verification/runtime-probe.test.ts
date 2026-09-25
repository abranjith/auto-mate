import { describe, expect, it } from 'vitest';
import { computeRuntimeFingerprint } from '@automate/core';
import { FakePythonRunner } from '../../execution/testing/fake-python-runner';
import { PROBE_SCRIPT, UvRuntimeProbe, parseProbe } from '../../verification/runtime-probe';

const OUTPUT = JSON.stringify({ python: '3.12.4', packages: [['pytest', '8.4.2'], ['Pandas', '2.3.1']] });
const probeWith = (stdout = OUTPUT, exitCode = 0) => {
  const runner = new FakePythonRunner([{ result: { stdout, exitCode } }, { result: { stdout, exitCode } }], { runtime: { uvVersion: 'uv 0.11.32', pythonVersion: '3.13.1' } });
  const checkers = { calls: 0 };
  const probe = new UvRuntimeProbe({ runner, workingDir: '/data/verify-env', platform: 'linux', arch: 'x64', checkerVersions: () => { checkers.calls += 1; return Promise.resolve({ ruff: '0.16.8', bandit: '1.9.4' }); } });
  return { probe, runner, checkers };
};
const signal = () => new AbortController().signal;

describe('UvRuntimeProbe', () => {
  it('reads Python and packages from inside the script environment, plus uv, platform, and checkers', async () => {
    const { probe, runner } = probeWith();
    const { detail, fingerprint } = await probe.probe(signal());
    expect(detail).toEqual({ pythonVersion: '3.12.4', uvVersion: 'uv 0.11.32', platform: 'linux', arch: 'x64', packages: [{ name: 'checker:bandit', version: '1.9.4' }, { name: 'checker:ruff', version: '0.16.8' }, { name: 'pandas', version: '2.3.1' }, { name: 'pytest', version: '8.4.2' }] });
    expect(fingerprint).toBe(computeRuntimeFingerprint(detail));
    expect(runner.requests[0]).toMatchObject({ args: ['-c', PROBE_SCRIPT], workingDir: '/data/verify-env', env: {} });
    expect(runner.ensureCount).toBe(1);
  });
  it('memoizes until asked for a fresh probe', async () => {
    const { probe, runner, checkers } = probeWith();
    await probe.probe(signal());
    await probe.probe(signal());
    expect(runner.requests).toHaveLength(1);
    await probe.probe(signal(), { fresh: true });
    expect(runner.requests).toHaveLength(2);
    probe.invalidate();
    expect(checkers.calls).toBe(2);
  });
  it('fails plainly when the environment cannot report itself', async () => {
    await expect(probeWith('Traceback…', 1).probe.probe(signal())).rejects.toThrow(/could not report its version/);
  });
  it('parses only the probe shape', () => {
    expect(parseProbe(`warning: something\n${OUTPUT}\n`)?.python).toBe('3.12.4');
    expect(parseProbe('{"python": 3}')).toBeNull();
    expect(parseProbe('not json')).toBeNull();
    expect(parseProbe(JSON.stringify({ python: '3.12.4', packages: [['ok', '1'], [1, 2], 'bad'] }))?.packages).toEqual([{ name: 'ok', version: '1' }]);
  });
});
