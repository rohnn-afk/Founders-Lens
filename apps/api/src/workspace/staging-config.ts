/** Validate staging settings before opening a listener or a database pool. */
export function stagingConfig(env: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = env[name];
    if (!value?.trim()) throw new Error('Missing staging setting: ' + name);
    return value;
  };
  if (env['NODE_ENV'] !== 'production' || env['FL_DEPLOYMENT'] !== 'staging' ||
    env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0' ||
    (env['RAILWAY_ENVIRONMENT_NAME'] !== undefined && env['RAILWAY_ENVIRONMENT_NAME'] !== 'staging') ||
    Object.keys(env).some(name => /^(?:FL_P[6789]_|P9_|GROQ_API_KEY$)/.test(name) && env[name])) {
    throw new Error('Staging API configuration conflicts with local or worker configuration');
  }
  const portText = required('PORT');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error('Invalid staging port');
  const origin = required('FL_WEB_ORIGIN');
  const render = env['RENDER'] === 'true';
  const primaryProvider = env['FL_STAGING_PRIMARY_PROVIDER'];
  const neon = primaryProvider === 'neon';
  if (primaryProvider !== undefined && (!neon || !render)) {
    throw new Error('Invalid staging primary provider');
  }
  function parse(name: string) {
    try { return new URL(required(name)); }
    catch { throw new Error('Invalid staging URL: ' + name); }
  }
  if (parse('FL_WEB_ORIGIN').origin !== origin || !origin.startsWith('https://')) {
    throw new Error('Invalid staging web origin');
  }
  function database(name: string, role: string, externalAuthority = false) {
    const url = parse(name);
    const hostAllowed = render
      ? externalAuthority
        ? /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(url.hostname) &&
          !/\.(?:localhost|local|internal)$/.test(url.hostname)
        : neon
          ? /^ep-[a-z0-9-]+(?:\.c-[0-9]+)?\.us-west-2\.aws\.neon\.tech$/.test(url.hostname) &&
            !url.hostname.split('.')[0]?.endsWith('-pooler') && (!url.port || url.port === '5432')
          : /^dpg-[a-z0-9-]+$/.test(url.hostname)
      : /^[a-z0-9-]+\.railway\.internal$/.test(url.hostname);
    const queryAllowed = render && (externalAuthority || neon) ? url.search === '?sslmode=verify-full' : !url.search;
    if (url.protocol !== 'postgresql:' || url.username !== role || !url.password ||
      !hostAllowed || !/^\/[a-zA-Z0-9_]+$/.test(url.pathname) || !queryAllowed || url.hash) {
      throw new Error('Invalid staging database credential: ' + name);
    }
    return url;
  }
  const workspace = database('FL_WORKSPACE_DATABASE_URL', 'fl_p6_workspace');
  const conversations = database('FL_CONVERSATIONS_DATABASE_URL', 'fl_p8_conversations');
  const authority = database('FL_AUTHORITY_DATABASE_URL', 'ledger_reader', true);
  const address = (url: URL) => url.hostname + ':' + (url.port || '5432') + url.pathname;
  const directHost = (url: URL) => {
    const host = url.hostname.replace(/-pooler(?=\.)/, '');
    // Treat both Oregon Neon DNS forms as the same endpoint for separation checks.
    return neon ? host.replace(/^(ep-[a-z0-9-]+)\.c-[0-9]+(?=\.us-west-2\.aws\.neon\.tech$)/, '$1') : host;
  };
  if (workspace.pathname !== '/founders_lens_staging' || address(workspace) !== address(conversations) ||
    directHost(workspace) === directHost(authority)) {
    throw new Error('Staging databases must use separate primary and authority services');
  }
  return { port, origin, workspace, conversations, authority, required, bindHost: render ? '0.0.0.0' : '::' };
}
