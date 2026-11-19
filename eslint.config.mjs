// Static-analysis configuration. ESLint applies typescript-eslint rules and
// web import restrictions before builds, alongside the import-boundary tests.

import tseslint from 'typescript-eslint';

export default [
  // Lint the maintained source. Generated output and installed packages
  // are checked through their owning tools and build steps.
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '.cache/**', 'Docs/**', '**/next-env.d.ts', 'apps/api/src/generated/prisma/**'] },
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
