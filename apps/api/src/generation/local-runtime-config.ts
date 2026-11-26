/** Generic local runtime configuration. Acceptance infrastructure supplies the target. */
export type LocalRuntimeTarget = Readonly<{
  primaryPort: number;
  authorityPort: number;
  database: string;
}>;

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/.test(value)) throw new Error('Invalid local runtime target');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('Invalid local runtime target');
  return parsed;
}

function database(env: NodeJS.ProcessEnv): string {
  const value = env['FL_LOCAL_PRIMARY_DATABASE'];
  if (value === undefined) return env['FL_P9_ISOLATED'] === '1' ? 'founders_lens_p9_local' : 'founders_lens_p6_local';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid local runtime target');
  return value;
}

/** Read the only target values the local API needs; no acceptance profile names are understood. */
export function localRuntimeTarget(env: NodeJS.ProcessEnv): LocalRuntimeTarget {
  const isolated = env['FL_P9_ISOLATED'] === '1';
  return Object.freeze({
    primaryPort: port(env, 'FL_LOCAL_PRIMARY_PORT', isolated ? 55435 : 55437),
    authorityPort: port(env, 'FL_LOCAL_AUTHORITY_PORT', isolated ? 55438 : 55436),
    database: database(env)
  });
}

/** Development mode relaxes only the synthetic prompt hash; all authorization remains required. */
export function localDevelopmentEnabled(env: NodeJS.ProcessEnv): boolean {
  const selected = env['FL_P9_LOCAL_DEVELOPMENT'];
  if (selected === undefined) return false;
  if (selected !== '1' || env['NODE_ENV'] === 'production' || env['FL_DEPLOYMENT'] !== undefined ||
    env['FL_P9_ISOLATED'] !== '1' || env['FL_P9_LOCAL_RUNTIME'] !== 'deterministic') {
    throw new Error('Local development profile unavailable');
  }
  return true;
}
