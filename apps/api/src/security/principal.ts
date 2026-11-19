// Security boundary types. The authentication adapter creates a verified provider
// identity, and the identity service adds the local account context for authorization.

import type { SubjectKey } from './subject-key.js';

export interface VerifiedIdentity {
  readonly instanceId: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly expiresAt: number;
}
// A principal is the server's representation of the authenticated caller.
// The local account ID scopes application data independently of the provider subject.
export interface Principal {
  readonly localUserId: string;
  readonly clerkInstanceId: string;
  readonly clerkSubject: string;
  readonly sessionId: string;
  readonly accountStatus: 'ACTIVE';
  readonly requestId: string;
  readonly subjectKeys: readonly SubjectKey[];
}
