const { Client } = require('dhive');

const client = new Client(process.env.STEEMD_URL || 'https://api.hive.blog');

module.exports = client;
