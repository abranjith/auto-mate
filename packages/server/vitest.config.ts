import { defineConfig } from 'vitest/config';
// The integration suites (FEAT-106/107) each build a whole data root and drive generation, verification,
// and runs end to end; in isolation they take well under a second, but with every file forked in parallel
// on Windows they can exceed vitest's 5-second default. The larger budget is for contention, not hangs.
export default defineConfig({ test: { name: 'server', include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 30_000 } });
