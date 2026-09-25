import type { DatabaseConnection } from '../../db/client';
import type { AppPaths } from '../../config/app-paths';
import { RuntimeEnvironmentRepository } from '../../db/repositories/runtime-environment-repository';
import { ProcessRunner } from '../../execution/process-runner';
import { RuntimeProvisioner } from '../../execution/runtime-provisioner';
import { UvPythonRunner } from '../../execution/uv-python-runner';
import { fakeSpawn, type FakeBehavior } from '../execution/fake-spawn';

export const INSPECT_OUTPUT = JSON.stringify({ python: '3.14.6', packages: [['pytest', '9.1.1']] });

/** A real locked runner over fake processes and temporary persistence. */
export function lockedUvRunner(paths: AppPaths, connection: DatabaseConnection, behave: (command: string, args: readonly string[]) => FakeBehavior) {
  const fake = fakeSpawn((command, args) => {
    if (args[0] === 'run' && args.includes('-c')) return { stdout: INSPECT_OUTPUT };
    return behave(command, args);
  });
  const processes = new ProcessRunner({ spawn: fake.spawn, platform: 'win32' });
  const provisioner = new RuntimeProvisioner({ scriptEnvDir: paths.envDir, verifyEnvDir: paths.verifyEnvDir, environments: new RuntimeEnvironmentRepository(connection), processes, platform: 'win32' });
  return { fake, runner: new UvPythonRunner({ envDir: paths.envDir, provisioner, processes, platform: 'win32', baseEnv: {} }) };
}
