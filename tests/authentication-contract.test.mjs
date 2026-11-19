import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { request } from 'node:http';
import test from 'node:test';
import express from 'express';
import { clerkConfig } from '../apps/api/dist/security/config.js';
import { createClerkBoundary } from '../apps/api/dist/security/clerk.js';
import { SecurityError, securityErrorHandler } from '../apps/api/dist/security/errors.js';
import { attachRequestContext } from '../apps/api/dist/security/request-context.js';

// Synthetic keys exist only in memory. No development Clerk account/key is used.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://synthetic.clerk.accounts.dev';
const environment = {
  CLERK_INSTANCE_ID: 'ins_synthetic', CLERK_ISSUER: issuer,
  CLERK_AUTHORIZED_PARTIES: '["http://127.0.0.1:3000"]', CLERK_AUDIENCE: '["founders-lens-test"]',
  CLERK_PUBLISHABLE_KEY: 'pk_test_' + Buffer.from('synthetic.clerk.accounts.dev$').toString('base64'),
  CLERK_SECRET_KEY: 'sk_test_synthetic_not_a_real_key',
  CLERK_JWT_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' })
};
const config = clerkConfig(environment);
function jwt(changes = {}, key = pair.privateKey, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuer, sub: 'user_synthetic', sid: 'sess_synthetic', azp: 'http://127.0.0.1:3000',
    aud: 'founders-lens-test', iat: now - 10, nbf: now - 10, exp: now + 120, v: 2, sts: 'active', fva: [0, -1], ...changes };
  // Test-only minted-token category from pinned @clerk/backend 3.31.0. The
  // application delegates category verification to Clerk and never defines it.
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'synthetic', cat: 'cl_B7d4PD111AAA', ...header }), JSON.stringify(payload)]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  return encoded + '.' + sign('RSA-SHA256', Buffer.from(encoded), key).toString('base64url');
}
function authenticate(boundary, token) {
  const authorization = 'Bearer ' + token;
  return boundary.authenticate({ authorization }, ['Authorization', authorization]);
}
async function probe(t, boundary) {
  const app = express();
  app.use(attachRequestContext);
  app.get('/probe', async (req, res) => {
    const identity = await boundary.authenticate(req.headers, req.rawHeaders);
    res.json({ subject: identity.subject });
  });
  app.use(securityErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return headers => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/probe', headers }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('synthetic Clerk SDK authentication; outbound provider calls are forbidden', async t => {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => { outboundCalls++; throw new Error('Outbound provider call prohibited by test'); };
  t.after(() => { globalThis.fetch = originalFetch; assert.equal(outboundCalls, 0); });

  await t.test('installed SDK verifies a synthetic session with a local public key', async () => {
    const identity = await authenticate(createClerkBoundary(config), jwt());
    assert.equal(identity.subject, 'user_synthetic');
    assert.equal(identity.sessionId, 'sess_synthetic');
    assert.equal(identity.instanceId, 'ins_synthetic');
    assert.ok(!('token' in identity));
  });

  for (const [name, token] of [
    ['expired', jwt({ exp: Math.floor(Date.now() / 1000) - 30 })],
    ['forged signature', jwt({}, other.privateKey)],
    ['wrong issuer', jwt({ iss: 'https://foreign.clerk.accounts.dev' })],
    ['wrong party', jwt({ azp: 'https://foreign.invalid' })],
    ['missing party', jwt({ azp: undefined })],
    ['wrong audience', jwt({ aud: 'foreign' })],
    ['missing required audience', jwt({ aud: undefined })],
    ['pending session', jwt({ sts: 'pending' })],
    ['missing session', jwt({ sid: undefined })],
    ['future activation', jwt({ nbf: Math.floor(Date.now() / 1000) + 120 })],
    ['machine identity JWT', jwt({ sub: 'machine_synthetic' })]
    , ['missing category', jwt({}, pair.privateKey, { cat: undefined })]
  ]) await t.test('denies ' + name, async () => {
    await assert.rejects(authenticate(createClerkBoundary(config), token), error => error instanceof SecurityError && error.code === 'UNAUTHENTICATED');
  });

  await t.test('rejects cookie-only, mixed, malformed and duplicate bearer sources before SDK invocation', async () => {
    const boundary = createClerkBoundary(config);
    let calls = 0;
    boundary.client.authenticateRequest = async () => { calls++; throw new Error('SDK must not run'); };
    const value = 'Bearer ' + jwt();
    const cases = [
      [{ cookie: '__session=synthetic' }, ['Cookie', '__session=synthetic']],
      [{ authorization: value, cookie: '__session=synthetic' }, ['Authorization', value, 'Cookie', '__session=synthetic']],
      [{ authorization: value }, ['Authorization', value, 'authorization', value]],
      [{ authorization: value + ', ' + value }, ['Authorization', value + ', ' + value]],
      [{ authorization: 'Bearer ak_test_synthetic' }, ['Authorization', 'Bearer ak_test_synthetic']],
      [{ authorization: 'Basic synthetic' }, ['Authorization', 'Basic synthetic']],
      [{}, []]
    ];
    for (const [headers, raw] of cases) await assert.rejects(boundary.authenticate(headers, raw), { code: 'UNAUTHENTICATED' });
    assert.equal(calls, 0);
  });

  await t.test('SDK receives only a fixed API request and strict verification options', async () => {
    const boundary = createClerkBoundary(config), token = jwt();
    boundary.client.authenticateRequest = async (req, options) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, 'https://founders-lens.invalid/api-auth');
      assert.equal(req.headers.get('cookie'), null);
      assert.equal(req.headers.get('host'), null);
      assert.equal(req.headers.get('sec-fetch-dest'), null);
      assert.equal(req.headers.get('accept'), 'application/json');
      assert.equal(req.headers.get('authorization'), 'Bearer ' + token);
      assert.equal(options.acceptsToken, 'session_token');
      assert.equal(options.issuer, issuer);
      assert.deepEqual(options.authorizedParties, ['http://127.0.0.1:3000']);
      assert.deepEqual(options.audience, ['founders-lens-test']);
      assert.equal(options.clockSkewInMs, 0);
      return { status: 'signed-out', headers: new Headers() };
    };
    await assert.rejects(boundary.authenticate({ authorization: 'Bearer ' + token, host: 'attacker.invalid', accept: 'text/html', 'sec-fetch-dest': 'document' },
      ['Authorization', 'Bearer ' + token]), { code: 'UNAUTHENTICATED' });
  });

  for (const tokenType of ['api_key', 'm2m_token', 'oauth_token']) await t.test('rejects SDK result type ' + tokenType, async () => {
    const boundary = createClerkBoundary(config);
    boundary.client.authenticateRequest = async () => ({ status: 'signed-in', tokenType, headers: new Headers() });
    await assert.rejects(authenticate(boundary, jwt()), { code: 'UNAUTHENTICATED' });
  });

  await t.test('handshake and navigation failures produce JSON 401 without Location or Set-Cookie', async t => {
    const boundary = createClerkBoundary(config);
    boundary.client.authenticateRequest = async () => ({ status: 'handshake', tokenType: 'session_token',
      headers: new Headers({ location: 'https://must-not-redirect.invalid', 'set-cookie': '__session=must-not-copy' }) });
    const send = await probe(t, boundary);
    const result = await send({ authorization: 'Bearer ' + jwt(), accept: 'text/html', 'sec-fetch-dest': 'document' });
    assert.equal(result.status, 401);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.equal(result.headers.location, undefined);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(result.body).error.code, 'UNAUTHENTICATED');
  });

  await t.test('SDK exceptions become sanitized JSON dependency failures', async t => {
    const boundary = createClerkBoundary(config), token = jwt();
    boundary.client.authenticateRequest = async () => { throw new Error('sensitive ' + token + ' ' + environment.CLERK_SECRET_KEY); };
    const send = await probe(t, boundary), result = await send({ authorization: 'Bearer ' + token });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.ok(!result.body.includes(token));
    assert.ok(!result.body.includes(environment.CLERK_SECRET_KEY));
    assert.ok(!result.body.includes('stack'));
    assert.equal(result.headers.location, undefined);
  });
});

