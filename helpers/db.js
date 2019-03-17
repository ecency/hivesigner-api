const mysql = require('mysql');
const Pool = require('mysql/lib/Pool');
const Connection = require('mysql/lib/Connection');
const Promise = require('bluebird');
const parse = require('connection-string');

const config = parse(process.env.MYSQL_DATABASE_URL);
config.connectionLimit = 5;
config.multipleStatements = true;
config.database = config.path[0];
config.host = config.hosts[0].name;

Promise.promisifyAll([Pool, Connection]);

const db = mysql.createPool(config);

module.exports = db;
