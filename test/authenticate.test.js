import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// The app profile comes from the chain. Replace only the account lookup, so
// the real profile parsing runs and each test decides what the chain answers.
let chainAnswer;
mock.module('../helpers/client.js', {
  namedExports: {
    getAccount: async (username) => chainAnswer(username),
  },
});

const { authenticate } = await import('../helpers/middleware.js');

const SECRET = 'a-long-random-client-secret';
const SECRET_HASH = createHash('sha256').update(SECRET).digest('hex');

// What getAccount returns for an account whose posting profile is `profile`.
const account = (profile) => [
  { posting_json_metadata: JSON.stringify({ profile: { version: 2, ...profile } }) },
];

// Run the token endpoint's guard and report whether it let the request
// through, and what it answered if not.
async function exchange({ role = 'code', query = {}, body = {}, headers = {} } = {}) {
  const req = {
    role,
    proxy: 'myapp',
    query,
    body,
    headers,
    connection: { remoteAddress: '203.0.113.9' },
  };
  const result = { passed: false, status: null, json: null };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(payload) {
      result.json = payload;
      return this;
    },
  };
  await authenticate(['code', 'refresh'])(req, res, () => {
    result.passed = true;
  });
  return result;
}

beforeEach(() => {
  chainAnswer = async () => account({ type: 'app', secret: SECRET_HASH });
});

test('a code exchange with the right secret passes', async () => {
  const r = await exchange({ body: { client_secret: SECRET } });
  assert.equal(r.passed, true);
});

test('a code exchange with a wrong secret is refused', async () => {
  const r = await exchange({ body: { client_secret: 'guess' } });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_grant');
});

test('a failed app lookup refuses the exchange instead of skipping the secret check', async () => {
  chainAnswer = async () => {
    throw new Error('every node timed out');
  };
  const r = await exchange({ body: { client_secret: 'anything' } });
  assert.equal(r.passed, false);
  // Temporary: the app should retry, not drop its refresh token.
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'temporarily_unavailable');
});

test('a refresh for an account that is not an app is refused', async () => {
  chainAnswer = async () => account({ name: 'not an app' });
  const r = await exchange({ role: 'refresh', body: { client_secret: 'anything' } });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_grant');
});

test('a code for an account that does not exist is refused', async () => {
  chainAnswer = async () => [];
  const r = await exchange({ body: { client_secret: 'anything' } });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_grant');
});

test('an app with no secret set cannot exchange codes', async () => {
  chainAnswer = async () => account({ type: 'app' });
  const r = await exchange({ body: { client_secret: SECRET } });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
});

test('a missing client_secret is refused, not a crash', async () => {
  const r = await exchange();
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_grant');
});

test('a client_secret that is not a string is refused, not a crash', async () => {
  const r = await exchange({ query: { client_secret: [SECRET, SECRET] } });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
});

test('the secret is read from the query string too', async () => {
  const r = await exchange({ query: { client_secret: SECRET } });
  assert.equal(r.passed, true);
});

test('allowed_ips still refuses an address outside the list', async () => {
  chainAnswer = async () => account({ type: 'app', secret: SECRET_HASH, allowed_ips: ['198.51.100.1'] });
  const r = await exchange({ body: { client_secret: SECRET } });
  assert.equal(r.passed, false);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'unauthorized_access');
});

test('non-exchange roles are not asked for a secret', async () => {
  const r = await exchange({ role: 'app' });
  // authenticate(['code','refresh']) refuses other roles before any lookup.
  assert.equal(r.passed, false);
  assert.equal(r.json.error, 'invalid_grant');
});
