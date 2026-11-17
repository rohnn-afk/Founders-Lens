import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '.cache/**', 'Docs/**', '**/next-env.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['node:*', '**/api/**', '**/worker/**', '**/dispatcher/**'],
        paths: ['express', 'helmet', 'zod']
      }]
    }
  }
];
