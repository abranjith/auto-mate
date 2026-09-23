import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/** The Pi SDK may be imported only behind the AgentProvider seam. */
const PI_SDK_BOUNDARY = {
  name: '@earendil-works/pi-coding-agent',
  message:
    'The Pi SDK may only be imported under packages/server/src/agent/adapters/pi/. ' +
    'Everything else consumes the AgentProvider seam from @automate/core.',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/routeTree.gen.ts', '**/drizzle/**', '**/__fixtures__/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [PI_SDK_BOUNDARY], patterns: [{ group: ['@earendil-works/pi-coding-agent/*'], message: PI_SDK_BOUNDARY.message }] }],
    },
  },
  {
    // The adapter is the one place the SDK is allowed, along with its own tests.
    files: ['packages/server/src/agent/adapters/pi/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
