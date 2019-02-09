const dsteem = require('dsteem');

module.exports = new dsteem.Client(process.env.STEEMD_URL || 'https://api.steemit.com');
