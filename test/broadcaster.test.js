import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@ecency/sdk/hive';

const dir = mkdtempSync(join(tmpdir(), 'hsapi-key-'));
const wif = PrivateKey.fromSeed('broadcaster-file-test').toString();

// Each case needs a fresh module, because the key is kept after the first read.
let n = 0;
const load = async (file) => {
  process.env.BROADCASTER_POSTING_WIF_FILE = file;
  n += 1;
  return import(`../helpers/broadcaster.js?case=${n}`);
};

test('reads the key from the file, ignoring a trailing newline', async () => {
  const file = join(dir, 'with-newline');
  writeFileSync(file, `${wif}\n`);
  const { broadcasterKey } = await load(file);
  assert.equal(broadcasterKey().toString(), wif);
});

test('keeps the key after the first read', async () => {
  const file = join(dir, 'kept');
  writeFileSync(file, wif);
  const { broadcasterKey } = await load(file);
  const first = broadcasterKey();
  writeFileSync(file, PrivateKey.fromSeed('another').toString());
  assert.equal(broadcasterKey(), first);
});

test('a missing file throws instead of running without a key', async () => {
  const { broadcasterKey } = await load(join(dir, 'does-not-exist'));
  assert.throws(() => broadcasterKey(), /ENOENT/);
});

test('a malformed key throws', async () => {
  const file = join(dir, 'malformed');
  writeFileSync(file, 'not-a-wif');
  const { broadcasterKey } = await load(file);
  assert.throws(() => broadcasterKey());
});
