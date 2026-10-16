import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.nyc_output/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Test-only exports pull in fast-check; keep them out of app and library code.
    files: ['**/*.{ts,tsx,mts}'],
    ignores: ['**/*.test.{ts,tsx}', '**/test-helpers.ts', '**/test/**', 'bench/**', 'e2e/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@open-ancestry/*/testing', '@open-ancestry/*/testing/*'],
              message: 'Test-only module: import it from tests only.',
            },
          ],
        },
      ],
    },
  },
  {
    // Temp folders in tests and benches must be cleaned up; makeTempDir does it.
    files: [
      '**/*.test.{ts,tsx}',
      '**/test-helpers.ts',
      '**/test-utils.ts',
      '**/test/**',
      'bench/**',
      'e2e/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        ...['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].map((name) => ({
          name,
          importNames: ['mkdtemp', 'mkdtempSync'],
          message:
            'Use makeTempDir from fixtures/temp-dir.ts, which removes the folder after the test file.',
        })),
      ],
      // The same through a namespace or a dynamic import: fs.mkdtempSync(...),
      // (await import('node:fs/promises')).mkdtemp(...), const { mkdtemp } = ...
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^mkdtemp(Sync)?$/]',
          message:
            'Use makeTempDir from fixtures/temp-dir.ts, which removes the folder after the test file.',
        },
        {
          selector: 'ObjectPattern > Property[key.name=/^mkdtemp(Sync)?$/]',
          message:
            'Use makeTempDir from fixtures/temp-dir.ts, which removes the folder after the test file.',
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [jsxA11y.flatConfigs.recommended, reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
    rules: {
      // User text (names, notes from GEDCOM) is untrusted; always render through React escaping.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Do not use dangerouslySetInnerHTML; GEDCOM content is untrusted.',
        },
      ],
    },
  },
  prettier,
);
