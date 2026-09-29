import { createHash } from 'crypto';
import {
  PublicKey, PrivateKey, Signature, Memo,
} from '@ecency/sdk/hive';
import { getAccount } from './client.js';
import { b64uEnc } from './utils.js';

export const decodeMemo = async(encodedMemo) => {
  const privateKey = PrivateKey.fromString(process.env.BROADCASTER_POSTING_WIF);
  let rr = "";
  try {
    rr = Memo.decode(privateKey, encodedMemo);
  } catch (error) {
    console.log('Failed to decode', encodedMemo);
    rr = ""
  }
  return rr;
}

const sha256 = (message) => createHash('sha256').update(message).digest();

export const issue = (app, author, type) => {
  const message = {
    signed_message: { type, app },
    authors: [author],
    timestamp: parseInt(new Date().getTime() / 1000, 10),
  };
  const hash = sha256(JSON.stringify(message));
  const privateKey = PrivateKey.fromString(process.env.BROADCASTER_POSTING_WIF);
  const signature = privateKey.sign(hash).toString();
  message.signatures = [signature];
  return b64uEnc(JSON.stringify(message));
};

// eslint-disable-next-line consistent-return
export const verify = (message, username, signature, cb) => {
  const hash = sha256(message);

  const broadcasterPrivKey = PrivateKey.fromString(process.env.BROADCASTER_POSTING_WIF);
  const broadcasterPubKey = broadcasterPrivKey.createPublic(process.env.BROADCASTER_NETWORK === 'mainnet' ? 'STM' : 'TST');
  if (broadcasterPubKey.verify(hash, Signature.from(signature))) {
    return cb(null, true);
  }

  getAccount(username).then((accounts) => {
    let signatureIsValid = false;
    if (accounts[0] && accounts[0].name) {
      ['posting', 'active', 'owner'].forEach((type) => {
        accounts[0][type].key_auths.forEach((key) => {
          if (
            !signatureIsValid
            && PublicKey.fromString(key[0]).verify(hash, Signature.from(signature))
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
