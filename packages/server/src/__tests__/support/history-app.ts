// Shared FEAT-110 test support: the whole route surface — conversation,
// ingestion, disclosure, generation, verification, runtime, artifacts, and
// history — over a verification harness on a loopback port. Not a test file.
import type { Server } from 'node:http';
import { vi } from 'vitest';
import pino, { type Logger } from 'pino';
import { UPLOAD_LIMIT_DEFAULTS } from '@automate/core';
import { createApp } from '../../app';
import { AgentConfigStore } from '../../agent/index';
import { getArtifactConfig, type ServerConfig } from '../../config/env';
import { ArtifactService } from '../../artifacts/artifact-service';
import type { RuntimeProvisioner } from '../../execution/runtime-provisioner';
import { HistoryRepository } from '../../db/repositories/history-repository';
import { TaskDeletionService } from '../../history/task-deletion-service';
import { UploadFileStore } from '../../ingestion/upload-file-store';
import { ProfileService } from '../../ingestion/profile-service';
import { UploadService } from '../../ingestion/upload-service';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from './verification-harness';

/** A debug-level logger whose every line is kept, for "never logged" assertions. */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, logger: pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } }) };
}

/** Start every router over a fresh harness. Call `close()` in `afterEach`. */
export async function startFullApp(options: VerificationHarnessOptions & { logger?: Logger } = {}) {
  const h: VerificationHarness = await createVerificationHarness({ onApproved: () => undefined, ...options });
  const logger = options.logger ?? h.logger;
  const config: ServerConfig = { host: '127.0.0.1', port: 0, logLevel: 'silent', maxConcurrentExecutions: 5, allowedOrigins: [], nodeEnv: 'test' };
  const files = new UploadFileStore(h.store.paths);
  const limits = { ...UPLOAD_LIMIT_DEFAULTS };
  const profiler = new ProfileService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store: files, limits, logger: h.logger });
  const uploads = new UploadService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store: files, profiler, limits, logger: h.logger });
  const provisioner = { getReadiness: () => ({ ready: false, environment: null, reason: 'Not prepared.' }), ensureRuntime: vi.fn(async () => ({ row: {}, prepared: false })) } as unknown as RuntimeProvisioner;
  const artifactConfig = getArtifactConfig({});
  const artifacts = new ArtifactService({ paths: h.store.paths, artifacts: h.repos.artifacts, scriptRuns: h.repos.scriptRuns, executions: h.repos.executions, tasks: h.repos.tasks, config: artifactConfig, maxInflatedBytes: 1 << 30 });
  const history = new HistoryRepository(h.store.connection);
  const deletion = new TaskDeletionService({ paths: h.store.paths, tasks: h.repos.tasks, executions: h.repos.executions, registry: h.registry, logger });
  const app = createApp({
    logger, dataRoot: h.store.root, version: 'test', paths: h.store.paths, getSchemaVersion: () => '9', serverConfig: config,
    agent: { configStore: new AgentConfigStore({ paths: h.store.paths, logger: h.logger }), probe: () => Promise.resolve([]), runSmoke: () => Promise.reject(new Error('not in this test')) },
    conversation: { tasks: h.repos.tasks, executions: h.repos.executions, events: h.repos.events, registry: h.registry, disclosure: h.disclosure, preflight: h.preflight, consents: h.repos.consents },
    ingestion: { uploads },
    disclosure: { service: h.disclosure, transmissions: h.repos.transmissions, consents: h.repos.consents, clarifications: h.repos.clarifications, clarificationService: h.clarificationService },
    generation: { service: h.service },
    verification: { verification: h.verification, intents: h.intents, approval: h.approval, runs: h.scriptRun, review: h.review, assertCapacity: () => h.registry.assertCapacity() },
    runtime: { provisioner, platform: 'linux' },
    artifacts: { artifacts, root: h.store.root, maxTablePageRows: artifactConfig.maxTablePageRows },
    history: { history, tasks: h.repos.tasks, deletion, config },
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  config.port = address.port;
  return {
    app, h, history, deletion, config, base: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      for (const { id } of h.store.connection.client.prepare('select id from execution').all() as { id: number }[]) if (h.registry.isLive(id)) await h.registry.abort(id);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await h.dispose();
    },
  };
}
export type FullApp = Awaited<ReturnType<typeof startFullApp>>;
