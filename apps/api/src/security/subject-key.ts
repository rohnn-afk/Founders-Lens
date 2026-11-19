import { createHmac } from 'node:crypto';
import { SecurityError } from './errors.js';

export interface SubjectKey { readonly version: number; readonly digest: string }
export class SubjectKeys {
  private readonly keys: ReadonlyMap<number, Buffer>;
  constructor(readonly currentVersion: number, versions: ReadonlyMap<number, Buffer>) {
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || !versions.has(currentVersion) ||
      versions.size === 0 || versions.size > 16 || [...versions].some(([version, key]) =>
        !Number.isSafeInteger(version) || version < 1 || key.length < 32)) throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    this.keys = new Map([...versions].map(([version, key]) => [version, Buffer.from(key)]));
  }
  derive(instanceId: string, subject: string): readonly SubjectKey[] {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId) || !/^user_[A-Za-z0-9_-]{1,250}$/.test(subject)) {
      throw new SecurityError('UNAUTHENTICATED');
    }
    // Versioned, unambiguous tuple encoding; raw subjects never enter logs or receipts.
    const input = JSON.stringify(['founders-lens-identity', 1, instanceId, subject]);
    return Object.freeze([...this.keys].map(([version, key]) => Object.freeze({ version,
      digest: createHmac('sha256', key).update(input, 'utf8').digest('hex') })));
  }
}

export function subjectLock(instanceId: string, subject: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId) || !/^user_[A-Za-z0-9_-]{1,250}$/.test(subject)) {
    throw new SecurityError('UNAUTHENTICATED');
  }
  // Shared by provisioning, future webhook acceptance and deletion: fixed seed 0.
  return instanceId + '\u001f' + subject;
}
