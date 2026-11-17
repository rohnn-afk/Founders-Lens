import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)),
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { child.kill(signal); });
}
child.on('error', () => {
  console.error('Unable to start Next.js.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
});
