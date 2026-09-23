import { Value } from '@sinclair/typebox/value';
import { ApiErrorSchema, AutoMateError, ERROR_CODES, HealthResponseSchema, type HealthResponse } from '@automate/core';

/** Turn one fetch response into validated data or a typed error. */
async function readResponse<T>(response: Response, validate: (value: unknown) => value is T, correlationId: string): Promise<T> {
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'The server returned an unreadable response.', undefined, correlationId); }
  if (!response.ok) {
    if (Value.Check(ApiErrorSchema, data)) throw new AutoMateError(data.error.code, data.error.message, undefined, data.error.correlationId ?? correlationId);
    throw new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'The server returned an unexpected error.', undefined, correlationId);
  }
  if (!validate(data)) throw new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'The server returned invalid data.', undefined, correlationId);
  return data;
}

/** Fetch one JSON API resource. @param path Path after /api. @param validate Shared response validator. @param fetcher Injectable fetch function. @returns Validated data. @throws AutoMateError for connection, server, or schema failures. */
export async function getJson<T>(path: string, validate: (value: unknown) => value is T, fetcher: typeof fetch = fetch): Promise<T> {
  const correlationId = crypto.randomUUID();
  let response: Response;
  try { response = await fetcher(`/api${path}`, { headers: { 'x-correlation-id': correlationId } }); }
  catch { throw new AutoMateError(ERROR_CODES.CONNECTION_ERROR, 'Cannot reach the local server. Start it with pnpm dev.', undefined, correlationId); }
  return readResponse(response, validate, correlationId);
}

/** Send one JSON API request. @param path Path after /api. @param method HTTP method. @param body Request payload, omitted when undefined. @param validate Shared response validator. @param fetcher Injectable fetch function. @returns Validated data. @throws AutoMateError for connection, server, or schema failures. */
export async function sendJson<T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown,
  validate: (value: unknown) => value is T,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const correlationId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetcher(`/api${path}`, {
      method,
      headers: { 'x-correlation-id': correlationId, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new AutoMateError(ERROR_CODES.CONNECTION_ERROR, 'Cannot reach the local server. Start it with pnpm dev.', undefined, correlationId); }
  return readResponse(response, validate, correlationId);
}

/** Read and validate server health. @param fetcher Optional test fetcher. @returns A schema-valid health payload. */
export function getHealth(fetcher?: typeof fetch): Promise<HealthResponse> {
  return getJson('/health', (value): value is HealthResponse => Value.Check(HealthResponseSchema, value), fetcher);
}
