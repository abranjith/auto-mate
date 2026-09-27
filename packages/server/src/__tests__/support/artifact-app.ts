// Shared FEAT-109 test support: a run fixture whose outputs are registered by
// the real registrar, served by the real artifact routes on a loopback port.
// A plain module, not a `.test.ts`.

import type { Server } from 'node:http';
import pino from 'pino';
import { getArtifactConfig, type ArtifactConfig } from '../../config/env';
import { createApp } from '../../app';
import { ArtifactRegistrar } from '../../artifacts/artifact-registrar';
import { ArtifactService } from '../../artifacts/artifact-service';
import type { ArtifactRow } from '../../db/repositories/artifact-repository';
import { createRunFixture, writeManifest, writeOutput, type RunFixture } from './artifact-fixtures';

export interface ArtifactApp {
  readonly fixture: RunFixture;
  readonly service: ArtifactService;
  readonly base: string;
  /** Register whatever is in the run's output directory now. */
  register(): Promise<readonly ArtifactRow[]>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Start the artifact routes over a fresh temp data root.
 * @param files Output files to write before registering, by name.
 * @param declared Manifest entries; omit to write no manifest.
 * @param config Artifact limit overrides.
 */
export async function startArtifactApp(files: Record<string, string | Buffer> = {}, declared?: readonly { filename: string; type: string; title?: string; description?: string }[], config: Partial<ArtifactConfig> = {}): Promise<ArtifactApp> {
  const fixture = createRunFixture();
  const settings = { ...getArtifactConfig({}), ...config };
  for (const [name, content] of Object.entries(files)) writeOutput(fixture, name, content);
  if (declared) writeManifest(fixture, declared);
  const logger = pino({ level: 'silent' });
  const registrar = new ArtifactRegistrar({ paths: fixture.store.paths, artifacts: fixture.artifacts, logger, maxArtifactsPerRun: settings.maxArtifactsPerRun, scan: { formulaScanRows: settings.formulaScanRows, maxInflatedBytes: 1 << 30 } });
  const register = async () => {
    const manifestJson = declared ? JSON.stringify({ artifacts: declared.map((entry) => ({ title: entry.filename, description: '', ...entry })) }) : null;
    const result = await registrar.registerRunOutputs({ scriptRunId: fixture.run.id, executionId: fixture.executionId, taskId: fixture.taskId, outputDir: fixture.outputDir, manifestJson }, new AbortController().signal);
    fixture.scriptRuns.settle(fixture.run.id, { status: 'succeeded', exitCode: 0, stdout: '', stderr: '', outputTruncated: false, manifestPresent: declared !== undefined, manifestJson, declaredOutputCount: declared?.length ?? null, producedOutputCount: Object.keys(files).length, durationMs: 1, artifactCount: result.artifacts.length, unregisteredOutputCount: result.unregisteredOutputCount });
    return result.artifacts;
  };
  const service = new ArtifactService({ paths: fixture.store.paths, artifacts: fixture.artifacts, scriptRuns: fixture.scriptRuns, executions: fixture.executions, tasks: fixture.tasks, config: settings, maxInflatedBytes: 1 << 30 });
  const app = createApp({ logger, dataRoot: fixture.store.root, version: '0.1.0', getSchemaVersion: () => '1', paths: fixture.store.paths, artifacts: { artifacts: service, root: fixture.store.root, maxTablePageRows: settings.maxTablePageRows } });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    fixture, service, base, register,
    get: (path, headers) => fetch(`${base}${path}`, headers ? { headers } : {}),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fixture.store.dispose();
    },
  };
}
