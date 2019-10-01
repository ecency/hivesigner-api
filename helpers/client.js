const { Client } = require('dsteem');

const client = new Client(process.env.STEEMD_URL || 'https://api.steemit.com');

module.exports = client;
