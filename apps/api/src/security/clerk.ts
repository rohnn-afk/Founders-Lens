// Authentication adapter. It verifies Clerk session credentials and returns a
// provider identity for the identity service, leaving local account lookup to that service.

import { createClerkClient } from '@clerk/express';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { bearerToken } from './bearer.js';
import type { ClerkConfig } from './config.js';
import { SecurityError } from './errors.js';
import { ClerkIdentityProvider } from './identity-provider.js';
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

const deletionFreshnessMs = 5 * 60_000;
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reverificationRecord = z.object({
  id: z.string(), session_id: z.string(), user_id: z.string(),
  status: z.enum(['needs_first_factor', 'needs_second_factor', 'complete']),
  level: z.enum(['first_factor', 'second_factor', 'multi_factor']),
  created_at: timestamp, updated_at: timestamp,
  first_factor_verified_at: timestamp.nullable(), second_factor_verified_at: timestamp.nullable()
});

/** Verified completion for one session. The admission transaction must consume
 * the challenge durably against the authorized deletion scope and policy. */
export interface VerifiedDeletionReverification {
  readonly identity: VerifiedIdentity;
  readonly challengeId: string;
  readonly validUntil: number;
}

/** Read the exact signed challenge from Clerk. Provider failure yields only a sanitized error. */
async function readReverification(secretKey: string, sessionId: string, challengeId: string) {
  try {
    // The SDK does not expose this lookup. Keep the destination fixed and refuse redirects.
    const response = await fetch(
      'https://api.clerk.com/v1/sessions/' + encodeURIComponent(sessionId) +
      '/reverifications/' + encodeURIComponent(challengeId), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Bearer ' + secretKey, 'Clerk-API-Version': '2026-05-12', Accept: 'application/json' }
      });
    if (response.status === 404) throw new SecurityError('UNAUTHENTICATED');
    if (!response.ok) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    return reverificationRecord.parse(await response.json());
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError('DEPENDENCY_UNAVAILABLE');
  }
}

/** Compose ordinary session authentication and an explicit destructive-action verifier. */
export function createClerkBoundary(config: ClerkConfig) {
  const client = createClerkClient({ publishableKey: config.publishableKey, secretKey: config.secretKey, telemetry: { disabled: true },
    ...(config.jwtKey ? { jwtKey: config.jwtKey } : {}) });
  const provider = new ClerkIdentityProvider(client);
  /** Verify a bearer once and keep its signed claims inside this boundary. */
  async function verifySession(headers: IncomingHttpHeaders, rawHeaders: readonly string[]) {
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
      const identity: VerifiedIdentity = Object.freeze({ instanceId: config.instanceId, subject: auth.userId,
        sessionId: auth.sessionId, expiresAt: auth.sessionClaims.exp * 1000 });
      return { identity, claims };
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
  }
  return {
    client,
    async authenticate(headers: IncomingHttpHeaders, rawHeaders: readonly string[]): Promise<VerifiedIdentity> {
      return (await verifySession(headers, rawHeaders)).identity;
    },
    /**
     * Require a live session and the exact completed provider challenge.
     * MFA policy must come from trusted server-side authorization, never request input.
     * This proves authentication only. It neither authorizes a scope nor consumes the ID.
     */
    async verifyDeletionReverification(headers: IncomingHttpHeaders, rawHeaders: readonly string[],
      policy: { readonly requireMfa: boolean }): Promise<VerifiedDeletionReverification> {
      if (typeof policy?.requireMfa !== 'boolean') throw new SecurityError('DEPENDENCY_UNAVAILABLE');
      const requireMfa = policy.requireMfa;
      const { identity, claims } = await verifySession(headers, rawHeaders);
      const challengeId = claims.reverification_id;
      const ages = claims.fva;
      const freshAge = (age: unknown) => typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 5;
      if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{1,250}$/.test(challengeId) ||
        !Array.isArray(ages) || ages.length !== 2 || !freshAge(ages[0]) ||
        !(ages[1] === -1 || (Number.isSafeInteger(ages[1]) && ages[1] >= 0)) ||
        (requireMfa && !freshAge(ages[1]))) throw new SecurityError('UNAUTHENTICATED');

      await provider.assertLive(identity);
      const record = await readReverification(config.secretKey, identity.sessionId, challengeId);
      const now = Date.now();
      const first = record.first_factor_verified_at;
      const second = record.second_factor_verified_at;
      // A new ID and recent signed factor ages can refer to an abandoned challenge
      // and an earlier verification. Provider timestamps must belong to this challenge.
      if (record.id !== challengeId || record.session_id !== identity.sessionId || record.user_id !== identity.subject ||
        record.status !== 'complete' || (requireMfa ? record.level !== 'multi_factor' : record.level === 'second_factor') ||
        record.updated_at > now || first === null || first < record.created_at || first > record.updated_at ||
        (second !== null && (second < first || second > record.updated_at)) ||
        ((requireMfa || record.level === 'multi_factor') && second === null)) throw new SecurityError('UNAUTHENTICATED');
      const validUntil = Math.min(identity.expiresAt, first + deletionFreshnessMs,
        requireMfa && second !== null ? second + deletionFreshnessMs : Infinity);
      if (validUntil <= now) throw new SecurityError('UNAUTHENTICATED');
      return Object.freeze({ identity, challengeId, validUntil });
    }
  };
}
