import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runLocalGeneration } from '../scripts/p9-local-runtime.mjs';
import { signP9Clearances } from './fixtures/p6-local-operator.mjs';

test('launcher reports loop failure and executes shutdown in finally', async () => {
  const calls = [];
  await runLocalGeneration(async () => ({
    finished: Promise.reject(new Error('sensitive dependency failure')),
    async close() { calls.push('closed'); throw new Error('sensitive shutdown failure'); }
  }), event => calls.push(event));
  assert.deepEqual(calls, ['P9_RUNTIME_FAILED', 'closed', 'P9_SHUTDOWN_FAILED']);
  calls.length = 0;
  await runLocalGeneration(async () => { throw new Error('sensitive startup failure'); }, event => calls.push(event));
  assert.deepEqual(calls, ['P9_LOCAL_STARTUP_DENIED']);
});

test('P9 offline signing binds all purposes to one verified inventory and recovery run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'p9-signing-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const privateFile = join(dir, 'private.pem'), publicFile = join(dir, 'public.pem');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await writeFile(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(publicFile, publicKey.export({ type: 'spki', format: 'pem' }));
  const primaryTarget = '123:4', snapshot = { authorityIdentity: '567:8', namespace: 'hmac-sha256-v1:' + 'a'.repeat(64),
    epoch: randomUUID(), inventoryDigest: 'b'.repeat(64), subjectVersions: [1] };
  const context = { isolated: true, async verify() { return { primaryTarget, snapshot }; } };
  await assert.rejects(signP9Clearances({ ...context, isolated: false }, privateFile, publicFile, 'approve-p9-isolated-runtime'));
  await assert.rejects(signP9Clearances(context, privateFile, publicFile, 'wrong-confirmation'));
  const bundle = await signP9Clearances(context, privateFile, publicFile, 'approve-p9-isolated-runtime');
  let recoveryRun;
  for (const purpose of ['submit', 'status', 'dispatch', 'execute']) {
    const envelope = JSON.parse(bundle['FL_P9_' + purpose.toUpperCase() + '_DECISION']);
    const payload = Buffer.from(envelope.payload, 'base64url');
    assert.equal(verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64url')), true);
    const decision = JSON.parse(payload);
    assert.equal(decision.purpose, 'founders-lens:local-generation:' + purpose);
    assert.equal(decision.primaryTarget, primaryTarget);
    assert.equal(decision.authorityIdentity, snapshot.authorityIdentity);
    assert.equal(decision.inventoryDigest, snapshot.inventoryDigest);
    assert.equal(decision.expiresAt - decision.issuedAt, 300_000);
    recoveryRun ??= decision.recoveryRun;
    assert.equal(decision.recoveryRun, recoveryRun);
  }
});
