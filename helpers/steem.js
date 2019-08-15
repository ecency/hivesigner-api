const steem = require('steem');

if (process.env.STEEMD_URL) {
  steem.api.setOptions({ url: process.env.STEEMD_URL });
}

module.exports = steem;
