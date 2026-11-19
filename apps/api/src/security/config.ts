import { createPublicKey } from 'node:crypto';
import { SecurityError } from './errors.js';

export interface ClerkConfig {
  readonly instanceId: string;
  readonly issuer: string;
  readonly authorizedParties: readonly string[];
  readonly audience?: readonly string[];
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly jwtKey?: string;
}

// Only explicitly configured instances are trusted. No defaults from request headers.
export function clerkConfig(environment: NodeJS.ProcessEnv): ClerkConfig {
  try {
    const instanceId = environment['CLERK_INSTANCE_ID'] ?? '';
    const issuer = environment['CLERK_ISSUER'] ?? '';
    const publishableKey = environment['CLERK_PUBLISHABLE_KEY'] ?? '';
    const secretKey = environment['CLERK_SECRET_KEY'] ?? '';
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId) ||
      !/^pk_(test|live)_[A-Za-z0-9=+/_-]+$/.test(publishableKey) ||
      !/^sk_(test|live)_[A-Za-z0-9_-]+$/.test(secretKey)) throw new Error();
    if (publishableKey.split('_')[1] !== secretKey.split('_')[1]) throw new Error();
    const parsedIssuer = new URL(issuer);
    if (parsedIssuer.protocol !== 'https:' || parsedIssuer.origin !== issuer) throw new Error();
    const keyHost = Buffer.from(publishableKey.replace(/^pk_(test|live)_/, ''), 'base64').toString('utf8');
    if (keyHost !== parsedIssuer.host + '$') throw new Error();
    const parties: unknown = JSON.parse(environment['CLERK_AUTHORIZED_PARTIES'] ?? 'null');
    if (!Array.isArray(parties) || parties.length === 0 || parties.length > 16 ||
      !parties.every((party: unknown) => typeof party === 'string' && party.length <= 2048 && !party.includes('*') &&
        new URL(party).origin === party && (party.startsWith('https://') ||
          (party.startsWith('http://') && publishableKey.startsWith('pk_test_') &&
            ['127.0.0.1', 'localhost'].includes(new URL(party).hostname))))) throw new Error();
    const audience: unknown = environment['CLERK_AUDIENCE'] ? JSON.parse(environment['CLERK_AUDIENCE']) : undefined;
    if (audience !== undefined && (!Array.isArray(audience) || audience.length === 0 || audience.length > 16 ||
      !audience.every((value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2048))) throw new Error();
    const jwtKey = environment['CLERK_JWT_KEY'];
    if (jwtKey && createPublicKey(jwtKey).asymmetricKeyType !== 'rsa') throw new Error();
    return Object.freeze({ instanceId, issuer, publishableKey, secretKey,
      authorizedParties: Object.freeze([...parties] as string[]),
      ...(audience ? { audience: Object.freeze([...audience] as string[]) } : {}), ...(jwtKey ? { jwtKey } : {}) });
  } catch { throw new SecurityError('DEPENDENCY_UNAVAILABLE'); }
}
