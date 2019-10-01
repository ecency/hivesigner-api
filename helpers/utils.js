/* eslint-disable prefer-promise-reject-errors */
const Promise = require('bluebird');
const { get, has } = require('lodash');
const client = require('./client');

const operationAuthor = {
  vote: 'voter',
  comment: 'author',
  delete_comment: 'author',
  custom_json: 'required_posting_auths[0]',
  comment_options: 'author',
  claim_reward_balance: 'account',
  account_update2: 'account',
};

/** Parse error message from Steemd response */
const getErrorMessage = (error) => {
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

const isOperationAuthor = (operation, query, username) => {
  if (Object.prototype.hasOwnProperty.call(operationAuthor, operation)) {
    const field = operationAuthor[operation];
    if (!field) { return false; }
    return get(query, field) === username;
  }
  return false;
};

const getAppProfile = (username) => new Promise((resolve, reject) => {
  client.database.getAccounts([username]).then((accounts) => {
    let metadata;
    try {
      metadata = JSON.parse(accounts[0].json_metadata);
      if (metadata.profile && metadata.profile.type && metadata.profile.type === 'app') {
        resolve(metadata.profile);
      } else {
        reject(`The account @${username} is not an application`);
      }
    } catch (e) {
      reject(`Failed to parse account @${username} "json_metadata"`);
    }
  }).catch((e) => {
    reject(`Failed to load account @${username}`, e);
  });
});

const b64uLookup = {
  '/': '_', _: '/', '+': '-', '-': '+', '=': '.', '.': '=',
};
const b64ToB64u = (str) => str.replace(/(\+|\/|=)/g, (m) => b64uLookup[m]);
const b64uToB64 = (str) => str.replace(/(-|_|\.)/g, (m) => b64uLookup[m]);
const b64uEnc = (str) => Buffer.from(str).toString('base64').replace(/(\+|\/|=)/g, (m) => b64uLookup[m]);
const b64uDec = (str) => Buffer.from(str.replace(/(-|_|\.)/g, (m) => b64uLookup[m]), 'base64').toString();

module.exports = {
  b64uEnc,
  b64uDec,
  b64uToB64,
  b64ToB64u,
  getErrorMessage,
  isOperationAuthor,
  getAppProfile,
};
