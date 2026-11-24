import type { Pool } from 'pg';
import { z } from 'zod';
import { createRuntimeRecoveryClearance } from '../privacy/runtime-recovery-clearance.js';
import { SecurityError } from '../security/errors.js';

const pairSchema = z.strictObject({
  FL_STAGING_IDEAS_DECISION: z.string().min(1).max(2300),
  FL_STAGING_TRANSCRIPT_DECISION: z.string().min(1).max(2300)
});

export function stagingDecisions(
  load: () => Promise<unknown>,
  shared: Omit<Parameters<typeof createRuntimeRecoveryClearance>[0], 'primary' | 'purpose' | 'decision'>,
  primary: Pool,
  conversations: Pool
) {
  return async () => {
    try {
      const pair = pairSchema.parse(await load());
      const [ideas, transcript] = await Promise.all([
        createRuntimeRecoveryClearance({ ...shared, primary, decision: pair.FL_STAGING_IDEAS_DECISION,
          purpose: 'founders-lens:staging-workspace:read-only' }).verifiedDecision(),
        createRuntimeRecoveryClearance({ ...shared, primary: conversations, decision: pair.FL_STAGING_TRANSCRIPT_DECISION,
          purpose: 'founders-lens:staging-workspace:read-conversations' }).verifiedDecision()
      ]);
      if (ideas.primaryTarget !== transcript.primaryTarget || ideas.recoveryRun !== transcript.recoveryRun ||
        ideas.inventoryDigest !== transcript.inventoryDigest || ideas.issuedAt !== transcript.issuedAt ||
        ideas.expiresAt !== transcript.expiresAt || Date.now() >= ideas.expiresAt) throw new Error('Inconsistent staging pair');
      return ideas.expiresAt;
    } catch {
      throw new SecurityError('DEPENDENCY_UNAVAILABLE');
    }
  };
}
