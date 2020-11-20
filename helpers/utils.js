/* eslint-disable prefer-promise-reject-errors */
import Promise from 'bluebird';
import { get, has } from 'lodash';
import client from './client';

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

export const getAppProfile = (username) => new Promise((resolve, reject) => {
  client.database.getAccounts([username]).then((accounts) => {
    let metadata;
    if (accounts[0] && accounts[0].posting_json_metadata) {
      try {
        metadata = JSON.parse(accounts[0].posting_json_metadata);
        if (!metadata.profile || !metadata.profile.version) {
          metadata = {};
        }
      } catch (e) {
        console.error(`Error parsing account posting_json ${username}`, e); // error in parsing
        metadata = {};
      }
    }
    // otherwise, fall back to reading from `json_metadata`
    if (accounts[0] && accounts[0].json_metadata && (!metadata || !metadata.profile)) {
      try {
        metadata = JSON.parse(accounts[0].json_metadata);
      } catch (error) {
        console.error(`Error parsing account json ${username}`, error); // error in parsing
        metadata = {};
      }
    }
    if (metadata.profile && metadata.profile.type && metadata.profile.type === 'app') {
      resolve(metadata.profile);
    } else {
      reject(`The account @${username} is not an application`);
    }
  }).catch((e) => {
    console.log(e);
    reject(`Failed to load account @${username}`, e);
  });
});

const b64uLookup = {
  '/': '_', _: '/', '+': '-', '-': '+', '=': '.', '.': '=',
};
export const b64ToB64u = (str) => str.replace(/(\+|\/|=)/g, (m) => b64uLookup[m]);
export const b64uToB64 = (str) => str.replace(/(-|_|\.)/g, (m) => b64uLookup[m]);
export const b64uEnc = (str) => Buffer.from(str).toString('base64').replace(/(\+|\/|=)/g, (m) => b64uLookup[m]);
export const b64uDec = (str) => Buffer.from(str.replace(/(-|_|\.)/g, (m) => b64uLookup[m]), 'base64').toString();
