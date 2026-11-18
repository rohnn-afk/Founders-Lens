import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = 'founders-lens-local';
const live = process.argv.includes('--live');

// Explicit opt-in: ordinary npm test must never start/restart infrastructure.
test('local infrastructure: configuration, health, connectivity and persistent restart', {
  skip: !live, timeout: 240_000
}, async (t) => {
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', '.env.infrastructure'], { cwd: root });
  assert.equal(ignored.status, 0, 'Infrastructure credentials must be ignored by Git.');
  const credentials = parseEnv(readFileSync(path.join(root, '.env.infrastructure'), 'utf8'));
  for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD']) {
    assert.ok(/^[a-f0-9]{64}$/.test(credentials[key] ?? ''), 'Use independently generated development passwords.');
  }
  assert.notEqual(credentials.POSTGRES_PASSWORD === credentials.REDIS_PASSWORD, true, 'Use different passwords.');
  for (const key of ['POSTGRES_USER', 'POSTGRES_DB']) {
    assert.equal(credentials[key], 'founders_lens_local', 'Only the dedicated local fixture database is permitted.');
  }
  const ports = { postgres: Number(credentials.POSTGRES_PORT), redis: Number(credentials.REDIS_PORT) };
  for (const port of Object.values(ports)) assert.ok(Number.isInteger(port) && port > 1023 && port < 65536);
  assert.notEqual(ports.postgres, ports.redis);
  const exe = process.env.DOCKER_EXE ?? (process.platform === 'win32'
    ? path.join(homedir(), 'AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe') : 'docker');
  const context = process.platform === 'win32' ? 'desktop-linux' : 'default';
  const env = { ...process.env, ...credentials };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  if (path.isAbsolute(exe)) env[pathKey] = path.dirname(exe) + path.delimiter + (env[pathKey] ?? '');
  const redact = (text) => [credentials.POSTGRES_PASSWORD, credentials.REDIS_PASSWORD]
    .reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), String(text));
  function docker(args, input) {
    const result = spawnSync(exe, ['--context', context, ...args], {
      cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 150_000,
      input, maxBuffer: 8 * 1024 * 1024
    });
    assert.ok(result.status === 0, redact(`Docker ${args[0]} failed: ${result.error?.message ?? ''} ${result.stderr}`));
    return result.stdout.trim();
  }
  const composeArgs = ['compose', '--project-name', project, '--file', 'compose.yaml', '--env-file', '.env.infrastructure'];
  const compose = (args, input) => docker([...composeArgs, ...args], input);
  const inspect = (id) => JSON.parse(docker(['inspect', id]))[0];
  const info = JSON.parse(docker(['context', 'inspect', context]))[0];
  assert.match(info.Endpoints.docker.Host, /^(npipe|unix):\/\//, 'Only a local Docker daemon is allowed.');
  const beforeAll = docker(['ps', '--all', '--quiet']).split(/\r?\n/).filter(Boolean);
  const unrelated = beforeAll.map(inspect).filter((c) => c.Config.Labels?.['com.docker.compose.project'] !== project)
    .map((c) => ({ id: c.Id, state: c.State.Status, started: c.State.StartedAt, restarts: c.RestartCount }));
  for (const id of beforeAll) {
    const container = inspect(id);
    if (container.Config.Labels?.['com.docker.compose.project'] !== project) continue;
    assert.ok(['postgres', 'redis'].includes(container.Config.Labels['com.docker.compose.service']), 'Unexpected project service.');
    assert.equal(path.resolve(container.Config.Labels['com.docker.compose.project.working_dir']), path.resolve(root),
      'A different checkout owns the existing project.');
  }

  let config;
  let validated = false;
  await t.test('resolved Compose has only pinned, authenticated, loopback services and named volumes', () => {
    compose(['config', '--quiet']); // Never print resolved config: it contains development secrets.
    config = JSON.parse(compose(['config', '--format', 'json']));
    assert.equal(config.name, project);
    assert.deepEqual(Object.keys(config.services).sort(), ['postgres', 'redis']);
    assert.equal(config.networks.loopback.driver, 'bridge');
    assert.equal(config.networks.loopback.driver_opts['com.docker.network.bridge.host_binding_ipv4'], '127.0.0.1');
    for (const [service, target, destination] of [
      ['postgres', 5432, '/var/lib/postgresql/data'], ['redis', 6379, '/data']
    ]) {
      const value = config.services[service];
      assert.match(value.image, new RegExp(`^docker\\.io/library/${service}:[0-9.]+-bookworm@sha256:[a-f0-9]{64}$`));
      assert.equal(value.privileged ?? false, false);
      assert.equal(value.network_mode, undefined);
      assert.equal(value.ports.length, 1);
      assert.equal(value.ports[0].host_ip, '127.0.0.1');
      assert.equal(value.ports[0].target, target);
      assert.equal(Number(value.ports[0].published), ports[service]);
      assert.equal(value.volumes.length, 1);
      assert.equal(value.volumes[0].type, 'volume');
      assert.equal(value.volumes[0].target, destination);
      assert.ok(value.healthcheck.test.length > 0);
      assert.ok(value.environment[service === 'postgres' ? 'POSTGRES_PASSWORD' : 'REDIS_PASSWORD'] ===
        credentials[service === 'postgres' ? 'POSTGRES_PASSWORD' : 'REDIS_PASSWORD'], 'Credential source mismatch.');
      assert.equal(value.restart, 'no');
    }
    assert.equal(config.services.postgres.environment.POSTGRES_INITDB_ARGS, '--auth-host=scram-sha-256');
    for (const volume of Object.values(config.volumes)) {
      const existing = docker(['volume', 'ls', '--quiet', '--filter', `name=^${volume.name}$`]);
      if (existing) {
        const details = JSON.parse(docker(['volume', 'inspect', existing]))[0];
        assert.equal(details.Labels?.['com.docker.compose.project'], project, 'Volume belongs to another project.');
      }
    }
    for (const service of ['postgres', 'redis']) {
      if (compose(['ps', '--all', '--quiet', service])) continue;
      // Refuse an occupied host port rather than changing/stopping its owner.
      const check = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import net from 'node:net'; const s=net.createServer(); s.on('error',()=>process.exitCode=1); s.listen(${ports[service]},'127.0.0.1',()=>s.close());`],
      { encoding: 'utf8', windowsHide: true });
      assert.equal(check.status, 0, `${service} port is already occupied.`);
    }
    validated = true;
  });
  assert.ok(validated, 'Configuration validation must complete before startup.');

  function containers() {
    const result = {};
    for (const service of ['postgres', 'redis']) {
      const id = compose(['ps', '--all', '--quiet', service]);
      assert.match(id, /^[a-f0-9]{12,64}$/, 'Exactly one project container is required per service.');
      const container = inspect(id);
      assert.equal(container.Config.Labels['com.docker.compose.project'], project);
      assert.equal(container.Config.Labels['com.docker.compose.service'], service);
      const bound = container.HostConfig.PortBindings[service === 'postgres' ? '5432/tcp' : '6379/tcp'];
      assert.deepEqual(bound, [{ HostIp: '127.0.0.1', HostPort: String(ports[service]) }]);
      assert.deepEqual(container.NetworkSettings.Ports[service === 'postgres' ? '5432/tcp' : '6379/tcp'], bound,
        'Runtime port publication must match the loopback-only configuration.');
      result[service] = container;
    }
    return result;
  }
  async function healthy() {
    const deadline = Date.now() + 90_000;
    do {
      const state = containers();
      if (Object.values(state).every((c) => c.State.Running && c.State.Health?.Status === 'healthy')) return state;
      await delay(1000);
    } while (Date.now() < deadline);
    assert.fail('Project containers did not become healthy.');
  }
  let started = false;
  await t.test('only project PostgreSQL and Redis start and become healthy', async () => {
    compose(['up', '--detach', '--wait', '--wait-timeout', '90', 'postgres', 'redis']);
    await healthy();
    started = true;
  });
  assert.ok(started, 'Both services must be healthy before connectivity checks.');

  function sql(query) {
    return compose(['exec', '-T', 'postgres', 'sh', '-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -At -v ON_ERROR_STOP=1'], query);
  }
  async function redis(commands) {
    const socket = createConnection({ host: '127.0.0.1', port: ports.redis });
    socket.setTimeout(5000);
    const all = [['AUTH', credentials.REDIS_PASSWORD], ...commands];
    return new Promise((resolve, reject) => {
      let output = '';
      socket.once('error', reject);
      socket.once('timeout', () => socket.destroy(new Error('Redis localhost request timed out.')));
      socket.once('connect', () => {
        for (const command of all) socket.write(`*${command.length}\r\n` + command
          .map((item) => `$${Buffer.byteLength(String(item))}\r\n${item}\r\n`).join(''));
      });
      socket.on('data', (data) => {
        output += data.toString();
        // Each invocation ends with ECHO of a unique non-secret sentinel.
        const sentinel = String(commands.at(-1)[1]);
        if (output.endsWith(`$${Buffer.byteLength(sentinel)}\r\n${sentinel}\r\n`)) {
          socket.end();
          if (/(?:^|\r\n)-/.test(output)) reject(new Error('Authenticated Redis command failed.'));
          else resolve(output);
        }
      });
    });
  }
  const token = randomBytes(24).toString('hex');
  const key = `m01:infrastructure-check:${randomUUID()}`;
  let oid;
  await t.test('localhost PostgreSQL handshake, authenticated SQL and Redis persistence configuration', async () => {
    // A native PostgreSQL SSLRequest verifies the published Windows loopback port.
    const socket = createConnection({ host: '127.0.0.1', port: ports.postgres });
    socket.setTimeout(5000);
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('timeout', () => socket.destroy(new Error('PostgreSQL localhost handshake timed out.')));
      socket.once('connect', () => {
        const request = Buffer.alloc(8); request.writeInt32BE(8); request.writeInt32BE(80877103, 4); socket.write(request);
      });
      socket.once('data', (data) => {
        socket.destroy();
        try { assert.ok(['N', 'S'].includes(data.toString())); resolve(); } catch (error) { reject(error); }
      });
    });
    assert.equal(sql('SELECT 1;'), '1');
    const details = await redis([['PING'], ['CONFIG', 'GET', 'appendonly', 'appendfsync', 'maxmemory-policy'], ['ECHO', randomUUID()]]);
    assert.match(details, /\+PONG\r\n/);
    for (const setting of ['yes', 'everysec', 'noeviction']) assert.ok(details.includes(`\r\n${setting}\r\n`));
    // A native large object avoids creating application tables or migrations.
    oid = sql(`SELECT lo_from_bytea(0, decode('${token}', 'hex'));`);
    assert.match(oid, /^\d+$/);
    const receipt = await redis([['SET', key, token, 'NX'], ['WAITAOF', '1', '0', '5000'], ['ECHO', randomUUID()]]);
    assert.match(receipt, /\+OK\r\n\+OK\r\n\*2\r\n:1\r\n:0\r\n/);
  });
  assert.match(oid ?? '', /^\d+$/, 'Persistence fixture must exist before restart.');
  await t.test('controlled restart preserves volume identities and synthetic data; unrelated containers untouched', async () => {
    const before = containers();
    compose(['restart', '--timeout', '30', 'postgres', 'redis']);
    const after = await healthy();
    for (const service of ['postgres', 'redis']) {
      assert.equal(after[service].Id, before[service].Id);
      assert.notEqual(after[service].State.StartedAt, before[service].State.StartedAt);
      assert.deepEqual(after[service].Mounts.filter((m) => m.Type === 'volume').map((m) => m.Name),
        before[service].Mounts.filter((m) => m.Type === 'volume').map((m) => m.Name));
    }
    assert.equal(sql(`SELECT encode(lo_get(${oid}), 'hex');`), token);
    const response = await redis([['GET', key], ['ECHO', randomUUID()]]);
    assert.ok(response.includes(`$${token.length}\r\n${token}\r\n`));
    // Remove only this run's verified synthetic records; never remove volumes.
    assert.equal(sql(`SELECT lo_unlink(${oid});`), '1');
    await redis([['DEL', key], ['ECHO', randomUUID()]]);
    for (const saved of unrelated) {
      const current = inspect(saved.id);
      assert.equal(current.State.Status, saved.state);
      assert.equal(current.State.StartedAt, saved.started);
      assert.equal(current.RestartCount, saved.restarts);
    }
    t.diagnostic('Both containers healthy; localhost connectivity and retained-volume restart persistence verified. Services remain running.');
  });
});
