import { ValidationError, countLines, type CodeFileRole, type UnnumberedConversationEvent } from '@automate/core';
import type { CodeVersionRepository, CodeVersionWithFiles } from '../../db/repositories/code-version-repository';
import type { CodeWorkspace } from '../code-workspace';

/** The dependencies every generation tool shares. */
export interface GenerationToolDependencies {
  readonly workspace: CodeWorkspace;
  readonly versions: CodeVersionRepository;
}

/** The execution a tool call belongs to, from the seam's string id. */
export function executionIdOf(context: { readonly executionId: string }): number {
  const id = Number(context.executionId);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('This tool can only run inside an execution.');
  return id;
}

/** Refuse further changes once the execution has chosen its final version. */
export function assertNotFinal(versions: CodeVersionRepository, executionId: number): void {
  const final = versions.findFinal(executionId);
  if (final) throw new ValidationError(`This run already finalized attempt ${final.attempt}; no further changes are accepted. Stop here.`);
}

/** What a write returns to the model: never the content, so it cannot inflate its own context by reading back what it wrote. */
export interface WriteResult { readonly path: string; readonly byteSize: number; readonly lineCount: number; readonly attempt: number }

/** Store one file of the current draft for the tool call's execution. */
export function writeFile(deps: GenerationToolDependencies, context: { readonly executionId: string }, role: CodeFileRole, args: { readonly path: string; readonly content: string }): WriteResult {
  const executionId = executionIdOf(context);
  assertNotFinal(deps.versions, executionId);
  const { file, version } = deps.workspace.putFile(executionId, { path: args.path, role, content: args.content });
  return { path: file.path, byteSize: file.byteSize, lineCount: countLines(file.content), attempt: version.attempt };
}

/** The transcript receipt for a sealed version: ids, digest, and file sizes — never the code. */
export function sealedEvent(version: CodeVersionWithFiles): UnnumberedConversationEvent {
  return { type: 'code_version_sealed', codeVersionId: version.id, attempt: version.attempt, digest: version.contentDigest!, files: version.files.map((file) => ({ path: file.path, role: file.role as CodeFileRole, byteSize: file.byteSize, lineCount: countLines(file.content) })), at: new Date().toISOString() };
}
