import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { PrivateKey } from '@ecency/sdk/hive';

// PKCE (RFC 7636) on the code flow, end to end: a code signed by the user's
// own posting key, read by the real token strategy, exchanged at the real
// /api/oauth2/token route. Only the chain is replaced.

process.env.BROADCASTER_POSTING_WIF = PrivateKey.fromSeed('hivesigner-api-test').toString();
process.env.BROADCASTER_USERNAME = 'broadcaster';

const ALICE_KEY = PrivateKey.fromSeed('alice-posting');
const ALICE_PUB = ALICE_KEY.createPublic('STM').toString();
const SECRET = 'a-long-random-client-secret';
const SECRET_HASH = createHash('sha256').update(SECRET).digest('hex');

const auth = (keys = []) => ({ weight_threshold: 1, account_auths: [], key_auths: keys });
const appAccount = (name, profile) => ({
  name,
  posting: auth(),
  active: auth(),
  owner: auth(),
  posting_json_metadata: JSON.stringify({ profile: { version: 2, type: 'app', ...profile } }),
});
const ACCOUNTS = {
  alice: {
    name: 'alice',
    posting: auth([[ALICE_PUB, 1]]),
    active: auth(),
    owner: auth(),
  },
  // A native app: no secret, it cannot keep one.
  nativeapp: appAccount('nativeapp', {}),
  // A server-side app: it has a secret and PKCE does not replace it.
  webapp: appAccount('webapp', { secret: SECRET_HASH }),
  // A server-side app whose owner also lets its native app in with PKCE
  // alone (Ecency: the website has the secret, Waves cannot hold it).
  sharedapp: appAccount('sharedapp', { secret: SECRET_HASH, pkce_public: true }),
  // Only `true` opts in: a string someone typed does not.
  looseflag: appAccount('looseflag', { secret: SECRET_HASH, pkce_public: 'true' }),
};
mock.module('../helpers/client.js', {
  namedExports: { getAccount: async (name) => (ACCOUNTS[name] ? [ACCOUNTS[name]] : []) },
});
mock.module('../helpers/usage.js', {
  namedExports: { usageRecorder: (req, res, next) => next() },
});
mock.module('../helpers/apps.js', {
  namedExports: { getAppsIndex: () => null },
});

const { strategy } = await import('../helpers/middleware.js');
const { default: router } = await import('../routes/api.js');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(strategy);
  app.use('/api', router);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

// Hivesigner's own base64 variant (helpers/utils.js b64uEnc), inlined: importing
// utils before the mocks are in place would bind it to the real chain client.
const b64uEnc = (str) => Buffer.from(str).toString('base64')
  .replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '.' })[m]);
const b64uDec = (str) => Buffer.from(
  str.replace(/[-_.]/g, (m) => ({ '-': '+', _: '/', '.': '=' })[m]), 'base64',
).toString();

const sha256 = (s) => createHash('sha256').update(s).digest();
const challengeOf = (verifier) => sha256(verifier).toString('base64url');

let n = 0;
/** A fresh verifier each call, so no two tests share a code. */
const newVerifier = () => {
  n += 1;
  return `verifier-${n}-${'x'.repeat(50)}`.slice(0, 64);
};

/** A code exactly as the authorize page signs it. */
function signCode(signedMessage, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const message = { signed_message: signedMessage, authors: ['alice'], timestamp };
  const signature = ALICE_KEY.sign(sha256(JSON.stringify(message))).toString();
  return b64uEnc(JSON.stringify({ ...message, signatures: [signature] }));
}

function pkceCode(app, verifier, extra = {}, opts) {
  return signCode({
    type: 'code',
    app,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    ...extra,
  }, opts);
}

async function exchange(body) {
  const res = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  return { status: res.status, json: await res.json() };
}

const refusedAsInvalidGrant = (r) => {
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.equal(r.json.error, 'invalid_grant');
};

test('a native app exchanges a PKCE code with the right verifier and no secret', async () => {
  const verifier = newVerifier();
  const r = await exchange({ code: pkceCode('nativeapp', verifier), code_verifier: verifier });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.username, 'alice');
  assert.ok(r.json.access_token);
  // No refresh token: refreshing needs the client secret this app does not have.
  assert.equal(r.json.refresh_token, undefined);
});

