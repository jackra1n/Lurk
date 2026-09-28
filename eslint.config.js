import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

// bun run lint checks code; bun run lint:fix applies ESLint's available fixes.
// CI rejects warnings too. Type checking remains in bun run check; these presets
// lint syntax and Svelte semantics without starting a TypeScript project service.
// Biome owns formatting. This compatibility preset only disables formatting rules;
// it does not install or run Prettier, or disable ESLint's correctness checks.
export default defineConfig(
  includeIgnoreFile(fileURLToPath(new URL('./.gitignore', import.meta.url))),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.bun }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }
      ]
    }
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: { parser: ts.parser, svelteConfig }
    }
  },
  {
    files: ['src/lib/components/ui/button/button.svelte'],
    // This anchor primitive accepts external or already-resolved hrefs from its caller.
    rules: { 'svelte/no-navigation-without-resolve': ['error', { ignoreLinks: true }] }
  },
  prettier,
  svelte.configs.prettier
);
