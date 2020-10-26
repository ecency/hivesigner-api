import { Client } from '@hiveio/dhive';

const DEFAULT_SERVER = [
  'https://api.hive.blog',
  'https://rpc.ecency.com',
  'https://anyx.io',
];

const client = new Client([process.env.BROADCAST_URL || 'https://api.hive.blog', ...DEFAULT_SERVER], {
  rebrandedApi: true,
  timeout: 3000,
  failoverThreshold: 15,
  consoleOnFailover: true
});

export default client;
