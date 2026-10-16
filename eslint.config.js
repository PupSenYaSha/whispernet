import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // `site/**` is not in here. It used to be, which meant `site/script.js` - the only script on the public
    // marketing surface, the one place a stray `=` or an undefined name is a bug every visitor can reach -
    // got no static analysis at all while `src/` did. The block further down gives it browser globals
    // instead.
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'android/**', 'data/**', 'build/**'],
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
    files: ['server/**/*.ts', 'scripts/**/*.{js,cjs,mjs}', 'tests/**/*.{ts,tsx}'],
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
  {
    // The public marketing site: plain script in a browser, no bundler and no framework.
    //
    // `js.configs.recommended` only, on purpose. It is applied globally above, so everything in here is
    // already on; this block adds the environment and nothing else. Adding the project rule set as well
    // would mean either fixing the site to satisfy rules written for a React codebase, or narrowing the
    // block until it was the same thing - and a block that needs rules removed to be useful is a block
    // nobody maintains. `no-undef` is what actually matters here, and it needs the browser globals to mean
    // anything: `document`, `window` and `localStorage` are the whole vocabulary of that file.
    files: ['site/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      sourceType: 'script',
    },
    rules: {
      'no-empty': 'off',
      // Turned off here rather than configured, and the findings that motivated it are named so this is not
      // a blanket: `currentLang` is written by `setLang` and read by nobody, and four `catch (_)` bindings
      // need `caughtErrors: 'none'`, which `argsIgnorePattern` does not cover. Both are that file's business
      // rather than this block's - it exists so the site's script is parsed and its globals resolve, which is
      // what catches a typo'd `document.getElementById` or a stray identifier.
      //
      // The typescript-eslint copy is the one that fires, because `...tseslint.configs.recommended` is
      // applied to every file in the repository including these. Both are off: leaving one on would leave
      // half the rule's output behind.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
