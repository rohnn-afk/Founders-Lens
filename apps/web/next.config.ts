// Web framework configuration. Next.js reads these options at startup and
// build time to configure response headers and React's development checks.

import type { NextConfig } from 'next';

// React Strict Mode helps surface unsafe rendering and effect assumptions
// during development. Its extra checks are separate from TypeScript checking.
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Keep route availability fixed even if runtime settings drift.
  env: { FL_WEB_BUILD_MODE: process.env.FL_PUBLIC_DEMO === 'true' ? 'demo' : 'workspace' }
};

export default config;
