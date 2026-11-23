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
