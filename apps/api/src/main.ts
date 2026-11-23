// API process entry point. It validates runtime configuration, starts the
// Express app on loopback, and owns the server's shutdown lifecycle.

import { z } from 'zod';
import { stagingConfig } from './workspace/staging-config.js';
import { stagingWorkspace } from './workspace/staging-composition.js';
import { createApp } from './app.js';
import { localReadOnlyWorkspace } from './workspace/read-only-composition.js';

const config = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(3001)
}).safeParse({ port: process.env['API_PORT'] });

const deployment = process.env['FL_DEPLOYMENT'];
if (deployment !== undefined && deployment !== 'staging') {
  console.error('Unsupported API deployment.');
  process.exitCode = 1;
} else if (!config.success) {
  console.error('API configuration invalid.');
  process.exitCode = 1;
} else {
  try {
    await startApi(config.data.port);
  } catch {
    console.error('API startup denied.');
    process.exitCode = 1;
  }
}

async function startApi(localPort: number) {
  const staging = deployment === 'staging' ? stagingConfig(process.env) : undefined;
  const hosted = staging && await stagingWorkspace(process.env, staging);
  const local = hosted ?? await localReadOnlyWorkspace(process.env).catch(() => {
    console.error('Local workspace clearance unavailable.');
    return undefined;
  });
  const server = createApp(local?.router, hosted?.ready).listen(staging?.port ?? localPort, staging ? '::' : '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      console.log(staging ? `Staging API listening on port ${address.port}.` : `API shell listening on http://127.0.0.1:${address.port}`);
    }
  });
  server.on('error', async () => {
    console.error('API server failed.');
    await local?.close().catch(() => console.error('API shutdown incomplete.'));
    process.exitCode = 1;
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // Graceful shutdown stops new connections and lets active requests finish.
    // The deadline caps that wait by closing any remaining active connections.
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, 5000);
    deadline.unref();
    server.close(async (error) => {
      clearTimeout(deadline);
      const closed = await local?.close().then(() => true, () => false);
      process.exitCode = error || closed === false ? 1 : 0;
      console.log('API shell stopped.');
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
