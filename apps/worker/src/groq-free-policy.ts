/** Local Free-tier policy. Account observations must come from the key's organization. */
type Limits = { rpm: number; rpd: number; tpm: number; tpd: number };
export type FreeGroqModel = 'openai/gpt-oss-20b' | 'openai/gpt-oss-120b';
export type FreeGroqPolicy = {
  model: FreeGroqModel; effort: 'low' | 'medium'; inputTokens: number; completionTokens: number; limits: Limits;
};

export function freeGroqPolicy(env: NodeJS.ProcessEnv): FreeGroqPolicy {
  if (env['FL_DEPLOYMENT'] !== undefined || env['NODE_ENV'] === 'production' ||
    env['FL_P9_ISOLATED'] !== '1' || env['FL_GROQ_ORG_PLAN'] !== 'free') {
    throw new Error('Verified local Groq Free organization configuration required');
  }
  const model = env['FL_GROQ_FREE_MODEL'] ?? 'openai/gpt-oss-20b';
  const effort = env['FL_GROQ_FREE_REASONING'] ?? 'low';
  if ((model !== 'openai/gpt-oss-20b' && model !== 'openai/gpt-oss-120b') || (effort !== 'low' && effort !== 'medium')) {
    throw new Error('Unsupported Groq Free model or reasoning level');
  }
  function number(name: string, fallback?: number) {
    const raw = env[name];
    if (raw === undefined && fallback !== undefined) return fallback;
    if (!raw || !/^[1-9][0-9]{0,8}$/.test(raw)) throw new Error('Invalid or missing Groq Free limit');
    return Number(raw);
  }
  function limit(name: string, baseline: number) {
    return Math.min(number('FL_GROQ_ORG_' + name), number('FL_GROQ_APP_' + name, baseline), baseline);
  }
  const limits = { rpm: limit('RPM', 10), rpd: limit('RPD', 40), tpm: limit('TPM', 6000), tpd: limit('TPD', 120000) };
  const inputTokens = Math.min(1800, number('FL_GROQ_APP_INPUT', 1800));
  const completionTokens = Math.min(1200, number('FL_GROQ_APP_COMPLETION', 1200));
  if (inputTokens + completionTokens > Math.min(limits.tpm, limits.tpd)) throw new Error('Groq Free reservation exceeds quota');
  return { model, effort, inputTokens, completionTokens, limits };
}
