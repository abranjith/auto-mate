// ---------------------------------------------------------------------------
// Request and response shapes for the agent settings API (FEAT-102 TASK-010).
//
// Shared by the server and the browser so neither duplicates a type. None of
// these shapes has a field capable of carrying a credential value: the API can
// report WHERE a credential came from, never what it is.
// ---------------------------------------------------------------------------

import { Type, type Static } from '@sinclair/typebox';
import { AgentConfigSchema, AgentConfigUpdateSchema } from '../agent/agent-config';

/** `GET /api/agent/config` and `PUT /api/agent/config` response: the stored selection. */
export const AgentConfigResponseSchema = AgentConfigSchema;

/** `PUT /api/agent/config` request body. The server owns `version` and `updatedAt`. */
export { AgentConfigUpdateSchema };

/** Where a provider's credential was resolved from, or that none was. */
export const CredentialSourceSchema = Type.Union([
  Type.Literal('managed'),
  Type.Literal('personal-pi'),
  Type.Literal('environment'),
  Type.Literal('unavailable'),
]);

/** One provider's configuration status, as the settings page renders it. */
export const ProviderCatalogEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    credentialAvailable: Type.Boolean(),
    credentialSource: CredentialSourceSchema,
    models: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), label: Type.String() }, { additionalProperties: false })),
    remediation: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * `GET /api/agent/providers` response.
 *
 * DEVIATION from memory's "paginate all list endpoints": this is a bounded
 * configuration enumeration fixed by the SDK's registry, not a growing dataset,
 * and paginating it would make the settings page fetch N times to render one
 * dropdown. Recorded in the feature spec §6.
 */
export const ProviderCatalogResponseSchema = Type.Object(
  { providers: Type.Array(ProviderCatalogEntrySchema) },
  { additionalProperties: false },
);

/** `POST /api/agent/test-connection` response: the outcome of one real session. */
export const ConnectionTestResponseSchema = Type.Object(
  {
    ok: Type.Boolean(),
    model: Type.String(),
    provider: Type.String(),
    authSource: Type.Optional(Type.Union([Type.Literal('managed'), Type.Literal('personal-pi'), Type.Literal('environment')])),
    sessionId: Type.Optional(Type.String()),
    durationMs: Type.Number({ minimum: 0 }),
    eventCounts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    statusToolInvoked: Type.Boolean(),
    /** Present only when the test failed: the stable code and its plain-English message. */
    error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

export type AgentConfigResponse = Static<typeof AgentConfigResponseSchema>;
export type ProviderCatalogEntryResponse = Static<typeof ProviderCatalogEntrySchema>;
export type ProviderCatalogResponse = Static<typeof ProviderCatalogResponseSchema>;
export type ConnectionTestResponse = Static<typeof ConnectionTestResponseSchema>;
