import { workspaceEndpoints } from '../../../features/workspace/endpoints';

import { publicDemo } from '../../../app-mode';

/** Check the configured API without forwarding Clerk credentials. */
export async function GET() {
  if (publicDemo) return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  let ready = false;
  try {
    const webOrigin = process.env.NEXT_PUBLIC_FL_WEB_ORIGIN;
    const apiOrigin = process.env.NEXT_PUBLIC_FL_API_ORIGIN;
    const publicKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const hasSecretKey = !!process.env.CLERK_SECRET_KEY;
    const parties: unknown = JSON.parse(process.env.CLERK_AUTHORIZED_PARTIES ?? 'null');
    if (!webOrigin || !apiOrigin || !publicKey?.startsWith('pk_') ||
      !hasSecretKey ||
      !Array.isArray(parties) || parties.length !== 1 || parties[0] !== webOrigin) throw new Error();
    workspaceEndpoints({ frontend: webOrigin, api: apiOrigin });
    const response = await fetch(new URL('/health/ready', apiOrigin), {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2500)
    });
    ready = response.status === 200;
  } catch {
    // No dependency details or configuration values belong in the probe.
  }
  return new Response(null, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
