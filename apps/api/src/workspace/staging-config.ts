/** Validate staging settings before opening a listener or a database pool. */
export function stagingConfig(env: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = env[name];
    if (!value?.trim()) throw new Error('Missing staging setting: ' + name);
    return value;
  };
  if (env['NODE_ENV'] !== 'production' || env['FL_DEPLOYMENT'] !== 'staging' ||
    (env['RAILWAY_ENVIRONMENT_NAME'] !== undefined && env['RAILWAY_ENVIRONMENT_NAME'] !== 'staging') ||
    Object.keys(env).some(name => /^(?:FL_P[6789]_|P9_|GROQ_API_KEY$)/.test(name) && env[name])) {
    throw new Error('Staging API configuration conflicts with local or worker configuration');
  }
  const portText = required('PORT');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error('Invalid staging port');
  const origin = required('FL_WEB_ORIGIN');
  function parse(name: string) {
    try { return new URL(required(name)); }
    catch { throw new Error('Invalid staging URL: ' + name); }
  }
  if (parse('FL_WEB_ORIGIN').origin !== origin || !origin.startsWith('https://')) {
    throw new Error('Invalid staging web origin');
  }
  function database(name: string, role: string) {
    const url = parse(name);
    if (url.protocol !== 'postgresql:' || url.username !== role || !url.password ||
      !/^[a-z0-9-]+\.railway\.internal$/.test(url.hostname) ||
      !/^\/[a-zA-Z0-9_]+$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('Invalid staging database credential: ' + name);
    }
    return url;
  }
  const workspace = database('FL_WORKSPACE_DATABASE_URL', 'fl_p6_workspace');
  const conversations = database('FL_CONVERSATIONS_DATABASE_URL', 'fl_p8_conversations');
  const authority = database('FL_AUTHORITY_DATABASE_URL', 'ledger_reader');
  const address = (url: URL) => url.hostname + ':' + (url.port || '5432') + url.pathname;
  if (workspace.pathname !== '/founders_lens_staging' || address(workspace) !== address(conversations) ||
    workspace.hostname === authority.hostname) {
    throw new Error('Staging databases must use separate primary and authority services');
  }
  return { port, origin, workspace, conversations, authority, required };
}
