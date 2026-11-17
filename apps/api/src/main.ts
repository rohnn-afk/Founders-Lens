import { z } from 'zod';
import { createApp } from './app.js';

const config = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(3001)
}).safeParse({ port: process.env['API_PORT'] });

if (!config.success) {
  console.error('API configuration invalid.');
  process.exitCode = 1;
} else {
  const server = createApp().listen(config.data.port, '127.0.0.1', () => {
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
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, 5000);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      process.exitCode = error ? 1 : 0;
      console.log('API shell stopped.');
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
