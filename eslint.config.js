import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'android/**', 'site/**', 'data/**', 'build/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // the websocket handlers and the reducer legitimately touch a mutable state object
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // best effort cleanup is written as an empty block throughout this codebase
      'no-empty': 'off',
    },
  },
  {
    files: ['server/**/*.ts', 'scripts/**/*.{js,cjs}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': 'off',
      // stripping control characters and matching emoji are the point of those regexes
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      // the integration tests drive a real server, which needs a dynamic import
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    rules: {
      // these run under CommonJS on purpose
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // the service worker is not a module and runs in a worker scope
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
);
