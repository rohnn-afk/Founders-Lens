// Lifecycle shell only: no queue clients, provider adapters or job processing.
if (process.env['FL_DEPLOYMENT']) {
  console.error('Hosted generation worker is unavailable.');
  process.exit(1);
}
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  console.log('Worker shell stopped.');
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('Worker shell started; jobs disabled.');
