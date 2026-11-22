// API process entry point. It validates runtime configuration, starts the
// Express app on loopback, and owns the server's shutdown lifecycle.

import { z } from 'zod';
import { createApp } from './app.js';
import { localReadOnlyWorkspace } from './workspace/read-only-composition.js';

const config = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(3001)
}).safeParse({ port: process.env['API_PORT'] });

if (!config.success) {
  console.error('API configuration invalid.');
  process.exitCode = 1;
} else {
  const local = await localReadOnlyWorkspace(process.env).catch(() => {
    console.error('Local workspace clearance unavailable.');
    return undefined;
  });
  const server = createApp(local?.router).listen(config.data.port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      console.log(`API shell listening on http://127.0.0.1:${address.port}`);
    }
  });
  server.on('error', () => {
    console.error('API server failed.');
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
