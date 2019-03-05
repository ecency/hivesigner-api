const jwt = require('jsonwebtoken');
const debug = require('debug')('sc2:server');
const { PublicKey, cryptoUtils, Signature } = require('dsteem');
const client = require('./client');
const { tokens } = require('../db/models');
const config = require('../config.json');

/** Create a new access token for user */
const issueUserToken = user => (
  jwt.sign(
    { role: 'user', user },
    process.env.JWT_SECRET,
  )
);

/** Create a new access token for application and store it on the database */
const issueAppToken = async (proxy, user, scope = []) => {
  const token = jwt.sign(
    {
      role: 'app', proxy, user, scope,
    },
    process.env.JWT_SECRET,
    { expiresIn: config.token_expiration },
  );

  try {
    await tokens.create({ client_id: proxy, user, token });
    debug(`A token for user @${user} with ${proxy} as proxy has been saved on database.`);
  } catch (error) {
    throw new Error(error);
  }

  return token;
};

/**
 * Create an authorization code for application. It can be exchanged to an
 * access_token or refresh_token. Authorization code expire in 10 min.
 */
const issueAppCode = (proxy, user, scope = []) => (
  jwt.sign(
    {
      role: 'code', proxy, user, scope,
    },
    process.env.JWT_SECRET,
    { expiresIn: 600 },
  )
);

/**
 * Create a refresh token for application, it can be used to obtain a renewed
 * access token. Refresh tokens never expire
 */
const issueAppRefreshToken = (proxy, user, scope = []) => (
  jwt.sign(
    {
      role: 'refresh', proxy, user, scope,
    },
    process.env.JWT_SECRET,
  )
);

const verifySignature = (message, username, signature, cb) => {
  client.database.getAccounts([username]).then((accounts) => {
    if (accounts[0] && accounts[0].name) {
      const hash = cryptoUtils.sha256(message);
      let signatureIsValid = false;
      ['owner', 'active', 'posting'].forEach((type) => {
        accounts[0][type].key_auths.forEach((key) => {
          if (PublicKey.fromString(key[0]).verify(hash, Signature.fromString(signature))) {
            signatureIsValid = true;
          }
        });
      });
      cb(null, signatureIsValid);
    }
  }).catch((e) => {
    console.log('Get accounts failed', e);
    cb(e, null);
  });
};

module.exports = {
  issueUserToken,
  issueAppToken,
  issueAppCode,
  issueAppRefreshToken,
  verifySignature,
};
