import { Value } from '@sinclair/typebox/value';
import { ConsentResponseSchema, DisclosurePreviewResponseSchema, DisclosureReceiptResponseSchema, type ConsentResponse, type DisclosurePreviewResponse, type GrantConsentRequest, type TransmissionReceipt } from '@automate/core';
import { getJson, sendJson } from './api-client';

/** Fetch the exact text and decisions for staged uploads. */
export function getDisclosurePreview(uploadIds: readonly number[]): Promise<DisclosurePreviewResponse> {
  return getJson(`/disclosure/preview?uploadIds=${uploadIds.join(',')}`, (value): value is DisclosurePreviewResponse => Value.Check(DisclosurePreviewResponseSchema, value));
}
/** Persist an explicit approval after the server re-derives the preview. */
export function grantDisclosureConsent(body: GrantConsentRequest): Promise<ConsentResponse> {
  return sendJson('/disclosure/consents', 'POST', body, (value): value is ConsentResponse => Value.Check(ConsentResponseSchema, value));
}
/** Fetch exact transmission receipts only when a person expands the transcript line. */
export async function getDisclosureReceipts(executionId: number): Promise<readonly TransmissionReceipt[]> {
  const result = await getJson(`/executions/${executionId}/disclosure`, (value): value is { transmissions: TransmissionReceipt[] } => Value.Check(DisclosureReceiptResponseSchema, value));
  return result.transmissions;
}
