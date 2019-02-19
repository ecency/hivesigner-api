/* eslint-disable no-param-reassign,new-cap */
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const http = require('http');
const https = require('https');
const cors = require('cors');
const steem = require('@steemit/steem-js');
const db = require('./db/models');
const { strategy } = require('./helpers/middleware');

if (process.env.STEEMD_URL_SERVER) {
  steem.api.setOptions({ url: process.env.STEEMD_URL_SERVER });
} else if (process.env.STEEMD_URL) {
  steem.api.setOptions({ url: process.env.STEEMD_URL });
}

http.globalAgent.maxSockets = Infinity;
https.globalAgent.maxSockets = Infinity;
const app = express();
const server = http.Server(app);

// iframe header
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.enable('trust proxy');
app.disable('x-powered-by');

app.use((req, res, next) => {
  req.steem = steem;
  req.db = db;
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());

app.use(strategy);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', require('./routes/api'));
app.use('/api/oauth2', require('./routes/oauth2'));
app.use('/', require('./routes'));

// catch 404 and forward to error handler
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : err;

  // render the error page
  res.status(err.status || 500);
  res.json(err);
});

module.exports = { app, server };
