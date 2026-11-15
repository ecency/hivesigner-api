import { readFileSync } from 'fs';
import { PrivateKey } from '@ecency/sdk/hive';

// The broadcaster's posting key comes from a file (a swarm secret in
// production), not from the environment: an env var is printed by
// `docker service inspect` and `docker inspect` for anyone allowed to run
// them, and is inherited by every child process. A secret file is mounted
// into the task only, readable by the app user only.
const DEFAULT_FILE = '/run/secrets/broadcaster_posting_wif';

let key;

// Read on first use and kept. routes/api.js calls this at import, so a
// missing or malformed secret stops the service at startup instead of
// failing its first request.
export const broadcasterKey = () => {
  if (!key) {
    const file = process.env.BROADCASTER_POSTING_WIF_FILE || DEFAULT_FILE;
    key = PrivateKey.fromString(readFileSync(file, 'utf8').trim());
  }
  return key;
};
