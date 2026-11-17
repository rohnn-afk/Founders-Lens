// Lifecycle shell only: no database access, outbox reads or queue publishing.
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
