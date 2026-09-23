// ---------------------------------------------------------------------------
// A DELIBERATE architectural boundary violation (FEAT-102 TASK-008).
//
// This file imports the Pi SDK from `packages/core`, which the seam forbids. It
// exists so two guards can be proven to actually fail:
//
//   - `pnpm lint` reports the restricted import when this file is linted
//     directly (`npx eslint --no-ignore <this file>`).
//   - `agent-boundary.test.ts` reports it as an offender when the allowlist is
//     emptied.
//
// It is excluded from the build (`tsconfig.json`) and from normal lint runs
// (`eslint.config.js` ignores `**/__fixtures__/**`), and nothing imports it.
// ---------------------------------------------------------------------------

import { createAgentSession } from '@earendil-works/pi-coding-agent';

export const deliberateViolation = createAgentSession;
