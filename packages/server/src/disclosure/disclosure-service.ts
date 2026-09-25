import { createHash } from 'node:crypto';
import {
  DisclosureConsentRequiredError,
  DisclosureConsentStaleError,
  DisclosureScopeNotGrantedError,
  UploadNotFoundError,
  ValidationError,
  buildDisclosurePayload,
  canonicalStringify,
  classifyFindings,
  evaluateConsent,
  renderDisclosureText,
  utf8ByteLength,
  type DisclosurePreviewResponse,
} from '@automate/core';
import type { AgentConfigStore } from '../agent/config/agent-config-store';
import type { DisclosureConsentRepository, DisclosureConsentRow } from '../db/repositories/disclosure-consent-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';

export interface DisclosureServiceDependencies { readonly uploads: UploadRepository; readonly profiles: UploadProfileRepository; readonly consents: DisclosureConsentRepository; readonly configStore: AgentConfigStore; readonly maxPreflightDecisions?: number }

/** Builds disclosure previews and verifies every later transmission. */
export class DisclosureService {
  constructor(private readonly deps: DisclosureServiceDependencies) {}

  /** Rebuild the exact preview from stored profiles and current recipient. */
  buildPreview(requestedIds: readonly number[]): DisclosurePreviewResponse {
    const uploadIds = [...new Set(requestedIds)].sort((a, b) => a - b);
    if (uploadIds.length === 0) throw new ValidationError('Choose at least one analyzed file.');
    const payloads = uploadIds.map((id, position) => {
      const row = this.deps.uploads.getById(id);
      if (!row) throw new UploadNotFoundError(id);
      if (row.profileStatus !== 'profiled') throw new ValidationError(`File ${position + 1} has not finished analysis and cannot be disclosed yet.`);
      const source = this.deps.profiles.getDisclosureSource(id);
      if (!source) throw new UploadNotFoundError(id);
      return { payload: buildDisclosurePayload(source.upload, source.profiles), profiles: source.profiles };
    });
    const text = renderDisclosureText(payloads.map(({ payload }) => payload));
    const config = this.deps.configStore.load();
    const digest = createHash('sha256').update(canonicalStringify({ text, uploadIds, provider: config.provider, model: config.model })).digest('hex');
    const findings = classifyFindings(payloads.flatMap(({ profiles }) => profiles), { maxDecisions: this.deps.maxPreflightDecisions });
    return {
      uploadIds,
      text,
      digest,
      byteSize: utf8ByteLength(text),
      provider: config.provider,
      model: config.model,
      truncations: payloads.flatMap(({ payload }, file) => payload.truncations.map((item) => `File ${file + 1}: ${item.step}`)),
      required: findings.required.map((finding) => ({ ...finding, options: [...finding.options] })),
      defaults: findings.defaults.map((item) => ({ findingKey: item.findingKey, label: item.label, value: item.value, demoted: item.demoted, ...(item.options ? { options: item.options.map((entry) => ({ ...entry })) } : {}) })),
      notices: findings.notices,
    };
  }

  /** Grant only when the browser acknowledges the preview the server currently derives. */
  grantConsent(request: { readonly uploadIds: readonly number[]; readonly payloadDigest: string; readonly scopeDiagnostics: boolean }): DisclosureConsentRow {
    const preview = this.buildPreview(request.uploadIds);
    if (preview.digest !== request.payloadDigest) throw new DisclosureConsentStaleError(preview.provider, preview.model, preview.provider, preview.model, 'the file description changed after it was shown');
    return this.deps.consents.grant({ uploadIds: preview.uploadIds, payloadDigest: preview.digest, payloadSnapshot: preview.text, byteSize: preview.byteSize, provider: preview.provider, model: preview.model, scopeDiagnostics: request.scopeDiagnostics });
  }

  /** Verify a pre-task acknowledgement before creating any task rows. */
  verifyAcknowledgement(consentId: number, digest: string, uploadIds: readonly number[]): DisclosureConsentRow {
    const consent = this.deps.consents.getById(consentId);
    if (!consent || consent.revokedAt) throw new DisclosureConsentRequiredError();
    const preview = this.buildPreview(uploadIds);
    if (consent.payloadDigest !== digest || digest !== preview.digest || consent.uploadIds !== JSON.stringify(preview.uploadIds)) throw new DisclosureConsentStaleError(consent.provider, consent.model, preview.provider, preview.model);
    const reason = evaluateConsent(this.view(consent), { payloadDigest: preview.digest, provider: preview.provider, model: preview.model, kind: 'context' });
    if (reason === 'scope') throw new DisclosureScopeNotGrantedError('file context');
    if (reason !== 'none') throw new DisclosureConsentStaleError(consent.provider, consent.model, preview.provider, preview.model);
    return consent;
  }

  /** Independently verify the attached task's live approval before transmission. */
  verifyForTransmission(taskId: number, kind: 'context' | 'diagnostics'): DisclosureConsentRow {
    const consent = this.deps.consents.findLiveForTask(taskId);
    if (!consent) throw new DisclosureConsentRequiredError();
    const preview = this.buildPreview(JSON.parse(consent.uploadIds) as number[]);
    const reason = evaluateConsent(this.view(consent), { payloadDigest: preview.digest, provider: preview.provider, model: preview.model, kind });
    if (reason === 'scope') throw new DisclosureScopeNotGrantedError(kind);
    if (reason !== 'none') throw new DisclosureConsentStaleError(consent.provider, consent.model, preview.provider, preview.model);
    return consent;
  }

  private view(row: DisclosureConsentRow) { return { id: row.id, payloadDigest: row.payloadDigest, provider: row.provider, model: row.model, scopeContext: row.scopeContext, scopeDiagnostics: row.scopeDiagnostics, revokedAt: row.revokedAt?.toISOString() ?? null }; }
}
