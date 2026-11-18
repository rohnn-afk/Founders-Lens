export interface DatabaseConfig {
  readonly connectionString: string;
}

// This foundation is intentionally limited to the two isolated local databases.
// Migration-owner and infrastructure credentials are never runtime identities.
export function databaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const value = environment['DATABASE_URL'];
  if (!value) throw new Error('Restricted local DATABASE_URL is required');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid restricted database configuration'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55432' ||
    url.username !== 'fl_m02_runtime' || !/^[a-f0-9]{64}$/.test(url.password) ||
    !['/founders_lens_m02_dev', '/founders_lens_m02_test'].includes(url.pathname) ||
    url.hash || url.search !== '?schema=public') {
    throw new Error('Invalid restricted database configuration');
  }
  return { connectionString: value };
}
