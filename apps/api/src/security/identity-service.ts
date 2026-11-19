// Identity orchestration layer. It takes a verified provider identity, checks
// liveness and suppression, then asks the repository for a local principal.

import type { IdentityProvider } from './identity-provider.js';
import type { IdentityRepository } from './identity-repository.js';
import type { Principal, VerifiedIdentity } from './principal.js';
import { SecurityError } from './errors.js';
import { SubjectKeys } from './subject-key.js';
import { requireClearance } from './suppression-authority.js';
import type { SuppressionAuthority } from './suppression-authority.js';

export class IdentityService {
  // Dependency injection supplies the provider, repository, and suppression
  // port from outside the service so orchestration can be tested in isolation.
  constructor(private readonly instanceId: string, private readonly keys: SubjectKeys,
    private readonly provider: IdentityProvider, private readonly repository: IdentityRepository,
    private readonly suppression: SuppressionAuthority) {}
  async resolve(identity: VerifiedIdentity, requestId: string): Promise<Principal> {
    if (identity.instanceId !== this.instanceId || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= Date.now()) {
      throw new SecurityError('UNAUTHENTICATED');
    }
    const keys = this.keys.derive(identity.instanceId, identity.subject);
    const check = async () => {
      for (const key of keys) await requireClearance(this.suppression, { kind: 'ACCOUNT', instanceId: identity.instanceId,
        subjectKeyVersion: key.version, subjectKey: key.digest, incarnation: 'ALL' });
    };
    await check();
    try { await this.provider.assertLive(identity); }
    catch (error) { throw error instanceof SecurityError ? error : new SecurityError('DEPENDENCY_UNAVAILABLE'); }
    // Provider I/O may take time. Request new evidence; never reuse negative results.
    await check();
    if (identity.expiresAt <= Date.now()) throw new SecurityError('UNAUTHENTICATED');
    const account = await this.repository.resolve(identity, keys, this.keys.currentVersion);
    if (account.status !== 'ACTIVE') throw new SecurityError('ACCOUNT_UNAVAILABLE');
    return Object.freeze({ localUserId: account.id, clerkInstanceId: identity.instanceId,
      clerkSubject: identity.subject, sessionId: identity.sessionId, accountStatus: 'ACTIVE', requestId, subjectKeys: keys });
  }
}
