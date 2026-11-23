/** Browser-visible origins. Hosted deployments must provide both exact HTTPS origins. */
export function workspaceEndpoints(environment = {
  frontend: process.env.NEXT_PUBLIC_FL_WEB_ORIGIN,
  api: process.env.NEXT_PUBLIC_FL_API_ORIGIN
}) {
  const { frontend, api } = environment;
  if (frontend === undefined && api === undefined) {
    return { origin: 'http://127.0.0.1:3000', api: 'http://127.0.0.1:3001/api/v1' };
  }
  if (!frontend || !api || ![frontend, api].every(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && value === url.origin;
    } catch {
      return false;
    }
  })) throw new Error('Invalid public workspace origins');
  return { origin: frontend, api: api + '/api/v1' };
}
