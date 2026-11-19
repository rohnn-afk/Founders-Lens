import type { SubjectKey } from './subject-key.js';

export interface VerifiedIdentity {
  readonly instanceId: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly expiresAt: number;
}
export interface Principal {
  readonly localUserId: string;
  readonly clerkInstanceId: string;
  readonly clerkSubject: string;
  readonly sessionId: string;
  readonly accountStatus: 'ACTIVE';
  readonly requestId: string;
  readonly subjectKeys: readonly SubjectKey[];
}
