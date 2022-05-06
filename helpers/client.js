import { Client } from '@hiveio/dhive';

const DEFAULT_SERVER = [
  'https://rpc.ecency.com',
  'https://api.deathwing.me',
  'https://rpc.ausbit.dev'
];

const DEFAULT_TESTNET_SERVER = [
  'https://testnet.openhive.network',
];

const network = process.env.BROADCAST_NETWORK || 'mainnet';

const client = new Client(network === 'mainnet' ? DEFAULT_SERVER : DEFAULT_TESTNET_SERVER, {
  timeout: 4000,
  failoverThreshold: 5,
  consoleOnFailover: true,
  addressPrefix: network === 'mainnet' ? 'STM' : 'TST',
  chainId: network === 'mainnet' ? 'beeab0de00000000000000000000000000000000000000000000000000000000' : '18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e',
});

export default client;
