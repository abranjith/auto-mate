// A saved-code run's directories use the revision's original input name,
// never the new upload's stored name. Generated runs retain their existing names.
import { ExecutionNotFoundError, UploadNotFoundError } from '@automate/core';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { ExecutionReuseRepository } from '../db/repositories/execution-reuse-repository';
import type { UploadRepository, UploadRow } from '../db/repositories/upload-repository';

export interface ResolvedInput { readonly position: number; readonly uploadId: number; readonly inputName: string; readonly upload: UploadRow }

/** The only resolver of "which upload, under which name?". */
export class ExecutionInputs {
  constructor(private readonly executions: ExecutionRepository, private readonly reuse: ExecutionReuseRepository, private readonly uploads: UploadRepository) {}

  resolve(executionId: number): ResolvedInput[] {
    const execution = this.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    const bindings = this.reuse.listBindings(executionId);
    if (!bindings.length) return this.fromUploads(this.uploads.listByTask(execution.taskId));
    return bindings.map((binding) => {
      const upload = this.uploads.getById(binding.uploadId);
      if (!upload || upload.taskId !== execution.taskId) throw new UploadNotFoundError(binding.uploadId);
      return { position: binding.position, uploadId: binding.uploadId, inputName: binding.inputName, upload };
    });
  }

  /** Adapt uploads already loaded by a caller; used by legacy generated-run tests. */
  fromUploads(uploads: readonly UploadRow[]): ResolvedInput[] {
    return uploads.map((upload, position) => ({ position, uploadId: upload.id, inputName: upload.storedFilename, upload }));
  }
}

/** Shape an already loaded upload list without a database read. */
export function resolveGeneratedInputs(uploads: readonly UploadRow[]): ResolvedInput[] {
  return uploads.map((upload, position) => ({ position, uploadId: upload.id, inputName: upload.storedFilename, upload }));
}
