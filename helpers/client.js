import { Client } from '@hiveio/dhive';

const DEFAULT_SERVER = [
  'https://api.hive.blog',
  'https://rpc.ecency.com'
];

const client = new Client([process.env.BROADCAST_URL, ...DEFAULT_SERVER], {
  timeout: 3000,
  failoverThreshold: 15,
  consoleOnFailover: true
});

export default client;
