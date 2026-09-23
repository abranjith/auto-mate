// ---------------------------------------------------------------------------
// The app-owned agent selection, serialized at `<dataRoot>/config/agent.json`
// (FEAT-102 TASK-003).
//
// This file contains NO credential material, ever. It is read by the settings
// API and rendered in the browser; a key in it would be a key on screen.
// ---------------------------------------------------------------------------

import { Type, type Static } from '@sinclair/typebox';

/** Current `agent.json` schema version. Present from the first write so a migration has something to branch on. */
export const AGENT_CONFIG_VERSION = 1;

/**
 * Credential selection.
 *
 * `authPath` is required exactly when the mode is `personal-pi`, and rejected
 * otherwise — the conditional holds in both directions so a stale path cannot
 * linger in a `managed` config and silently take effect on a later switch.
 */
const AgentAuthSchema = Type.Union([
  Type.Object({ mode: Type.Literal('managed') }, { additionalProperties: false }),
  Type.Object(
    { mode: Type.Literal('personal-pi'), authPath: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

/** The complete, validated `agent.json` document. */
export const AgentConfigSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    // Validated against the adapter's known levels at session open, not at file
    // load, so a config written for a newer SDK is not rejected on read.
    thinking: Type.Optional(Type.String({ minLength: 1 })),
    auth: AgentAuthSchema,
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** The request body accepted by `PUT /api/agent/config`; the server owns `version` and `updatedAt`. */
export const AgentConfigUpdateSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking: Type.Optional(Type.String({ minLength: 1 })),
    auth: AgentAuthSchema,
  },
  { additionalProperties: false },
);

export type AgentConfig = Static<typeof AgentConfigSchema>;
export type AgentConfigUpdate = Static<typeof AgentConfigUpdateSchema>;

/**
 * The selection written on first run.
 *
 * Sonnet 5 is the cost/quality default for a code-generation-and-repair loop;
 * Opus 5 is the upgrade. This is a default, not a pin — the config file and the
 * settings page both change it.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  version: AGENT_CONFIG_VERSION,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  thinking: 'high',
  auth: { mode: 'managed' },
  updatedAt: '1970-01-01T00:00:00.000Z',
};
