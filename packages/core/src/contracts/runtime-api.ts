import { Type, type Static } from '@sinclair/typebox';
import { RUNTIME_KINDS, RUNTIME_STATUSES } from '../execution/runtime-environment';

export const RuntimeKindSchema = Type.Union(RUNTIME_KINDS.map((kind) => Type.Literal(kind)));
export const RuntimeStatusSchema = Type.Union(RUNTIME_STATUSES.map((status) => Type.Literal(status)));
export const RuntimeEnvironmentSchema = Type.Object({
  kind: RuntimeKindSchema,
  status: RuntimeStatusSchema,
  pythonVersion: Type.String(),
  uvVersion: Type.String(),
  fingerprint: Type.Union([Type.String(), Type.Null()]),
  lockDigest: Type.String(),
  packageCount: Type.Integer({ minimum: 0 }),
  packages: Type.Array(Type.Object({ name: Type.String(), version: Type.String() })),
  preparedAt: Type.Union([Type.String(), Type.Null()]),
  failureReason: Type.Union([Type.String(), Type.Null()]),
});
export const RuntimeReadinessSchema = Type.Object({
  ready: Type.Boolean(),
  environment: Type.Union([RuntimeEnvironmentSchema, Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
});
export const RuntimeStatusResponseSchema = Type.Object({
  pinnedPythonVersion: Type.String(),
  script: RuntimeReadinessSchema,
  verify: RuntimeReadinessSchema,
  capabilities: Type.Array(Type.String()),
});
export const RuntimePrepareRequestSchema = Type.Object({ kind: RuntimeKindSchema });
export const RuntimePrepareResponseSchema = Type.Object({ kind: RuntimeKindSchema, readiness: RuntimeReadinessSchema });
export type RuntimeStatusResponse = Static<typeof RuntimeStatusResponseSchema>;
export type RuntimePrepareRequest = Static<typeof RuntimePrepareRequestSchema>;
export type RuntimePrepareResponse = Static<typeof RuntimePrepareResponseSchema>;
