import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'apps/agent-web/dist/**', 'apps/agent-server/**', '.superpowers/**', 'test/e2e/fixture-server.mjs', 'test/e2e/metrics-fixture-server.mjs', 'node_modules/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['apps/agent-server/*.mjs', 'apps/acceptance/*.mjs', 'apps/agent-web/vite.config.ts', 'playwright.config.ts', 'playwright.logs.config.ts', 'test/e2e/logs-fixture-server.mjs', 'test/fixtures/langsmith-fetch-proxy.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // These are JavaScript entry points; check basic rules without treating
    // unannotated JavaScript as typed TypeScript that requires generated `dist`.
    files: ['apps/metrics-lab/*.mjs', 'apps/acceptance/*.mjs', 'test/e2e/logs-fixture-server.mjs', 'test/fixtures/langsmith-fetch-proxy.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: 'readonly', fetch: 'readonly', Buffer: 'readonly', AbortSignal: 'readonly', Request: 'readonly', URL: 'readonly' },
    },
    rules: tseslint.configs.disableTypeChecked.rules,
  },
);
