const {
  PublicKey,
  PrivateKey,
  cryptoUtils,
  Signature,
} = require('dsteem');
const client = require('./client');
const { b64uEnc } = require('./utils');

const issue = (app, author, type) => {
  const message = {
    signed_message: { type, app },
    authors: [author],
    timestamp: parseInt(new Date().getTime() / 1000, 10),
  };
  const hash = cryptoUtils.sha256(JSON.stringify(message));
  const privateKey = PrivateKey.fromString(process.env.BROADCASTER_POSTING_WIF);
  const signature = privateKey.sign(hash).toString();
  message.signatures = [signature];
  return b64uEnc(JSON.stringify(message));
};

// eslint-disable-next-line consistent-return
const verify = (message, username, signature, cb) => {
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
  issue,
  verify,
};
