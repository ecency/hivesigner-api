import { Client } from '@hiveio/dhive';

const DEFAULT_SERVER = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://rpc.ecency.com',
];

const DEFAULT_TESTNET_SERVER = [
  'https://testnet.openhive.network',
];

const network = process.env.BROADCAST_NETWORK || 'mainnet';

const client = new Client(network === 'mainnet' ? DEFAULT_SERVER : DEFAULT_TESTNET_SERVER, {
  timeout: 4000,
  failoverThreshold: 5,
  consoleOnFailover: true,
  addressPrefix: network === 'mainnet' ? 'SMT' : 'TST',
});

export default client;
