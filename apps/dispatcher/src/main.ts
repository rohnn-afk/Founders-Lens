// Lifecycle shell only: no database access, outbox reads or queue publishing.
if (process.env['FL_DEPLOYMENT']) {
  console.error('Hosted generation dispatcher is unavailable.');
  process.exit(1);
}
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  console.log('Dispatcher shell stopped.');
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('Dispatcher shell started; dispatch disabled.');
