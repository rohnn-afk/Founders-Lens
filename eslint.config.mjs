// Static-analysis configuration. ESLint applies typescript-eslint rules and
// web import restrictions before builds, alongside the import-boundary tests.

import tseslint from 'typescript-eslint';

export default [
  // Keep generated output, installed packages, and private local files
  // outside the source traversal.
  {
    ignores: [
      '**/node_modules/**', '**/.next/**', '**/dist/**', '**/next-env.d.ts',
      '.cache/**', '.env*/**', '.worktrees/**', 'private-data/**',
      'Docs/**', 'apps/api/src/generated/prisma/**'
    ]
  },
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
