import { Value } from '@sinclair/typebox/value';
import { GrantConsentRequestSchema, ValidationError, type GrantConsentRequest } from '@automate/core';
import { Router } from 'express';
import type { DisclosureService } from '../disclosure/disclosure-service';
import type { DisclosureTransmissionRepository } from '../db/repositories/disclosure-transmission-repository';
import type { DisclosureConsentRepository } from '../db/repositories/disclosure-consent-repository';

export interface DisclosureRouteDependencies { readonly disclosure: DisclosureService; readonly transmissions: DisclosureTransmissionRepository; readonly consents: DisclosureConsentRepository }
const parseId = (value: string) => { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('The execution id must be a positive integer.'); return id; };
const parseUploadIds = (value: unknown): number[] => {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError('uploadIds must be a comma-separated list of positive integers.');
  const ids = value.split(',').map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) throw new ValidationError('uploadIds must contain each positive integer once.');
  return ids;
};

/** Disclosure preview, consent, and receipt endpoints. */
export function disclosureRoute(deps: DisclosureRouteDependencies): Router {
  const router = Router();
  router.get('/api/disclosure/preview', (request, response, next) => { try { response.json(deps.disclosure.buildPreview(parseUploadIds(request.query.uploadIds))); } catch (cause) { next(cause); } });
  router.post('/api/disclosure/consents', (request, response, next) => {
    try {
      if (!Value.Check(GrantConsentRequestSchema, request.body)) throw new ValidationError('Consent requires analyzed upload ids, the displayed digest, and the diagnostics choice.');
      const row = deps.disclosure.grantConsent(request.body as GrantConsentRequest);
      response.status(201).json({ id: row.id, payloadDigest: row.payloadDigest, provider: row.provider, model: row.model, byteSize: row.byteSize, scopeContext: row.scopeContext, scopeDiagnostics: row.scopeDiagnostics, grantedAt: row.grantedAt.toISOString() });
    } catch (cause) { next(cause); }
  });
  router.get('/api/executions/:executionId/disclosure', (request, response, next) => {
    try {
      const transmissions = deps.transmissions.listByExecution(parseId(String(request.params.executionId))).map((row) => ({ ...row, payloadSnapshot: row.payloadSnapshot ?? deps.consents.getById(row.consentId)?.payloadSnapshot ?? null, summary: JSON.parse(row.summary) as unknown, at: row.at.toISOString() }));
      response.json({ transmissions });
    } catch (cause) { next(cause); }
  });
  return router;
}