test('the access token from a PKCE exchange works at /api/me', async () => {
  const verifier = newVerifier();
  const { json } = await exchange({ code: pkceCode('nativeapp', verifier), code_verifier: verifier });
  const res = await fetch(`${base}/me`, { headers: { authorization: json.access_token } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user, 'alice');
});

test('a wrong verifier is refused with invalid_grant', async () => {
  const r = await exchange({ code: pkceCode('nativeapp', newVerifier()), code_verifier: newVerifier() });
  refusedAsInvalidGrant(r);
});

test('a missing verifier is refused with invalid_grant', async () => {
  refusedAsInvalidGrant(await exchange({ code: pkceCode('nativeapp', newVerifier()) }));
});

test('a verifier that is not a string is refused, not a crash', async () => {
  const verifier = newVerifier();
  refusedAsInvalidGrant(await exchange({
    code: pkceCode('nativeapp', verifier), code_verifier: [verifier],
  }));
});

test('a verifier shorter than RFC 7636 allows is refused even if it matches', async () => {
  const verifier = 'too-short';
  refusedAsInvalidGrant(await exchange({ code: pkceCode('nativeapp', verifier), code_verifier: verifier }));
});

test('a PKCE code can be exchanged only once', async () => {
  const verifier = newVerifier();
  const code = pkceCode('nativeapp', verifier);
  assert.equal((await exchange({ code, code_verifier: verifier })).status, 200);
  refusedAsInvalidGrant(await exchange({ code, code_verifier: verifier }));
});

test('a wrong verifier does not use up the code for the app that holds the right one', async () => {
  const verifier = newVerifier();
  const code = pkceCode('nativeapp', verifier);
  refusedAsInvalidGrant(await exchange({ code, code_verifier: newVerifier() }));
  assert.equal((await exchange({ code, code_verifier: verifier })).status, 200);
});

test('two exchanges of one code at the same time: exactly one gets tokens', async () => {
  const verifier = newVerifier();
  const code = pkceCode('nativeapp', verifier);
  const attempt = () => exchange({ code, code_verifier: verifier });
  const results = await Promise.all([attempt(), attempt(), attempt()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401]);
});

test('a code from a browser whose clock is a few minutes off still works', async () => {
  for (const offset of [-4 * 60, 4 * 60, -14 * 60]) {
    const verifier = newVerifier();
    const timestamp = Math.floor(Date.now() / 1000) + offset;
    const r = await exchange({
      code: pkceCode('nativeapp', verifier, {}, { timestamp }), code_verifier: verifier,
    });
    assert.equal(r.status, 200, `${offset}: ${JSON.stringify(r.json)}`);
  }
});

test('a PKCE code older than its lifetime plus the clock allowance is refused', async () => {
  const verifier = newVerifier();
  const timestamp = Math.floor(Date.now() / 1000) - 16 * 60;
  refusedAsInvalidGrant(await exchange({
    code: pkceCode('nativeapp', verifier, {}, { timestamp }), code_verifier: verifier,
  }));
});

test('a timestamp in milliseconds is refused and says so', async () => {
  const verifier = newVerifier();
  const r = await exchange({
    code: pkceCode('nativeapp', verifier, {}, { timestamp: Date.now() }), code_verifier: verifier,
  });
  refusedAsInvalidGrant(r);
  assert.match(r.json.error_description, /seconds/);
});

test('a timestamp that is not a whole number is refused as not valid', async () => {
  const verifier = newVerifier();
  const r = await exchange({
    code: pkceCode('nativeapp', verifier, {}, { timestamp: String(Math.floor(Date.now() / 1000)) }),
    code_verifier: verifier,
  });
  refusedAsInvalidGrant(r);
  assert.match(r.json.error_description, /timestamp/);
});

test('a used code is remembered for longer than it can be exchanged', async () => {
  const { USED_CODE_TTL, PKCE_CODE_LIFETIME } = await import('../helpers/middleware.js');
  // Dated up to 5 min ahead, accepted up to lifetime + 5 min after its date,
  // floored to the second: the entry has to outlive all of that.
  assert.ok(USED_CODE_TTL >= PKCE_CODE_LIFETIME + 2 * 300 + 2);
});

test('a PKCE code dated in the future is refused', async () => {
  const verifier = newVerifier();
  const timestamp = Math.floor(Date.now() / 1000) + 10 * 60;
  refusedAsInvalidGrant(await exchange({
    code: pkceCode('nativeapp', verifier, {}, { timestamp }), code_verifier: verifier,
  }));
});

test('a code whose challenge was swapped after signing fails the signature check', async () => {
  const verifier = newVerifier();
  const attacker = newVerifier();
  const original = JSON.parse(b64uDec(pkceCode('nativeapp', verifier)));
  original.signed_message.code_challenge = challengeOf(attacker);
  const altered = b64uEnc(JSON.stringify(original));
  refusedAsInvalidGrant(await exchange({ code: altered, code_verifier: attacker }));
});

test('a code that drops the challenge after signing fails the signature check', async () => {
  const original = JSON.parse(b64uDec(pkceCode('nativeapp', newVerifier())));
  delete original.signed_message.code_challenge;
  delete original.signed_message.code_challenge_method;
  refusedAsInvalidGrant(await exchange({ code: b64uEnc(JSON.stringify(original)) }));
});

test('the plain method is refused, even with a matching verifier', async () => {
  const verifier = newVerifier();
  const code = signCode({
    type: 'code', app: 'nativeapp', code_challenge: verifier, code_challenge_method: 'plain',
  });
  refusedAsInvalidGrant(await exchange({ code, code_verifier: verifier }));
});

test('a challenge with no method is refused (RFC 7636 would read it as plain)', async () => {
  const verifier = newVerifier();
  const code = signCode({ type: 'code', app: 'nativeapp', code_challenge: challengeOf(verifier) });
  refusedAsInvalidGrant(await exchange({ code, code_verifier: verifier }));
});

test('an app with a client secret still needs it with PKCE', async () => {
  const verifier = newVerifier();
  refusedAsInvalidGrant(await exchange({ code: pkceCode('webapp', verifier), code_verifier: verifier }));
});

test('an app with a client secret exchanges a PKCE code with the secret and the verifier', async () => {
  const verifier = newVerifier();
  const r = await exchange({
    code: pkceCode('webapp', verifier), code_verifier: verifier, client_secret: SECRET,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.refresh_token);
});

test('an app with a secret that opted in with pkce_public exchanges with the verifier alone', async () => {
  const verifier = newVerifier();
  const r = await exchange({ code: pkceCode('sharedapp', verifier), code_verifier: verifier });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.refresh_token, undefined);
});

test('pkce_public still needs the verifier, and a wrong secret is still refused', async () => {
  refusedAsInvalidGrant(await exchange({ code: pkceCode('sharedapp', newVerifier()), client_secret: SECRET }));
  const verifier = newVerifier();
  refusedAsInvalidGrant(await exchange({
    code: pkceCode('sharedapp', verifier), code_verifier: verifier, client_secret: 'wrong',
  }));
});

test('pkce_public with the secret as well still gets a refresh token', async () => {
  const verifier = newVerifier();
  const r = await exchange({
    code: pkceCode('sharedapp', verifier), code_verifier: verifier, client_secret: SECRET,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.refresh_token);
});

test('pkce_public does not open codes without a challenge', async () => {
  refusedAsInvalidGrant(await exchange({ code: signCode({ type: 'code', app: 'sharedapp' }) }));
});

test('pkce_public must be the boolean true', async () => {
  const verifier = newVerifier();
  refusedAsInvalidGrant(await exchange({ code: pkceCode('looseflag', verifier), code_verifier: verifier }));
});

test('the secret does not stand in for the verifier', async () => {
  refusedAsInvalidGrant(await exchange({
    code: pkceCode('webapp', newVerifier()), client_secret: SECRET,
  }));
});

test('a PKCE code for an account that is not an app is refused', async () => {
  const verifier = newVerifier();
  refusedAsInvalidGrant(await exchange({ code: pkceCode('alice', verifier), code_verifier: verifier }));
});

test('a PKCE code is not accepted as a token anywhere else, even with its verifier', async () => {
  const verifier = newVerifier();
  const res = await fetch(`${base}/me?code_verifier=${verifier}`, {
    headers: { authorization: pkceCode('nativeapp', verifier) },
  });
  assert.equal(res.status, 401);
});

// Unchanged behaviour for every app that exists today.

test('a code without a challenge still exchanges with the secret, and gets a refresh token', async () => {
  const r = await exchange({ code: signCode({ type: 'code', app: 'webapp' }), client_secret: SECRET });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.access_token);
  assert.ok(r.json.refresh_token);
});

test('a code without a challenge is not single use, as before', async () => {
  const code = signCode({ type: 'code', app: 'webapp' });
  assert.equal((await exchange({ code, client_secret: SECRET })).status, 200);
  assert.equal((await exchange({ code, client_secret: SECRET })).status, 200);
});

test('a code without a challenge still has no age limit, as before', async () => {
  const code = signCode({ type: 'code', app: 'webapp' }, { timestamp: 1500000000 });
  assert.equal((await exchange({ code, client_secret: SECRET })).status, 200);
});

test('a code without a challenge and without the secret is still refused', async () => {
  refusedAsInvalidGrant(await exchange({ code: signCode({ type: 'code', app: 'nativeapp' }) }));
});

test('a verifier sent with a code that has no challenge changes nothing', async () => {
  refusedAsInvalidGrant(await exchange({
    code: signCode({ type: 'code', app: 'nativeapp' }), code_verifier: newVerifier(),
  }));
});

test('a refresh token is still exchanged with the secret', async () => {
  const { json } = await exchange({ code: signCode({ type: 'code', app: 'webapp' }), client_secret: SECRET });
  const r = await exchange({ refresh_token: json.refresh_token, client_secret: SECRET });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});
