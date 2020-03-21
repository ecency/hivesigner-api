const steem = require('steem-js-patched');

if (process.env.STEEMD_URL) {
  steem.api.setOptions({ url: process.env.STEEMD_URL });
}

module.exports = steem;
