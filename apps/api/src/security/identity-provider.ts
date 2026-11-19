import type { ClerkClient } from '@clerk/express';
import { SecurityError } from './errors.js';
import type { VerifiedIdentity } from './principal.js';

export interface IdentityProvider {
  assertLive(identity: VerifiedIdentity): Promise<void>;
}
export class ClerkIdentityProvider implements IdentityProvider {
  constructor(private readonly client: ClerkClient) {}
  async assertLive(identity: VerifiedIdentity): Promise<void> {
    try {
      const [user, session] = await Promise.all([
        this.client.users.getUser(identity.subject), this.client.sessions.getSession(identity.sessionId)
      ]);
      if (user.id !== identity.subject || session.userId !== identity.subject || session.id !== identity.sessionId ||
        session.status !== 'active' || !Number.isFinite(session.expireAt) ||
        session.expireAt <= Date.now()) throw new SecurityError('UNAUTHENTICATED');
      if (user.banned || user.locked) throw new SecurityError('ACCOUNT_UNAVAILABLE');
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
        throw new SecurityError('UNAUTHENTICATED');
      }
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
  }
}
