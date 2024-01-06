import { Client } from '@hiveio/dhive';
import { cache } from './cache';

const DEFAULT_SERVER = [
  'https://anyx.io',
  'https://techcoderx.com',
  'https://api.hive.blog'
];

const broadcast_server = [
  'https://hived.emre.sh',
  'https://anyx.io',
  'https://api.hive.blog'
];

const DEFAULT_TESTNET_SERVER = [
  'https://testnet.openhive.network',
];

const network = process.env.BROADCAST_NETWORK || 'mainnet';

export const client = new Client(network === 'mainnet' ? DEFAULT_SERVER : DEFAULT_TESTNET_SERVER, {
  timeout: 4000,
  failoverThreshold: 4,
  consoleOnFailover: true,
  addressPrefix: network === 'mainnet' ? 'STM' : 'TST',
  chainId: network === 'mainnet' ? 'beeab0de00000000000000000000000000000000000000000000000000000000' : '18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e',
});

export const bclient = new Client(network === 'mainnet' ? broadcast_server : DEFAULT_TESTNET_SERVER, {
  timeout: 3000,
  failoverThreshold: 2,
  consoleOnFailover: true,
  addressPrefix: network === 'mainnet' ? 'STM' : 'TST',
  chainId: network === 'mainnet' ? 'beeab0de00000000000000000000000000000000000000000000000000000000' : '18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e',
});

export const getAccount = async (user, isCached = true) => {
  let account = isCached ? cache.get(`${user}`) : undefined;
  if (account === undefined) {
    try {
      account = await client.database.getAccounts([user]);
      cache.set(`${user}`, account, 120);
    } catch (e) {
      console.error(new Date().toISOString(), client.currentAddress, 'Unable to load account from hived', user, e);
    }
  }
  return account;
};
