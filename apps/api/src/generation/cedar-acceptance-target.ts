/** Fixed loopback endpoints for the opt-in Cedar Desk acceptance environment. */
export const cedarAcceptanceTarget = Object.freeze({
  primaryPort: 55441,
  authorityPort: 55442,
  redisPort: 56383,
  database: 'founders_lens_cedar_acceptance'
});

export const cedarRecheckTarget = Object.freeze({
  primaryPort: 55443,
  authorityPort: 55444,
  redisPort: 56384,
  database: 'founders_lens_cedar_recheck'
});

export const offlineAcceptanceTarget = Object.freeze({
  primaryPort: 55445,
  authorityPort: 55446,
  redisPort: 56385,
  database: 'founders_lens_offline_acceptance'
});

/** The offline profile can only use new local stores and the deterministic provider. */
export function offlineAcceptanceEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env['FL_P9_OFFLINE_ACCEPTANCE'] === undefined) return false;
  if (env['FL_P9_OFFLINE_ACCEPTANCE'] !== '1' || env['NODE_ENV'] === 'production' || env['FL_DEPLOYMENT'] !== undefined ||
    env['FL_P9_LOCAL_RUNTIME'] !== 'deterministic' || env['FL_P9_ISOLATED'] !== '1' || env['FL_P9_DISPOSABLE'] !== undefined ||
    env['FL_P9_CEDAR_ACCEPTANCE'] !== undefined || env['FL_P9_PROVIDER'] !== undefined ||
    env['P9_GEMINI_API_KEY'] || env['GROQ_API_KEY']) {
    throw new Error('Offline acceptance profile unavailable');
  }
  return true;
}

/** Keep the acceptance profile local and Groq-only. Compositions still verify signed live identities. */
export function cedarAcceptanceEnabled(env: NodeJS.ProcessEnv): boolean {
  const selected = env['FL_P9_CEDAR_ACCEPTANCE'];
  if (selected === undefined) return false;
  if ((selected !== '1' && selected !== '2') || env['NODE_ENV'] === 'production' || env['FL_P9_ISOLATED'] !== '1' ||
    env['FL_P9_DISPOSABLE'] === '1' || env['FL_P9_PROVIDER'] !== 'groq' ||
    env['P9_GROQ_MODEL'] !== 'openai/gpt-oss-20b' || env['P9_GEMINI_API_KEY'] || env['GROQ_API_KEY']) {
    throw new Error('Cedar acceptance profile unavailable');
  }
  return true;
}