test('configuration rejects missing, mismatched and unsafe identity configuration', () => {
  for (const changes of [{ CLERK_ISSUER: 'http://synthetic.clerk.accounts.dev' }, { CLERK_AUTHORIZED_PARTIES: '[]' },
    { CLERK_AUTHORIZED_PARTIES: '["ftp://127.0.0.1"]' }, { CLERK_AUTHORIZED_PARTIES: '["https://*.invalid"]' },
    { CLERK_SECRET_KEY: 'sk_live_mismatched' }, { CLERK_AUDIENCE: '[]' }, { CLERK_JWT_KEY: 'not a public key' }]) {
    assert.throws(() => clerkConfig({ ...environment, ...changes }), { code: 'DEPENDENCY_UNAVAILABLE' });
  }
  assert.throws(() => clerkConfig({}), { code: 'DEPENDENCY_UNAVAILABLE' });
});

test('configured audience policy uses only verified claims and exact matches', async t => {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => { outboundCalls++; throw new Error('Outbound provider call prohibited by test'); };
  t.after(() => { globalThis.fetch = originalFetch; assert.equal(outboundCalls, 0); });

  for (const [name, aud] of [
    ['matching string', 'founders-lens-test'],
    ['matching single-element array', ['founders-lens-test']],
    ['matching member of multi-audience array', ['another-recipient', 'founders-lens-test']],
    ['duplicate matching members', ['founders-lens-test', 'founders-lens-test']]
  ]) await t.test('accepts ' + name, async () => {
    const identity = await authenticate(createClerkBoundary(config), jwt({ aud }));
    assert.equal(identity.subject, 'user_synthetic');
  });

  await t.test('accepts only explicitly configured alternative audiences', async () => {
    const alternatives = clerkConfig({ ...environment, CLERK_AUDIENCE: '["founders-lens-test","explicit-alternative"]' });
    assert.equal((await authenticate(createClerkBoundary(alternatives), jwt({ aud: 'explicit-alternative' }))).subject, 'user_synthetic');
  });

  for (const [name, aud] of [
    ['missing', undefined], ['null', null], ['empty string', ''], ['empty array', []],
    ['wrong string', 'foreign'], ['wrong array', ['foreign', 'another']],
    ['prefix match', 'founders-lens-test-extra'], ['case variation', 'FOUNDERS-LENS-TEST'],
    ['whitespace variation', ' founders-lens-test'],
    ['numeric zero', 0], ['number', 123], ['boolean true', true], ['boolean false', false],
    ['object', { audience: 'founders-lens-test' }],
    ['array-like object', { 0: 'founders-lens-test', length: 1 }],
    ['mixed number array', ['founders-lens-test', 123]],
    ['mixed null array', ['founders-lens-test', null]],
    ['mixed empty string array', ['founders-lens-test', '']],
    ['nested array', ['founders-lens-test', ['founders-lens-test']]],
    ['mixed object array', ['founders-lens-test', {}]]
  ]) await t.test('denies audience: ' + name, async () => {
    await assert.rejects(authenticate(createClerkBoundary(config), jwt({ aud })), { code: 'UNAUTHENTICATED' });
  });

  await t.test('missing audience is allowed only when audience policy is not configured', async () => {
    const optional = { ...environment };
    delete optional.CLERK_AUDIENCE;
    const identity = await authenticate(createClerkBoundary(clerkConfig(optional)), jwt({ aud: undefined }));
    assert.equal(identity.subject, 'user_synthetic');
  });

  await t.test('matching audience cannot rescue a forged signature', async () => {
    await assert.rejects(authenticate(createClerkBoundary(config), jwt({ aud: ['founders-lens-test'] }, other.privateKey)), { code: 'UNAUTHENTICATED' });
  });

  await t.test('changing an unverified payload audience cannot bypass signature verification', async () => {
    const parts = jwt({ aud: 'foreign' }).split('.');
    // Deliberate test-only tampering: retain the signature over the old payload.
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload.aud = 'founders-lens-test';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    await assert.rejects(authenticate(createClerkBoundary(config), parts.join('.')), { code: 'UNAUTHENTICATED' });
  });

  for (const [name, claims] of [
    ['missing', undefined], ['null', null], ['string', 'not-claims'], ['array', []],
    ['verified payload missing audience', { iss: issuer, azp: 'http://127.0.0.1:3000', exp: Math.floor(Date.now() / 1000) + 120 }],
    ['verified payload with wrong audience', { iss: issuer, azp: 'http://127.0.0.1:3000', exp: Math.floor(Date.now() / 1000) + 120, aud: 'foreign' }]
  ]) await t.test('denies unavailable or unsuitable verified claims: ' + name, async () => {
    const boundary = createClerkBoundary(config);
    boundary.client.authenticateRequest = async () => ({ status: 'signed-in', tokenType: 'session_token', headers: new Headers(),
      toAuth: () => ({ isAuthenticated: true, tokenType: 'session_token', userId: 'user_synthetic', sessionId: 'sess_synthetic', sessionClaims: claims }) });
    // The incoming token contains a matching aud; only the verified result counts.
    await assert.rejects(authenticate(boundary, jwt()), { code: 'UNAUTHENTICATED' });
  });

  await t.test('audience failures return JSON 401 without redirects, cookies or sensitive details', async t => {
    const send = await probe(t, createClerkBoundary(config));
    for (const aud of [undefined, '', [], 'foreign', ['founders-lens-test', null]]) {
      const token = jwt({ aud });
      const result = await send({ authorization: 'Bearer ' + token, accept: 'text/html', 'sec-fetch-dest': 'document' });
      assert.equal(result.status, 401);
      assert.match(result.headers['content-type'], /^application\/json/);
      assert.equal(result.headers.location, undefined);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(JSON.parse(result.body).error.code, 'UNAUTHENTICATED');
      assert.ok(!result.body.includes(token));
      assert.ok(!result.body.includes(environment.CLERK_SECRET_KEY));
    }
  });
});
