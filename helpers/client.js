import { callRPC } from '@ecency/sdk/hive';
import { cache } from './cache.js';

export const getAccount = async (user, isCached = true) => {
  let account = isCached ? cache.get(`${user}`) : undefined;
  if (account === undefined) {
    try {
      account = await callRPC('condenser_api.get_accounts', [[user]]);
      cache.set(`${user}`, account, 120);
    } catch (e) {
      console.error(new Date().toISOString(), 'Unable to load account from hived', user, e);
    }
  }
  return account;
};
