import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PrivateKey } from '@ecency/sdk/hive';

// The route signs with the broadcaster key at import. A throwaway one is enough:
// no request in this file reaches the chain.
process.env.BROADCASTER_POSTING_WIF = PrivateKey.fromSeed('hivesigner-api-test').toString();
process.env.BROADCASTER_USERNAME = 'broadcaster';

// alice gave myapp posting authority, and myapp gave it to the broadcaster.
const ACCOUNTS = {
  myapp: { name: 'myapp', posting: { account_auths: [['broadcaster', 1]] } },
  alice: { name: 'alice', posting: { account_auths: [['myapp', 1]] } },
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

const { default: router } = await import('../routes/api.js');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for the token strategy: an app token for alice issued to myapp.
  app.use((req, res, next) => {
    Object.assign(req, { role: 'app', user: 'alice', proxy: 'myapp', scope: [] });
    next();
  });
  app.use('/api', router);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function broadcast(body) {
  const res = await fetch(`${base}/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  return { status: res.status, json: await res.json() };
}

const malformed = {
  'an operation with no body': { operations: [['vote']] },
  'a null operation': { operations: [null] },
  'an operation that is not an array': { operations: [{ vote: {} }] },
  'an operation whose name is not a string': { operations: [[1, {}]] },
  'an operation whose body is an array': { operations: [['vote', []]] },
  'operations that are not an array': { operations: 'vote' },
  'no operations at all': {},
  'an empty operations list': { operations: [] },
};

for (const [name, body] of Object.entries(malformed)) {
  test(`${name} is refused with 400`, async () => {
    const r = await broadcast(body);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_request');
  });
}

test('the server still answers after malformed requests', async () => {
  // A well-formed vote by someone else: refused by the author check, before
  // anything is signed.
  const r = await broadcast({
    operations: [['vote', { voter: 'bob', author: 'x', permlink: 'y', weight: 10000 }]],
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'unauthorized_client');
});
