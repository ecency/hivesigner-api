import { Client } from '@hiveio/dhive';

const DEFAULT_SERVER = [
  'https://rpc.ecency.com',
  'https://api.hive.blog'
];

const client = new Client(DEFAULT_SERVER, {
  timeout: 3000,
  failoverThreshold: 15,
  consoleOnFailover: true
});

export default client;
