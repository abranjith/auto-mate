import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../../config/app-paths';
import { openDatabase } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { TaskRepository } from '../../db/repositories/task-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { ExecutionReuseRepository } from '../../db/repositories/execution-reuse-repository';
import { UploadRepository } from '../../db/repositories/upload-repository';
import { ExecutionInputs } from '../../execution/execution-inputs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('ExecutionInputs', () => {
  it('uses bindings for saved code and stored names for generated runs', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-inputs-')); roots.push(root);
    const paths = getAppPaths(root); ensureAppDirectories(paths);
    const connection = openDatabase(paths);
    try {
      migrateDatabase(connection);
      const tasks = new TaskRepository(connection), executions = new ExecutionRepository(connection), uploads = new UploadRepository(connection);
      const reuse = new ExecutionReuseRepository(connection), resolver = new ExecutionInputs(executions, reuse, uploads);
      const created = tasks.createWithExecution('Summarize');
      const upload = uploads.createStaged({ originalFilename: 'oct.csv', storedFilename: '30-oct.csv', filePath: 'uploads/staged/30-oct.csv', format: 'csv', mimeType: 'text/csv', byteSize: 10, sha256: 'a'.repeat(64) });
      uploads.attachToTask(upload.id, created.task.id, `uploads/${created.task.id}/30-oct.csv`);
      expect(resolver.resolve(created.execution.id)).toMatchObject([{ position: 0, uploadId: upload.id, inputName: '30-oct.csv' }]);
      connection.db.transaction((tx) => reuse.bind(tx, { executionId: created.execution.id, uploadId: upload.id, position: 0, inputName: '12-sales_q1.csv' }));
      expect(resolver.resolve(created.execution.id)).toMatchObject([{ position: 0, uploadId: upload.id, inputName: '12-sales_q1.csv', upload: { storedFilename: '30-oct.csv' } }]);
      expect(() => connection.db.transaction((tx) => reuse.bind(tx, { executionId: created.execution.id, uploadId: upload.id, position: 1, inputName: '../escape.csv' }))).toThrow();
      expect(() => connection.db.transaction((tx) => reuse.bind(tx, { executionId: created.execution.id, uploadId: upload.id, position: 1, inputName: 'CON.csv' }))).toThrow();
    } finally { connection.close(); }
  });
});
