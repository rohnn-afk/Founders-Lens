// Next.js request boundary for Clerk. Establishes session state for the
// sign-in and workspace routes while Express retains its own verification.
import { clerkMiddleware } from '@clerk/nextjs/server';
import type { NextFetchEvent, NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { publicDemo } from './app-mode';

function authorizedParties(): string[] | undefined {
  try {
    const parties: unknown = JSON.parse(process.env.CLERK_AUTHORIZED_PARTIES ?? 'null');
    if (Array.isArray(parties) && parties.length > 0 && parties.length <= 16 &&
      parties.every((origin: unknown): origin is string => {
        if (typeof origin !== 'string') return false;
        const url = new URL(origin);
        return url.origin === origin && (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) &&
            process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_') === true));
      })) return parties;
  } catch {
    // Do not expose malformed configuration values in the response.
  }
}

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (publicDemo) {
    return new NextResponse('This route is unavailable in the public demo.', {
      status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
  // Local builds without keys must still serve the public shell. The workspace
  // layout independently gates rendering, including on routes matched here.
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return NextResponse.next();
  }
  const parties = authorizedParties();
  if (!parties) {
    return new NextResponse('Sign-in configuration is unavailable.', {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
  const response = await clerkMiddleware({ signInUrl: '/sign-in', authorizedParties: parties })(request, event);
  const url = new URL(request.url);
  const loopback = new URL(url.href);
  loopback.hostname = '127.0.0.1';
  // Next normalizes the loopback request URL to localhost. Clerk's no-op
  // rewrite then looks external to the router bound to 127.0.0.1. Resume
  // routing in-process and keep Clerk's authenticated request headers.
  if (response instanceof Response && url.protocol === 'http:' && url.hostname === 'localhost' &&
      request.headers.get('host') === loopback.host && parties.includes(loopback.origin) &&
      response.headers.get('x-middleware-rewrite') === url.href) {
    response.headers.delete('x-middleware-rewrite');
    response.headers.set('x-middleware-next', '1');
  }
  return response;
}

export const config = { matcher: ['/app/:path*', '/sign-in/:path*', '/__clerk/:path*'] };
