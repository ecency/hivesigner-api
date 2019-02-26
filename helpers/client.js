const { Client, PrivateKey } = require('dsteem');

const client = new Client(process.env.STEEMD_URL || 'https://api.steemit.com');

client.customPrepareTx = (operations, wif) => new Promise((resolve, reject) => {
  const expireTime = 60 * 1000;
  const key = PrivateKey.fromString(wif);
  client.database.getDynamicGlobalProperties().then((props) => {
    const tx = {
      expiration: new Date(Date.now() + expireTime).toISOString().slice(0, -5),
      extensions: [],
      operations,
      ref_block_num: props.head_block_number & 0xFFFF,
      ref_block_prefix: Buffer.from(props.head_block_id, 'hex').readUInt32LE(4),
    };
    const signedTx = client.broadcast.sign(tx, key);
    resolve(signedTx);
    /**
     client.broadcast.send(signedTx).then(result => {
      resolve({ ...result, ...signedTx });
    }).catch(e => {
      reject(e);
    });
     */
  }).catch((e) => {
    reject(e);
  });
});

module.exports = client;
