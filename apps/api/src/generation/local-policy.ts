/** A conservative development budget derived from an explicitly selected tariff. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const limit = z.string().regex(/^[1-9][0-9]{0,11}$/).transform(Number);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const generationReservationTokens = 4608;
const modelBudgets = {
  'gemini-3.1-flash-lite': { reservation: generationReservationTokens, maximumRateFloor: 1_500_000 },
  // 4,096 prompt bytes + 128 chat-framing allowance + 1,024 completion tokens.
  'openai/gpt-oss-20b': { reservation: 5248, maximumRateFloor: 300_000 }
} as const;
const config = z.strictObject({
  model: z.enum(['gemini-3.1-flash-lite', 'openai/gpt-oss-20b']),
  priceVersion: z.string().regex(/^v1:[a-z0-9-]{1,50}$/),
  // The current paid standard output tariff (including thinking) is the
  // highest rate for this text-only request. Never accept a lower estimate.
  maximumMicrosPerMillionTokens: limit,
  budgetMicros: limit,
  tokenBudget: limit,
  requestsPerMinute: limit.pipe(z.number().max(60)),
  maximumAdmissions: limit.pipe(z.number().max(100)),
  accountId: z.uuid(),
  conversationId: z.uuid(),
  syntheticTextSha256: digest
});

/** Both API and worker resolve the same model. Existing local Gemini configs retain their behavior. */
export function localGenerationModel(env: NodeJS.ProcessEnv) {
  if (env['FL_P9_PROVIDER'] === 'groq' && env['P9_GROQ_MODEL'] === 'openai/gpt-oss-20b') return env['P9_GROQ_MODEL'];
  if ((env['FL_P9_PROVIDER'] === undefined || env['FL_P9_PROVIDER'] === 'gemini') &&
    env['P9_GEMINI_MODEL'] === 'gemini-3.1-flash-lite') return env['P9_GEMINI_MODEL'];
  throw new Error('Unsupported local generation provider or model');
}

/** Count released, settled and unresolved admission rows toward the invocation cap.
 * A dedicated synthetic account's budget stays consumed across runtime restarts.
 */
export function localGenerationPolicy(input: unknown) {
  const options = config.parse(input);
  const { reservation, maximumRateFloor } = modelBudgets[options.model];
  if (options.maximumMicrosPerMillionTokens < maximumRateFloor ||
    (options.model === 'openai/gpt-oss-20b' && options.priceVersion !== 'v1:groq-gpt-oss-20b')) {
    throw new Error('Invalid local generation tariff');
  }
  // Price every token at the highest configured marginal rate, regardless of direction.
  // An unresolved call consumes its full reservation under this same bound.
  const equivalentTokens = BigInt(options.budgetMicros) * 1_000_000n / BigInt(options.maximumMicrosPerMillionTokens);
  const quotaUnits = Number(equivalentTokens < BigInt(options.tokenBudget) ? equivalentTokens : BigInt(options.tokenBudget));
  if (quotaUnits < reservation || quotaUnits > 99_999_999_999) throw new Error('Invalid local generation budget');
  return {
    policy: { unit: 'tokens', operationType: 'generation', quotaUnits, reservationUnits: reservation,
      requestsPerMinute: options.requestsPerMinute, maximumAdmissions: options.maximumAdmissions,
      currentTurnBytes: 1200, deadlineMs: 60_000, receiptTtlMs: 300_000 },
    /** Bind admission to the operator-approved exact synthetic text and owned conversation. */
    allows(accountId: string, conversationId: string, content: string) {
      return accountId === options.accountId && conversationId === options.conversationId &&
        createHash('sha256').update(content).digest('hex') === options.syntheticTextSha256;
    }
  };
}
