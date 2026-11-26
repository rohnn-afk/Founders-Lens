// Only checked-in synthetic prompts can reach the evaluation transport.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { founderPrompt } from '../apps/worker/dist/founder-provider.js';
import { freeGroqPolicy } from '../apps/worker/dist/groq-free-policy.js';
import { openGroqFreeQuota } from '../apps/worker/dist/groq-free-quota.js';
import { groqFounderProvider } from '../apps/worker/dist/groq-provider.js';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
export async function evaluateSyntheticCase(entry, provider) {
  const turn = (text, id) => ({ id: String(id), text, truncated: false });
  const previous = (entry.previous ?? []).map((text, index) => ({ user: turn(text, index) }));
  const input = founderPrompt({ current: turn(entry.prompt, previous.length), previous, memory: [] });
  const response = await provider.generate(input, AbortSignal.timeout(10_000));
  const schemaValid = Boolean(response.text && response.assistantContent);
  return { schemaValid, quality: schemaValid ? 'pending-human-review' : 'not-evaluated',
    lookFor: entry.lookFor, usage: response.usage, text: response.text, assistantContent: response.assistantContent };
}

async function main() {
const [mode, selected, ...extra] = process.argv.slice(2);
if (mode === '--live' && !selected) {
  console.error('Live evaluation requires one case ID. Use --dry-run to list available cases.');
  process.exit(1);
}
let limiter;
try {
  if (!['--dry-run', '--live'].includes(mode) || extra.length) throw new Error('Invalid evaluation mode');
  const cases = JSON.parse(await read('tests/fixtures/p9-founder-evaluation.json'));
  const selectedCases = selected ? cases.filter(item => item.id === selected) : cases;
  if (!selectedCases.length) throw new Error('Unknown synthetic evaluation case');
  if (mode === '--dry-run') {
    for (const entry of selectedCases) console.log(JSON.stringify({ id: entry.id, lookFor: entry.lookFor }));
  } else {
    if (process.env.FL_DEPLOYMENT !== undefined || process.env.NODE_ENV === 'production') throw new Error('Local evaluation required');
    const operator = parseEnv(await read('.env.groq-free.local'));
    const policy = freeGroqPolicy({ ...operator, FL_P9_ISOLATED: '1' });
    const broker = new URL(parseEnv(await read('.env.p9-offline-worker.local')).FL_P9_REDIS_URL);
    if (broker.protocol !== 'redis:' || broker.hostname !== '127.0.0.1' || broker.port !== '56385' ||
      broker.pathname !== '/0' || broker.username || !broker.password || broker.hash || broker.search) {
      throw new Error('Approved isolated Redis required');
    }
    limiter = await openGroqFreeQuota(broker, operator.FL_GROQ_ORGANIZATION_SCOPE, policy);
    const key = parseEnv(await read('.env.p9-groq-worker.local')).GROQ_API_KEY;
    let httpStatus;
    const provider = groqFounderProvider(key, async (url, options) => {
      const response = await fetch(url, options);
      httpStatus = response.status;
      return response;
    },
      event => console.log(JSON.stringify({ event })), { policy, quota: limiter.quota });
    const entry = selectedCases[0];
    const start = performance.now();
    const result = await evaluateSyntheticCase(entry, provider).catch(() => ({
      schemaValid: null, quality: 'not-evaluated'
    }));
    console.log(JSON.stringify({ id: entry.id, model: policy.model, httpStatus: httpStatus ?? null,
      elapsedMs: Math.round(performance.now() - start), ...result }));
    if (result.schemaValid !== true) process.exitCode = 1;
  }
} catch {
  console.error('Groq Free evaluation stopped. Check the confirmed plan and quotas, persistent local Redis, and provider diagnostics.');
  process.exitCode = 1;
} finally {
  limiter?.close();
}
}

if (import.meta.main) await main();
