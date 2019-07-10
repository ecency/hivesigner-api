require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const steem = require('steem');
const { strategy } = require('./helpers/middleware');

const app = express();
const port = process.env.PORT || 3000;

if (process.env.STEEMD_URL) {
  steem.api.setOptions({ url: process.env.STEEMD_URL });
}

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  req.steem = steem;
  next();
});

app.enable('trust proxy');
app.disable('x-powered-by');

app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ limit: '20mb', extended: false }));
app.use(cors());
app.use(strategy);
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', require('./routes/api'));
app.use('/api/oauth2', require('./routes/oauth2'));

// eslint-disable-next-line consistent-return
app.get('/oauth2/authorize', (req, res) => {
  if (!req.query.scope || !req.query.scope.includes('offline')) return res.redirect(`https://beta.steemconnect.com${req.url}`);
  res.redirect(`https://app.steemconnect.com${req.url}`);
});

// eslint-disable-next-line consistent-return
app.get('/*', (req, res) => {
  if (req.url === '/') return res.redirect('https://beta.steemconnect.com');
  res.redirect(`https://app.steemconnect.com${req.url}`);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
