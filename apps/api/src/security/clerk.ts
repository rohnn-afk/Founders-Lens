// Authentication adapter. It verifies Clerk session credentials and returns a
// provider identity for the identity service, leaving local account lookup to that service.

import { createClerkClient } from '@clerk/express';
import type { IncomingHttpHeaders } from 'node:http';
import { bearerToken } from './bearer.js';
import type { ClerkConfig } from './config.js';
import { SecurityError } from './errors.js';
import type { VerifiedIdentity } from './principal.js';

// A JWT is a JSON Web Token carrying claims. The issuer identifies who issued
// it, and the audience identifies the intended recipients. Policy uses claims
// returned by signature verification, never an unverified payload.
function matchesConfiguredAudience(value: unknown, allowed: readonly string[]): boolean {
  const audiences: unknown = typeof value === 'string' ? [value] : value;
  return allowed.length > 0 && Array.isArray(audiences) && audiences.length > 0 &&
    audiences.every((audience: unknown) => typeof audience === 'string' && audience.length > 0) &&
    audiences.some((audience: string) => allowed.includes(audience));
}

export function createClerkBoundary(config: ClerkConfig) {
  const client = createClerkClient({ publishableKey: config.publishableKey, secretKey: config.secretKey, telemetry: { disabled: true },
    ...(config.jwtKey ? { jwtKey: config.jwtKey } : {}) });
  return {
    client,
    async authenticate(headers: IncomingHttpHeaders, rawHeaders: readonly string[]): Promise<VerifiedIdentity> {
      const token = bearerToken(headers, rawHeaders);
      try {
        // A fresh Fetch request excludes cookies, untrusted host/proxy/query and browser
        // navigation headers. SDK response headers are never written to Express.
        const request = new Request('https://founders-lens.invalid/api-auth', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
        });
        const state = await client.authenticateRequest(request, { acceptsToken: 'session_token',
          publishableKey: config.publishableKey, secretKey: config.secretKey, issuer: config.issuer,
          authorizedParties: [...config.authorizedParties], clockSkewInMs: 0,
          ...(config.audience ? { audience: [...config.audience] } : {}),
          ...(config.jwtKey ? { jwtKey: config.jwtKey } : {}) });
        if (state.status !== 'signed-in' || state.tokenType !== 'session_token' || state.headers.has('location')) {
          throw new SecurityError('UNAUTHENTICATED');
        }
        const auth = state.toAuth({ treatPendingAsSignedOut: true });
        // Clerk's signed-in state carries verifyToken()'s verified payload through
        // toAuth(). Never obtain policy claims by decoding the incoming token.
        const claims = auth.sessionClaims;
        if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new SecurityError('UNAUTHENTICATED');
        if (!auth.isAuthenticated || auth.tokenType !== 'session_token' || !auth.userId || !auth.sessionId ||
          !/^user_[A-Za-z0-9_-]{1,250}$/.test(auth.userId) || !/^sess_[A-Za-z0-9_-]{1,250}$/.test(auth.sessionId) ||
          auth.sessionClaims.iss !== config.issuer || !config.authorizedParties.includes(auth.sessionClaims.azp ?? '') ||
          auth.sessionClaims.exp * 1000 <= Date.now()) throw new SecurityError('UNAUTHENTICATED');
        // The SDK skips its audience assertion when aud is absent. Our configured
        // policy requires a present, well-formed claim and an exact allowlist match.
        if (config.audience !== undefined && (!Object.hasOwn(claims, 'aud') ||
          !matchesConfiguredAudience(claims.aud, config.audience))) throw new SecurityError('UNAUTHENTICATED');
        return Object.freeze({ instanceId: config.instanceId, subject: auth.userId,
          sessionId: auth.sessionId, expiresAt: auth.sessionClaims.exp * 1000 });
      } catch (error) {
        if (error instanceof SecurityError) throw error;
        throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      }
    }
  };
}
