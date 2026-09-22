import { Type, type Static } from '@sinclair/typebox';

/** Public health payload shared by the server and browser. */
export const HealthResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  version: Type.String(),
  uptimeSeconds: Type.Number({ minimum: 0 }),
  database: Type.Object({ connected: Type.Boolean(), schemaVersion: Type.String() }),
  dataRoot: Type.String(),
});

/** Public error envelope shared by the server and browser. */
export const ApiErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    correlationId: Type.Optional(Type.String()),
  }),
});

export type HealthResponse = Static<typeof HealthResponseSchema>;
export type ApiError = Static<typeof ApiErrorSchema>;
