// ---------------------------------------------------------------------------
// `finalize_script` (FEAT-106 TASK-009).
//
// Finalizing is NOT a gate. It accepts a version whose own tests never passed
// and records `tests_passed` exactly as it stands: authorizing execution is
// FEAT-107's job, and agent progress alone never does it. What it refuses are
// mistakes the model can fix in the same turn — a second finalization, an
// entrypoint that is not a script in the version, and a declared input column
// no attached file has.
// ---------------------------------------------------------------------------

import {
  FinalizeScriptArgsSchema,
  buildDisclosurePayload,
  ValidationError,
  validateCodePath,
  type AgentToolDefinition,
  type DeclaredInput,
  type UnnumberedConversationEvent,
} from '@automate/core';
import type { Logger } from 'pino';
import type { CodeVersionRow } from '../../db/repositories/code-version-repository';
import type { ExecutionRepository } from '../../db/repositories/execution-repository';
import type { UploadProfileRepository } from '../../db/repositories/upload-profile-repository';
import type { UploadRepository } from '../../db/repositories/upload-repository';
import { executionIdOf, sealedEvent, type GenerationToolDependencies } from './tool-context';

export interface FinalizeScriptToolDependencies extends GenerationToolDependencies {
  readonly executions: ExecutionRepository;
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly publish: (executionId: number, event: UnnumberedConversationEvent) => void;
  readonly logger: Pick<Logger, 'info'>;
}

export interface FinalizeResult { readonly codeVersionId: number; readonly digest: string; readonly attempt: number; readonly testsPassed: boolean | null }

/** Build the `finalize_script` tool. @param deps Workspace, repositories, and the transcript publisher. */
export function createFinalizeScriptTool(deps: FinalizeScriptToolDependencies): AgentToolDefinition<typeof FinalizeScriptArgsSchema> {
  return {
    name: 'finalize_script',
    description: 'Choose the version to hand to the application: the files written since the last test run, or else the most recently tested version. Give the entrypoint script, a plain-English summary for a non-programmer, the input files and columns the script needs, and every output it writes (the same entries as manifest.json). Call it exactly once, then stop. A version whose tests did not pass may still be finalized; the application checks it independently before anything runs on real data.',
    parameters: FinalizeScriptArgsSchema,
    execute: async (args, context) => finalize(deps, executionIdOf(context), args),
  };
}

async function finalize(deps: FinalizeScriptToolDependencies, executionId: number, args: Parameters<ReturnType<typeof createFinalizeScriptTool>['execute']>[0]): Promise<FinalizeResult> {
  const existing = deps.versions.findFinal(executionId);
  if (existing) throw new ValidationError(`This run already finalized attempt ${existing.attempt}; it cannot be finalized twice. Stop here.`);
  const version = chooseVersion(deps, executionId);
  const entrypoint = validateCodePath(args.entrypoint, 'script');
  const scripts = deps.versions.listFiles([version.id]).filter(({ role }) => role === 'script').map(({ path }) => path);
  if (!scripts.includes(entrypoint)) throw new ValidationError(`\`${entrypoint}\` is not a script in attempt ${version.attempt}. Scripts in it: ${scripts.join(', ') || 'none'}.`);
  assertColumnsExist(deps, executionId, args.declaredInputs);
  const final = deps.workspace.finalize(version.id, { entrypoint, summary: args.summary, declaredInputs: args.declaredInputs, declaredOutputs: args.declaredOutputs });
  deps.logger.info({ executionId, codeVersionId: final.id, digest: final.contentDigest, testsPassed: final.testsPassed }, 'code version finalized');
  return { codeVersionId: final.id, digest: final.contentDigest!, attempt: final.attempt, testsPassed: final.testsPassed };
}

/** Seal an open draft that has files and use it; otherwise use the most recent sealed version. */
function chooseVersion(deps: FinalizeScriptToolDependencies, executionId: number): CodeVersionRow {
  const draft = deps.versions.findDraft(executionId);
  if (draft && deps.versions.listFiles([draft.id]).length > 0) {
    const sealed = deps.workspace.seal(executionId);
    deps.publish(executionId, sealedEvent(sealed));
    return sealed;
  }
  const latest = deps.versions.listByExecution(executionId).find(({ status }) => status !== 'draft' && status !== 'superseded');
  if (!latest) throw new ValidationError('There is no version to finalize yet. Write the script with write_script first.');
  return latest;
}

/**
 * A declared column must exist in at least one attached file — a typo the model can fix now.
 * Checked against the DISCLOSED columns only: the hint names columns back to the model, and a
 * column the degradation ladder left out of the approved payload must never be named to it.
 */
function assertColumnsExist(deps: FinalizeScriptToolDependencies, executionId: number, inputs: readonly DeclaredInput[]): void {
  const taskId = deps.executions.getById(executionId)?.taskId;
  const uploads = taskId === undefined ? [] : deps.uploads.listByTask(taskId);
  if (uploads.length === 0) return;
  const known = new Set(uploads.flatMap(({ id }) => {
    const source = deps.profiles.getDisclosureSource(id);
    return source ? buildDisclosurePayload(source.upload, source.profiles).tables.flatMap(({ columns }) => columns.map(({ name }) => name)) : [];
  }));
  const missing = inputs.flatMap(({ requiredColumns }) => requiredColumns.map(({ name }) => name)).filter((name) => !known.has(name));
  if (missing.length === 0) return;
  throw new ValidationError(`Declared input column${missing.length === 1 ? '' : 's'} ${missing.map((name) => `"${name}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in any attached file. Columns that exist: ${[...known].map((name) => `"${name}"`).join(', ')}.`);
}
