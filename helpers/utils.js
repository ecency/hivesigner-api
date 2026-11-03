/* eslint-disable prefer-promise-reject-errors */
import Promise from 'bluebird';
import pkg from 'lodash';
import { getAccount } from './client.js';

const { get, has } = pkg;

const operationAuthor = {
  vote: 'voter',
  comment: 'author',
  delete_comment: 'author',
  custom_json: 'required_posting_auths[0]',
  comment_options: 'author',
  claim_reward_balance: 'account',
  account_update2: 'account',
};

/** Parse error message from hived response */
export const getErrorMessage = (error) => {
  let errorMessage = '';
  if (has(error, 'data.stack[0].format')) {
    errorMessage = error.data.stack[0].format;
    if (has(error, 'data.stack[0].data')) {
      const { data } = error.data.stack[0];
      Object.keys(data).forEach((d) => {
        errorMessage = errorMessage.split('${' + d + '}').join(data[d]); // eslint-disable-line prefer-template
      });
    }
  }
  return errorMessage;
};

export const isOperationAuthor = (operation, query, username) => {
  if (Object.prototype.hasOwnProperty.call(operationAuthor, operation)) {
    const field = operationAuthor[operation];
    if (!field) { return false; }
    return get(query, field) === username;
  }
  return false;
};

const appProfileError = (code, message) => Object.assign(new Error(message), { code });

/**
 * The app's profile. Rejects with `code` 'lookup_failed' when the chain could
 * not be read (worth a retry) and 'not_app' when the account is missing or is
 * not an app (final).
 */
export const getAppProfile = (username) => new Promise((resolve, reject) => {
  getAccount(username).then((accounts) => {
    // getAccount answers undefined, not an error, when every node failed.
    if (!Array.isArray(accounts)) {
      reject(appProfileError('lookup_failed', `Failed to load account @${username}`));
      return;
    }
    let metadata = {};
    if (accounts[0] && accounts[0].posting_json_metadata) {
      try {
        metadata = JSON.parse(accounts[0].posting_json_metadata);
        if (!metadata.profile || !metadata.profile.version) {
          metadata = {};
        }
      } catch (e) {
        console.error(new Date().toISOString(), `Error parsing account posting_json ${username}`, e); // error in parsing
        metadata = {};
      }
    }
    // otherwise, fall back to reading from `json_metadata`
    if (accounts[0] && accounts[0].json_metadata && (!metadata || !metadata.profile)) {
      try {
        metadata = JSON.parse(accounts[0].json_metadata);
      } catch (error) {
        console.error(new Date().toISOString(), `Error parsing account json ${username}`, error); // error in parsing
        metadata = {};
      }
    }
    if (metadata && metadata.profile && metadata.profile.type === 'app') {
      resolve(metadata.profile);
    } else {
      reject(appProfileError('not_app', `The account @${username} is not an application`));
    }
  }).catch((e) => {
    console.error(new Date().toISOString(), `Failed to load account @${username}`, e);
    reject(appProfileError('lookup_failed', `Failed to load account @${username}`));
  });
});

const b64uLookup = {
  '/': '_', _: '/', '+': '-', '-': '+', '=': '.', '.': '=',
};
export const b64ToB64u = (str) => str.replace(/(\+|\/|=)/g, (m) => b64uLookup[m]);
export const b64uToB64 = (str) => str.replace(/(-|_|\.)/g, (m) => b64uLookup[m]);
export const b64uEnc = (str) => Buffer.from(str).toString('base64').replace(/(\+|\/|=)/g, (m) => b64uLookup[m]);
export const b64uDec = (str) => Buffer.from(str.replace(/(-|_|\.)/g, (m) => b64uLookup[m]), 'base64').toString();
