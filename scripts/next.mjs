// Web process launcher. npm scripts use Node to run the installed Next.js
// CLI from the web workspace and propagate its exit status.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Resolve the executable from installed dependencies so the same wrapper
// works across shells. Inherited I/O keeps Next's output visible to callers.
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)),
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit'
});

// Signals are process-control notifications. Forward interruption and
// termination requests to the child that owns the Next.js server.
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
