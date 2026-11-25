// API process entry point. It validates runtime configuration, starts the
// Express app for the selected environment and owns its shutdown lifecycle.

import { z } from 'zod';
import { stagingConfig } from './workspace/staging-config.js';
import { stagingWorkspace } from './workspace/staging-composition.js';
import { createApp } from './app.js';
import { documentationMode } from './documentation/ui.js';
import { localReadOnlyWorkspace } from './workspace/read-only-composition.js';

const config = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(3001)
}).safeParse({ port: process.env['API_PORT'] });

const deployment = process.env['FL_DEPLOYMENT'];
function logLifecycle(event: string, localMessage: string, failure = false, port?: number) {
  const log = failure ? console.error : console.log;
  log(deployment === 'staging' ? JSON.stringify({
    event, service: 'api', environment: 'staging', ...(port !== undefined && { port })
  }) : localMessage);
}
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
    logLifecycle('api_startup_denied', 'API startup denied.', true);
    process.exitCode = 1;
  }
}

async function startApi(localPort: number) {
  const docs = documentationMode(process.env);
  const staging = deployment === 'staging' ? stagingConfig(process.env) : undefined;
  const hosted = staging && await stagingWorkspace(process.env, staging);
  const local = hosted ?? await localReadOnlyWorkspace(process.env).catch(() => {
    console.error('Local workspace clearance unavailable.');
    return undefined;
  });
  let stopping = false;
  const readiness = hosted && (async () => {
    if (stopping) throw new Error('API is stopping');
    await hosted.ready();
  });
  const server = createApp(local?.router, readiness, docs).listen(staging?.port ?? localPort, staging?.bindHost ?? '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      logLifecycle('api_listening', `API shell listening on http://127.0.0.1:${address.port}`, false, address.port);
    }
  });
  server.on('error', async () => {
    logLifecycle('api_listener_failed', 'API server failed.', true);
    await local?.close().catch(() => logLifecycle('api_shutdown_incomplete', 'API shutdown incomplete.', true));
    process.exitCode = 1;
  });

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // Graceful shutdown stops new connections and lets active requests finish.
    // The deadline caps that wait by closing any remaining active connections.
    let forced = false;
    const deadline = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
      process.exitCode = 1;
    }, 5000);
    deadline.unref();
    server.close(async (error) => {
      clearTimeout(deadline);
      const closed = await local?.close().then(() => true, () => false);
      const failed = forced || Boolean(error) || closed === false;
      process.exitCode = failed ? 1 : 0;
      logLifecycle(failed ? 'api_shutdown_incomplete' : 'api_stopped', 'API shell stopped.', failed);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
