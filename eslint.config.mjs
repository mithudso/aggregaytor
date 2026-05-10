import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const sharedGlobals = {
  AbortController: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  CustomEvent: 'readonly',
  DOMParser: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  HTMLElement: 'readonly',
  IDBKeyRange: 'readonly',
  KeyboardEvent: 'readonly',
  MutationObserver: 'readonly',
  MouseEvent: 'readonly',
  Node: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  chrome: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  globalThis: 'readonly',
  indexedDB: 'readonly',
  localStorage: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  process: 'readonly',
  self: 'readonly',
  sessionStorage: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  window: 'readonly',
};

export default [
  {
    ignores: [
      '**/.claude/**',
      '**/.copilot/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/files/**',
      '**/vendor/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: sharedGlobals,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: sharedGlobals,
    },
  },
];
