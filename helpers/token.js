const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  PublicKey,
  PrivateKey,
  cryptoUtils,
  Signature,
} = require('dsteem');
const client = require('./client');
const db = require('./db');
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
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiration = parseInt(new Date().getTime() / 1000, 10) + config.token_expiration;
    const mysqlToken = {
      token_hash: tokenHash,
      client_id: proxy,
      username: user,
      expiration,
    };
    await db.queryAsync('REPLACE INTO token SET ?', mysqlToken);
    await db.queryAsync('DELETE FROM token WHERE expiration < ?', parseInt(new Date().getTime() / 1000, 10));

    console.log(`A token for user @${user} with ${proxy} as proxy has been saved on database.`);
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

// eslint-disable-next-line consistent-return
const verifySignature = (message, username, signature, cb) => {
  const hash = cryptoUtils.sha256(message);

  const broadcasterPrivKey = PrivateKey.fromString(process.env.BROADCASTER_POSTING_WIF);
  const broadcasterPubKey = broadcasterPrivKey.createPublic();
  if (broadcasterPubKey.verify(hash, Signature.fromString(signature))) {
    return cb(null, true);
  }

  client.database.getAccounts([username]).then((accounts) => {
    let signatureIsValid = false;
    if (accounts[0] && accounts[0].name) {
      ['posting', 'active', 'owner'].forEach((type) => {
        accounts[0][type].key_auths.forEach((key) => {
          if (
            !signatureIsValid
            && PublicKey.fromString(key[0]).verify(hash, Signature.fromString(signature))
          ) {
            signatureIsValid = true;
          }
        });
      });
      cb(null, signatureIsValid);
    } else {
      cb('Request failed', null);
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
